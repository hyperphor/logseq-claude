# Spec: Voice → Logseq

Two originally-lumped ideas, evaluated separately below. See "Open question" at the
bottom for whether either belongs in this plugin at all.

## 1. `/VoiceInput` — decision: do not build

The spec author's own hunch was "this should already work." Research confirms that,
but not in the way a plugin would provide it, and the plugin-shaped version of it is
independently broken. Three separate findings, all pointing the same direction:

1. **OS-level dictation already covers this, with no plugin needed.** Every Logseq
   block is a plain contenteditable/textarea. macOS dictation (Fn Fn or the mic key),
   Windows dictation (Win+H), and mobile keyboard mics all inject text into whatever
   field has focus — including a Logseq block being edited. This works today, for
   every user, with zero plugin code. That's the sense in which "this should already
   work" is correct.

2. **A JS-level implementation would use the browser `SpeechRecognition`
   (`webkitSpeechRecognition`) API — and that API is broken inside Logseq's desktop
   shell.** Logseq desktop runs on Electron. `webkitSpeechRecognition` phones home to
   Google's proprietary recognition backend, and that request reliably fails with a
   `network` error inside Electron's networking stack — a long-standing, still-open
   upstream Electron bug (see electron/electron#46143 and older duplicates going back
   years), unrelated to internet connectivity or to anything a plugin author can fix
   from plugin JS. It is not a matter of writing the wrapper more carefully; the
   underlying browser API does not function in this host.

3. **This repo already tried it and confirmed it's broken.** Branch `voice`
   (commit `872fe61`, "first cut at voice, not working") contains exactly this: a
   `Voice Input` slash command wrapping `webkitSpeechRecognition`, committed with a
   `// TODO Not working, fix or remove` comment. That failure is consistent with
   finding (2) — it's not a bug in that implementation, it's the API not working in
   this host.

**Conclusion:** don't build `/VoiceInput`. It would duplicate a capability the OS
already provides for free, and the one way a plugin *could* add value (wrapping
browser speech recognition into block-insertion) is built on an API that doesn't
function inside Logseq's own runtime. No command is registered for this in
`index.js`; the `voice` branch's abandoned attempt is left as-is and not merged.

**If this ever becomes worth revisiting:** the only path that would actually work is
piping recorded audio to a real speech-to-text service (e.g. OpenAI Whisper, or
Anthropic's own future audio support if it ships) rather than the browser's built-in
recognizer. Note that the Anthropic Messages API used elsewhere in this plugin
(`askClaude()`) is text-only today — it cannot transcribe audio, so this is a
materially different (and materially bigger) feature: capture audio, upload it
somewhere, get text back. Out of scope here; flagging only so a future author doesn't
assume `askClaude()` can be reused for it.

## 2. `/PullGoogleVoice` → renamed to `/Import Google Voice`

Renamed for consistency with the other commands' naming style (`Ask Claude (page)`,
`Claude: Summarize`, etc. — plain title-case, no camelCase run-together verb).

### Does an API exist? No.

Confirmed via search: Google Voice has never published a public API for third-party
access to call/SMS/voicemail data, and Google has not indicated plans to add one.
The only Google-official bulk-export mechanism is **Google Takeout**
(takeout.google.com), which packages a user's Voice data as a downloadable archive.
Any "Google Voice API" wrapper found online is either an unofficial scrape (violates
Google's terms, fragile, out of scope) or a *different* product (Google's Cloud
Speech-to-Text API, or telephony platforms like Twilio — not Google Voice itself).

**Design decision:** build against a local Google Takeout export directory, not a
live API. This is the only realistic option.

### Takeout export layout (Voice component)

When a user exports the "Voice" product from Takeout, the unzipped archive contains
(paths relative to the Takeout root; exact top folder name varies by Takeout version,
typically `Takeout/Voice/`):

```
Takeout/Voice/
  Calls/
    <Contact Name> - Voicemail - YYYY-MM-DDTHH_MM_SSZ.html   # transcript, metadata
    <Contact Name> - Voicemail - YYYY-MM-DDTHH_MM_SSZ.mp3    # audio, same basename
    <Contact Name> - Text - YYYY-MM-DDTHH_MM_SSZ.html        # SMS thread, if included
    <Contact Name> - Received - YYYY-MM-DDTHH_MM_SSZ.mp3     # recorded call, if any
  Voicemails/                                                 # older exports use this
    ...same pairing pattern...
  Greetings/
    <n>.mp3
  Text/
    ...
  billing.html
  phones.vcf
```

Key points for parsing:

- Each recording is a **pair of files sharing a basename**: an `.html` file (Google's
  own transcript + timestamp + caller metadata, in microformat markup) and an `.mp3`
  (the actual audio). Not every voicemail has a usable transcript (Google's ASR
  sometimes leaves it blank) — the importer must tolerate an empty transcript and
  still surface the audio file.
