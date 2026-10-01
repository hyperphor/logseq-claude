# Publishing to the Logseq Marketplace

Research note for the `TODO publish` item. TL;DR: **this was already done** — see
"Current status" below — the open question now is whether to push it to completion,
not whether to start.

## What the marketplace actually requires

Source: `logseq/marketplace` README and `.github/pull_request_template.md` (read from
the local clone at `/opt/mt/repos/logseq-marketplace`, not modified).

1. **A `packages/<plugin-id>/manifest.json`** in a fork of `logseq/marketplace`, with
   fields: `title`, `description`, `author`, `repo` (`{owner}/{repo}`), and optionally
   `icon`, `theme`, `sponsors`, `web`, `effect`, `supportsDB`, `supportsDBOnly`. There
   is no `id` field in this manifest — the package *directory name* is the id.
2. **A "legal" `package.json`** in the plugin repo itself, under a `logseq` key:
   `id`, `title`, `icon` (optional but expected), plus normal npm fields
   (`author`, `description`, `repository`, `license`).
3. **A CI workflow** (`.github/workflows/publish.yml`, triggered on tag push) that
   builds a distributable zip and attaches it to a GitHub Release.
4. **A GitHub Release** (from a tag) with that zip attached — the marketplace
   installs from the release asset, not from `main`.
5. **A clear README**, ideally in English, and — per the marketplace's own
   pre-submission checklist ("Ensure the following are true before submitting") —
   **at least one screenshot or gif showing the plugin in action**. This reads as a
   hard requirement, not a suggestion, despite the PR template softening it to
   "ideally."
6. **A `LICENSE` file.**
7. Submission is via PR: fork `logseq/marketplace`, add the manifest, open a PR
   using `.github/pull_request_template.md`, which has its own checklist.

Cross-referenced manifest shape against a few existing simple plugins in the
marketplace (`packages/logseq-dev-theme`, `packages/logseq-ai-assistant`,
`packages/logseq-ai-journal`, `packages/fuzzy-search`) — all match the field list
above; none set `id` in `manifest.json`.

## Current status — this already happened

This is the important finding: **the plugin has already been submitted.**

- The user's own fork, `hyperphor/logseq-marketplace` (local clone at
  `/opt/mt/repos/logseq-marketplace`), already has `packages/logseq-claude/manifest.json`
  committed and pushed (commit `e7d6d7d`, "add logseq-claude", 2026-04-06).
- **PR [logseq/marketplace#757](https://github.com/logseq/marketplace/pull/757)**
  ("add logseq-claude"), opened by `mtravers` on 2026-04-07, is **still open**, with
  no reviews and no comments as of this writing (2026-08-31) — roughly 4.5 months
  with no maintainer response. This appears to be normal for this repo: recent merged
  PRs in the same queue (#845, #846, #861, #862) took weeks to months to land.
- The PR's own checklist has two boxes unchecked: "clear README … image or gif
  showcase" and "license in LICENSE file." The LICENSE box is a false negative — the
  file was added in commit `44a15ea`, ~30 minutes before the PR was opened — just
  never ticked in the PR body. The README/screenshot box is a real, still-open gap.
- **The attached release is stale.** The PR points at `hyperphor/logseq-claude`,
  whose latest tagged release is `v0.1.1` (2026-04-07). `main` is now 13 commits
  ahead of that tag, including the web-access/URL-fetching feature, the
  Summarize/Improve Writing/Explain slash commands, `responseTag`, and the system
  prompt setting — none of which are in the release a marketplace user would
  actually install. If a maintainer merged the PR today, users would get the
  April snapshot, not the current plugin.

## What was fixed here (this repo, this branch)

Gaps were minimal because most of the marketplace's requirements were already
satisfied before this task started (`package.json`'s `logseq` block already has
`id`/`title`/`icon`/`repo`; `publish.yml` and a tagged release already exist;
`LICENSE` already exists). The one concrete gap addressed:

- Added an HTML-comment TODO marker in `README.md` flagging that a screenshot/gif
  is still needed before (re-)submission, pointing back to this doc. No screenshot
  was fabricated — inserting a placeholder image reference would just render as a
  broken image, which is worse than the current state.

Nothing was changed in `package.json`: the `logseq` block already covers everything
the marketplace manifest needs, and `supportsDB`/`supportsDBOnly`/`effect` shouldn't
be guessed — see below.

## Remaining steps for a human to actually get this merged

None of these were done here — they require judgment calls, live testing, or
touching the `logseq-marketplace`/`logseq/marketplace` repos, which were explicitly
out of scope for this task:

1. **Cut a fresh release.** Bump `package.json`'s `version`, tag it (`vX.Y.Z`), push
   the tag — `publish.yml` will build and attach a current zip. This is the single
   most important step; the open PR is pointless to pursue until the release it
   references reflects the current feature set.
2. **Add the demo screenshot/gif** to the README (record a slash command in use).
3. **Decide `supportsDB` / `supportsDBOnly`** by actually testing the plugin against
   a Logseq DB-graph, then update `packages/logseq-claude/manifest.json` in the fork
   accordingly (don't set `effect` or the DB flags speculatively).
4. **Push the updated manifest/checklist state** to `hyperphor/logseq-marketplace`
   master (PR #757 will pick up new commits automatically since it's already open
   against that branch) — or close and re-open cleanly if that's preferred.
5. Optionally tick the LICENSE checkbox in the existing PR body and/or leave a
   comment nudging for review, given how long it's been open.

## Is this worth pursuing? (the TODO's own question)

Honest answer: marginal, and the user already made this call once (by opening the
PR in April) — the real decision now is whether to *finish* it, not whether to
*start*.

Arguments for finishing it:
- Almost all the mechanical work is done: fork, manifest, CI, release, license.
  Getting to "mergeable" is a small, bounded amount of remaining work (steps 1–2
  above), not a redesign.

Arguments against investing more right now:
- The plugin's own `TODO.md` lists open problems that matter more to real users
  than marketplace distribution: no conversation/multi-turn support ("just
  annoying to use, inferior to just using Claude and pasting"), and a "bad bug on
  first use" where it apparently doesn't pick up the whole block for the prompt.
  Shipping a known first-use bug to a wider marketplace audience is a worse look
  than the plugin not being listed yet.
- The AI-assistant space in the marketplace is already crowded (`logseq-ai-assistant`,
  `logseq-ai-auto-tags`, `logseq-ai-journal`, `logseq-ai-query-generator`,
  `logseq-aisearch`, `logseq-ask-pdf`, etc.) — being listed doesn't guarantee
  discovery or use, so the payoff for closing the gap is modest.
- Review latency in this queue is measured in months, so there's no urgency; nothing
  is lost by fixing the first-use bug and adding conversation support first, then
  cutting a release, before spending more effort on the listing itself.

Recommendation: fix the known first-use bug before doing anything else with the PR.
Then cut a fresh release and add the screenshot — at that point finishing the
submission is cheap and worth doing. Don't prioritize the marketplace listing over
the functional bug.
