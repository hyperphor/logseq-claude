# Spec

- Command to turn a Logseq page into a spec that is then processed by claude code
- optionally specify an existing project (repo).

## /PushClaudeCode

### What it does, step by step

1. User invokes `/PushClaudeCode` from any block on a page (like the other slash
   commands, it operates on "the page the current block lives on").
2. The plugin fetches the whole page via `logseq.Editor.getPage` +
   `logseq.Editor.getPageBlocksTree` — not just the ancestor chain of the
   current block, the *entire* page. A spec needs everything, not the partial
   context the other `/Ask Claude` commands use.
3. The block tree is rendered into a single clean markdown document (the
   "spec"):
   - `# <page title>` as the heading.
   - The page's own properties block (the `key:: value` block Logseq stores
     as the page's first/pre-block) is stripped out — it's Logseq metadata,
     not spec content.
   - Every other block is rendered as a nested markdown list item, indented
     two spaces per level, preserving the outline structure of the page.
     (This is the reverse of `markdownToBlocks` — blocks-to-markdown instead
     of markdown-to-blocks — and is new code, not a reuse of `buildPrompt`,
     because `buildPrompt('page', …)` intentionally truncates at the
     invoking block and flattens the tree; a spec needs the whole page and
     its structure.)
4. If a target project was resolved (see below), a one-line
   `_Target project: <value>_` note is added under the title so the pasted
   spec carries that context along with it.
5. "Processed by claude code" — see **Critical constraint** below. As of
   this implementation, that means: the assembled spec is copied to the
   system clipboard, and the user is told (via a toast) to open a terminal
   in the target project and run `claude`, then paste. The plugin does not
   invoke the `claude` CLI itself. If clipboard access fails, the plugin
   falls back to inserting the spec as a single fenced code block under the
   invoking block, so it's still one click away from being copied.

### Critical constraint: no process/file-system access from the plugin sandbox

This needed to be verified rather than assumed, because a Logseq plugin does
**not** run with the same privileges as, say, an Electron main-process
script. Findings, based on the official plugin API docs
(`https://plugins-doc.logseq.com/`, `https://logseq.github.io/plugins/`) and
Logseq community discussion (`discuss.logseq.com`, `logseq/logseq` GitHub
issues):

- Logseq plugins load in a sandboxed iframe and talk to the host app only
  through a mediated `logseq.*` API surface (IPC bridge). There is no
  `require('child_process')`, `fetch`-to-localhost-exec, or similar — people
  have tried (`require('child_process').exec`, `shelljs`) and reported it
  simply doesn't work in this context.
- The *only* subprocess-shaped capability documented anywhere in the API is
  `logseq.App.execGitCommand` (`(args: string[]) => Promise<string>`,
  deprecated in favor of `logseq.Git.execCommand`) — and it is scoped
  specifically to running `git` with a fixed argument list against the
  current graph's repo (via the `dugite` library). This is a narrow,
  allowlisted exception, not a general subprocess API, and it cannot run an
  arbitrary CLI like `claude`.
- `logseq.App.invokeExternalCommand` sounds promising but only re-invokes
  *other registered Logseq palette/slash commands* (the same Ctrl+Shift+P
  style command list) — it cannot launch an external OS process either.
- `logseq.App.openExternalLink` opens a URL in the OS default handler
  (e.g. a browser or `mailto:` link) — not useful for invoking a CLI with
  stdin.
- File access is similarly scoped: `logseq.FileStorage` and `logseq.Assets`
  read/write inside the plugin's own sandboxed storage directory
  (`.logseq/storages/<plugin-id>/…`) or the graph's `assets/` folder — not
  arbitrary paths on disk, and not a place `claude` (run from an unrelated
  project directory) would look for input.
- "Support arbitrary external command execution from a plugin" and "support
  executing subprocesses" are open, unresolved feature requests on
  `discuss.logseq.com` and in `logseq/logseq` issues as of this writing —
  i.e. this is a deliberate gap in the API, not something this doc failed
  to find.