- The timestamp is UTC, embedded in the filename (`YYYY-MM-DDTHH_MM_SSZ`) and also
  as a machine-readable `<abbr class="published" title="...">` tag inside the HTML.
  The filename is sufficient for date-matching and avoids needing an HTML parser for
  that step; the HTML is only needed to pull the transcript text out.
- Folder naming (`Calls/` vs `Voicemails/`) has changed across Takeout format
  revisions — the importer should scan for both and treat whichever exists as the
  source directory.

### Deriving the target date from the journal page

The command is invoked from a block on a journal page. Logseq's `PageEntity` for a
journal page carries a `journalDay` field: an integer in `YYYYMMDD` form (e.g.
`20260719` for the "Jul 19th, 2026" page). This is the primary, unambiguous way to
get the date — no string-parsing of the human-readable page title needed.

```js
const page = await logseq.Editor.getPage(block.page.id);
// page.journalDay -> 20260719 (number), when page.journal? === true
```

Caveat: this repo's research didn't include a live Logseq instance to confirm
`journalDay`'s exact shape against the currently running version, so the
implementation **also** falls back to parsing the page name (`"Jul 19th, 2026"`
style, or a plain `YYYY-MM-DD` for users on that date-format setting) if
`journalDay` is missing or the block isn't on a journal page at all. If neither
resolves, the command aborts with a clear error rather than guessing.

### What gets inserted

For each recording whose filename date matches the resolved journal date:

- One child block per recording, containing:
  - The transcript text (from the paired `.html`), if present, or a placeholder like
    `(no transcript captured)` if Google's ASR left it blank.
  - A markdown link to the local `.mp3` file — `[Voicemail audio](file:///...)` —
    since the plugin cannot embed or upload the audio itself. Whether to include the
    audio link is a per-run choice (see `googleVoiceIncludeAudioLink` setting below);
    default is on, per the spec author's "optionally the voice as well I suppose.
    Actually yes."
  - Caller name and timestamp as a prefix line, since the transcript alone loses
    that context once out of the Takeout HTML.
- If zero recordings match the date, insert nothing and show a toast
  (`No Google Voice recordings found for <date>`) rather than silently no-op'ing.

### New setting: `googleVoiceExportPath`

Records the local filesystem path to the root of an unzipped Takeout export (the
folder containing `Voice/`). This setting is straightforward to add to
`settingsSchema` and is genuinely useful as configuration regardless of the gap
below — it's *where the data lives*; the open problem is *how the plugin reads it*.

### Known gap: plugin sandbox file access is unverified

Logseq plugins run in an embedded webview/iframe context, not a Node.js process with
unrestricted `fs` access. There is no documented Logseq plugin API for "read this
absolute path from disk" the way `askClaude()` reads `logseq.settings`. The two
browser-native mechanisms that could plausibly do it are:

- `window.showDirectoryPicker()` (File System Access API) — requires a user gesture
  and, in Chromium, a picker dialog; a granted handle can be persisted (e.g. via
  IndexedDB) to avoid re-prompting every run, but this needs to be confirmed against
  Logseq's actual plugin iframe/CSP setup, which this research could not do without a
  running Logseq instance.
- A hidden `<input type="file" webkitdirectory>` — always available, but forces a
  manual folder pick on every invocation unless the plugin also builds a picker UI
  (`logseq.showMainUI`) and caches the result, which is a nontrivial addition to this
  plugin's current "no popups, just insert blocks" style.

Given the instruction not to fake working functionality, **this implementation stops
at the boundary**: date resolution, settings, matching/filtering logic, transcript
parsing, and the block-insertion shape are implemented for real. The actual
`readdir`/`readFile` calls are marked with an explicit `// GAP:` comment and the
command reports "not yet wired to local files" via `logseq.UI.showMsg` instead of
pretending to have found (or not found) recordings. Whoever picks this up next should
verify file-access options against a real Logseq install before completing the read
path.

### New setting: `googleVoiceIncludeAudioLink`

`type: 'boolean'`, default `true` (Logseq's `settingsSchema` supports a boolean
type even though this plugin's existing settings all happen to be strings).
Controls whether the `.mp3` link is included alongside the transcript, per the
design above.

## 3. Open question for the maintainer: does this belong in this plugin?

The spec author flagged this up front and it's still true after fleshing the spec
out: everything else in this plugin is "take block content, send to the Claude API,
insert the response." Google Voice ingestion has nothing to do with Claude — it's a
local-file-import feature that happens to target the same journal-page/block-insertion
surface. The only shared code would be `markdownToBlocks`-style block insertion, not
`askClaude()` itself (no LLM call is required to reproduce Google's own transcript,
though one could optionally be added later to clean up ASR artifacts).

This doc does not resolve that question. Options, left for the maintainer:

- Keep it here, since it's small and journal-centric like the rest of the plugin.
- Split it into a separate plugin (e.g. `logseq-google-voice`) with its own
  manifest/settings, keeping `logseq-claude` scoped to "block content → Claude."
- Drop `/VoiceInput` entirely (per §1) and decide `/Import Google Voice`'s home
  independently — the two commands don't need to share a fate just because they
  arrived in the same spec file.