**Conclusion: there is no verified mechanism for a Logseq plugin to shell
out to the `claude` CLI, or to write a file to an arbitrary path outside
Logseq's own graph/plugin storage.** This design does not assume otherwise.
If a future Logseq API version adds real subprocess or filesystem access,
this doc and the implementation should be revisited — but nothing here
should be read as claiming that access exists today.

Given that, "processed by claude code" is implemented as a **handoff**, not
an invocation: get the spec onto the clipboard, tell the user exactly what
to run and where. This is honest about the boundary — it is copy assist,
not automation of Claude Code itself.

One more thing worth flagging from research: `navigator.clipboard.writeText`
called directly from plugin code has been reported (in a
`discuss.logseq.com` thread, not official docs) to silently fail because
the plugin iframe isn't the focused/permitted context for the Clipboard
API; the suggested workaround is calling `parent.navigator.clipboard`
instead (i.e. the host window's clipboard, which does have permission).
The implementation tries both, in that order, and only falls back to the
in-page code-block if both throw. This is based on a single community
report, not something this implementation could directly verify without a
running Logseq instance — treat the clipboard path as best-effort.

### Settings / config

- `defaultProjectPath` (new plugin setting, string, optional): a path or
  name the user associates with "the project I'm usually pushing specs
  to" — e.g. `/Users/me/code/my-repo` or just a label like `my-repo`. This
  is **purely informational**: the plugin cannot `cd` into it or run
  anything there. It's used only to (a) show up in the toast message
  ("run `claude` in `<path>`") and (b) get embedded as a `_Target
  project: …_` line in the spec, as a hint for whoever/whatever reads the
  spec next. It is not validated, resolved, or acted on in any way.
- Page property `project:: <value>` (no new setting — just a convention
  read from the page): if the page being pushed has a `project::` property
  in its properties block, that value overrides `defaultProjectPath` for
  that page's spec. This lets different pages target different repos
  without changing global settings.
- No new settings are needed for the clipboard/fallback behavior — it just
  runs.

### Open questions / limitations

- **No verified way to actually launch `claude` or write into a target
  repo.** This is the core limitation described above. Anything beyond
  "clipboard + instructions" would require either (a) a future Logseq
  plugin API capability that doesn't currently exist, or (b) an
  out-of-plugin companion process (e.g. a small local HTTP server or watch
  script the user runs separately, which the plugin could `fetch()` to —
  untested, undesigned, and out of scope here) that bridges the browser
  sandbox to the local filesystem/shell. Not implemented.
- **Clipboard reliability is unverified in a live Logseq instance.** The
  `parent.navigator.clipboard` workaround comes from a single community
  report; this implementation could not be run inside actual Logseq to
  confirm it. The in-block fallback exists specifically to make the
  feature usable even if clipboard access is flaky or blocked entirely by
  the OS/Electron's permission model.
- **No page-size guarding.** Very large pages produce very large spec
  strings; there's no truncation, chunking, or warning if the assembled
  spec is huge. Left as a known gap.
- **No structured spec template.** The spec is "the page, rendered as
  markdown, roughly as-is." It doesn't inject a fixed template (e.g.
  "## Goal / ## Constraints / ## Acceptance criteria") the way some spec
  generators do — it trusts the page's own outline. Could be revisited if
  a more opinionated spec format turns out to be more useful to Claude
  Code as an input.
- **`project::` value isn't validated as a real path.** It's taken
  verbatim from the page property; nothing checks it exists, is a git
  repo, etc. (Consistent with `defaultProjectPath` also being unvalidated
  — the plugin has no way to check a local path even if it wanted to.)
- **No "processed by claude code" feedback loop.** Once the spec is
  copied, the plugin has no idea what happened next — there's no way for
  it to receive Claude Code's output back into the page. This is a direct
  consequence of the same sandbox constraint: nothing can call back into
  the plugin from an external process.
