# Pagents

Pagents are agents with a page: a prompt, a schedule, its state (last
run, log, accumulated output) and its results all live together in one
editable Logseq/markdown page.

# Is there anything truly interesting about this?

Yes, one thing: **the page is the agent.** A cron job or a hosted agent
platform hides its prompt, schedule and run history behind a UI or a
config file you don\'t read. A pagent\'s entire definition and history
is a page --- human-editable, diffable, forkable, in git, and (via
goddinpotty) publishable. Debugging a pagent means reading a page, not
tailing a log somewhere else. That legibility is the whole bet; if the
implementation ever makes the page just a trigger for logic that lives
elsewhere, the bet is lost.

Checked the marketplace and AMMDI for prior art --- see below. Nothing
does this today, so it\'s worth building, but keep it small.

# Name

`pagents.ai` is taken as a domain, not as a project name --- no other
project called \"pagent\" turned up in a marketplace/AMMDI search. Keep
\"pagent\" as the working name; revisit only if it\'s ever
public-facing.

# Scope decision: the ghetto version

Build inside `logseq-claude`, not a new system. No build step, no graph
DB, no new backend service for v1. Extend `index.js` --- it already has
the pieces: `registerSlashCommand`, `getCurrentBlock`, `buildPrompt`,
`askClaude`, `markdownToBlocks` / `insertBatchBlock`.
 
Data layer: plain markdown + Logseq page properties (`schedule::`,
`agent::`, `last-run::`) is enough. No typed-link graph, no DB sync ---
matches the gut call in the original notes. Revisit only if querying
across many pagents (e.g. \"show me every pagent that failed this
week\") turns out to need more than a Logseq query.

# The core constraint

A Logseq plugin is JS running in the Logseq Electron renderer. It only
runs while Logseq is open, and a slash command only fires when a human
invokes it. **There is no background process inside the plugin.**
`/Agent` cannot, by itself, \"put a task on a run engine\" --- there is
no engine running once the human closes Logseq or moves to another
block.

This is the same wall `exobrain` hit:
`exobrain/src/clj/exobrain/agents.clj` schedules daily/weekly tasks with
a bare `java.util.Timer`, with its own comment on the file: *\"Yes there
should be a more general mechanism\... Or should outsource this all to
crontab or something.\"* Don\'t rebuild that mistake here --- go
straight to outsourcing it.

`noodge` (\"a general framework for background tasks\... Agents!\") is
the right shaped prior art but is an empty stub
(`noodge/src/noodge/core.clj` is unfinished) --- reviving it means
writing it, not reusing it. Not worth it for v1; a shell script +
`launchd` does the same job with less code.

# Architecture

## Pagent page format

A page (namespaced, e.g. `pagents/tweet-news`) with properties and body:

    agent:: true
    schedule:: daily
    capabilities:: web, twitter-post
    last-run:: 2026-08-22T09:00:00Z

    - Check hacker news and my RSS feeds for the top 3 AI news stories today.
      Post a short summary thread to Twitter. Keep the tone dry, no hype.
    - ## Log
        - 2026-08-22: posted 3 items, thread here: [[...]]

The body above `## Log` is the prompt. `## Log` (or a `state::` child
block) is where runs append results --- this is the pagent\'s persistent
state, same role as `last-run::` but human-readable.

## Two execution tiers

**In-plugin, immediate --- `/Run`.** No scheduling, just \"do it now.\"
`registerSlashCommand` takes no argument (flagged as hard in
`spec/claude-code.md`), so don\'t parameterize the command: read the
invoking block\'s content and parse the `[[page name]]` reference out of
it, the same way `buildPrompt`\'s ancestor-walk already reads block
content (`index.js:104-137`). Fetch that page, run its prompt through
`askClaude`, insert the result via `askBlock`\'s existing pipeline
(`markdownToBlocks` → `insertBatchBlock`). This is a small addition to
`index.js`, no new infrastructure.

**External, scheduled --- `/Agentify`.** Turns the current page into a
pagent by writing `agent:: true` and a `schedule::` property (ask the
user for a schedule, or default to `daily`). The actual execution is
*not* done by the plugin --- it\'s done by a small external daemon: 
Actually, copy the template (PAgents/Template), eventually might be a choice of templates

- A `launchd` job (macOS) on a fixed interval (e.g. every 15 min).
- It reads the graph\'s markdown directly, greps for `agent:: true`
  pages, and checks each one\'s `schedule::` against `last-run::` to see
  what\'s due.
- For each due pagent, it runs `claude -p` headless with the page\'s
  prompt. This is strictly more capable than the in-browser plugin: a
  headless `claude -p` process has real tool access (Bash, WebFetch,
  etc.), not just a bare `fetch()` to the Messages API --- so \"post to
  Twitter\" or \"check RSS feeds\" are just tools the pagent\'s Claude
  invocation can call, no bespoke integration code per pagent.
- It writes the result and a new `last-run::` back into the page.

Write-back path, in order of preference:

1.  **Logseq\'s local HTTP APIs server** (Settings → Features → HTTP
    APIs server → generate token) --- writes go through Logseq\'s own
    API, safe even while the graph is open in the app. **Not currently
    enabled on this machine** --- turning it on is a setup prerequisite,
    not yet done.
2.  **Fallback: write the markdown file directly.** Real risk of
    clobbering an edit in progress if the page happens to be open in
    Logseq at that moment. Mitigate by only ever appending a child block
    under `## Log` (never touching existing content) and running on a
    slow cadence. Treat as acceptable for a single-user personal tool,
    not as a real answer --- revisit if this ever needs to be robust.

An in-plugin `setInterval` \"runs while Logseq happens to be open\" tier
could be added later as a cheap approximation, but should be labeled as
exactly that in the UI/docs --- not a real scheduler, same caveat
`exobrain`\'s own Timer-based agents carry.

## Containment

A pagent page is user-authored text that gets executed with real
capabilities (network, posting, shell). That\'s a
code-execution-from-a-notes surface, not just a note. Concretely:

- `capabilities::` property is an explicit allowlist per pagent (e.g.
  `web, twitter-post`) --- the daemon should refuse to grant a headless
  run any tool outside that list.
- Secrets (API keys, Twitter creds) live in the daemon\'s environment /
  keychain, never on the page. The page can reference a credential by
  name, never by value.
- This is the \"state, containment\" vocabulary from the dissertation
  (agency as goal-directed + bounded action) --- worth keeping explicit
  here rather than letting every pagent get ambient access to
  everything.

## Web UI

Not needed for v1. Pagent pages are ordinary Logseq pages, so
goddinpotty\'s existing entrance/exit-point privacy scheme already
covers \"publish this pagent\'s page and its log, keep others private\"
with zero new work. Defer a dedicated real-time UI until there\'s a
concrete reason the page view isn\'t enough.

# Does this already exist?

Checked `logseq-marketplace` (486 plugins) and AMMDI locally.

- **Reminder** (`logseq-plugin-reminder`) does `SCHEDULED`/`DEADLINE`
  system notifications --- closest by name, but it\'s a notification,
  not an execution engine. No prompt, no action.
- **Doc Agent** --- an in-app chat assistant, not scheduled/autonomous.
- **Local Telegram Bot** / **Inbox Telegram** ---
  external-process-talks-to- the-graph pattern, same shape as the daemon
  proposed above, but for message ingestion, not scheduled execution.
- Nothing found that combines: a page as prompt, a schedule, and
  autonomous execution with write-back. Confirms this is worth building
  small rather than adopting something.
- AMMDI itself has no pagent/noodge implementation notes --- its
  \"agent\" content is the \[\[Agency\]\] / \[\[Agar\]\] pages, which
  are the conceptual backdrop (agency as goal-directedness + autonomy,
  from the dissertation), not technical prior art to lift code from.

# Use case: twitternews-style pagent

Mapping github.com/srconstantin/twitternews onto this design: a page
with `agent:: true`, `schedule:: daily`,
`capabilities:: web, twitter-post`, and a prompt describing what to look
for and how to phrase it. The daemon runs it once a day via headless
`claude -p`, the run\'s summary and a link to what got posted lands
under `## Log`. No custom code beyond the daemon --- the pagent *is* the
twitternews bot.

# Open questions

- Enable Logseq\'s HTTP APIs server and confirm write-back actually
  works before building the daemon around it.
- Cost/latency of a daily headless `claude -p` per pagent --- fine at
  hobby scale, worth checking before this multiplies to dozens of
  pagents.
- Multi-graph handling: the daemon needs to know which graph(s) to scan.
- Bidirectional sync of `last-run::` if the same page is edited from two
  machines (Dropbox-synced graphs, per `ammdi`\'s setup) --- probably
  fine to ignore until it actually causes a conflict.

# Integrates ideas from

Logseq, logseq-claude, Exobrain / Traverse, Goddinpotty, Noodge --- see
\"Architecture\" above for where each actually contributed something.
Nothing carried over wholesale.


# Hey why not

(hyperphor.ellum.core/query :openai "What are some good subagents for an agent whose job is personal financial management? Return a list of anmes, descriptions, goals, and other agentish information")

Certainly! Here’s a list of well-designed **subagents** to support a primary agent whose job is **personal financial management**. I’ll include **name**, **description**, **goal**, and a suggested **Input/Output format** (if you’re considering implementation):

---

### 1. **Budgeting Agent**
- **Description:** Tracks income and expenses, categorizes transactions, and ensures adherence to set budgets.
- **Goal:** Help the user stay within monthly/weekly spending targets and identify overspending.
- **Inputs:** Transaction records, budget categories, period (weekly/monthly)
- **Outputs:** Budget compliance alerts, category summaries, suggestions for adjustments.

---

### 2. **Bill Reminder Agent**
- **Description:** Monitors bill due dates, notifies user ahead of time, and tracks which bills have been paid.
- **Goal:** Minimize late fees or missed payments by ensuring timely bill payments.
- **Inputs:** List of recurring bills, due dates, payment confirmation.
- **Outputs:** Reminders, status update prompts.

---

### 3. **Investment Tracker Agent**
- **Description:** Keeps track of investment accounts, portfolio composition, gains/losses, and asset allocation.
- **Goal:** Provide regular portfolio overviews and suggest rebalancing when allocation drifts from user’s goals.
- **Inputs:** Account/investment data, target allocation preferences, risk profile.
- **Outputs:** Portfolio summaries, rebalancing alerts, performance reports.

---

### 4. **Savings Goal Agent**
- **Description:** Helps the user define, track, and achieve specific savings goals (e.g., emergency fund, vacation, major purchases).
- **Goal:** Monitor progress toward savings goals and encourage regular savings contributions.
- **Inputs:** Savings goals, timelines, account balances, contribution schedule.
- **Outputs:** Progress reports, milestone alerts, motivational reminders.

---

### 5. **Spending Analysis Agent**
- **Description:** Analyzes recent spending habits, highlights trends and potential areas for cost-cutting.
- **Goal:** Identify and present actionable insights for reducing unnecessary expenditures.
- **Inputs:** Transaction history, merchant and category information.
- **Outputs:** Spending trends, anomaly detection, personalized suggestions.

---

### 6. **Debt Reduction Agent**
- **Description:** Tracks outstanding debts, calculates optimal repayment strategies (e.g., avalanche, snowball), and monitors payoff progress.
- **Goal:** Help the user pay down debt efficiently while minimizing interest paid.
- **Inputs:** Debt balances, interest rates, minimum payments, extra payment capabilities.
- **Outputs:** Payment plans, progress trackers, motivational updates.

---

### 7. **Credit Score Monitor Agent**
- **Description:** Monitors credit score changes, explains influencing factors, and suggests ways to improve/maintain credit health.
- **Goal:** Maintain or raise the user’s credit score by identifying issues and providing actionable advice.
- **Inputs:** Credit report updates, scoring models, user action history.
- **Outputs:** Score change alerts, issue explanations, improvement recommendations.

---

### 8. **Tax Preparation Agent**
- **Description:** Organizes tax documents, tracks deductible expenses, and provides year-end summaries for streamlined tax filing.
- **Goal:** Reduce tax-time stress and maximize deductions/credits.
- **Inputs:** Income records, expense categories, tax document receipts.
- **Outputs:** Deduction suggestions, estimated tax liability/refund, document checklists.

---

### 9. **Subscription Tracker Agent**
- **Description:** Monitors and reviews recurring subscriptions/memberships for relevance, cancellations, and renewals.
- **Goal:** Prevent unwanted renewals and help the user eliminate underused services.
- **Inputs:** List of subscriptions, renewal dates, usage patterns.
- **Outputs:** Upcoming renewals, usage analytics, cancellation recommendations.

---

### 10. **Spending Limit Enforcer Agent**
- **Description:** Proactively alerts the user or blocks further spending in certain categories once set limits are approached or exceeded.
- **Goal:** Prevent overspending in discretionary or risky categories.
- **Inputs:** Category limits, real-time spending data.
- **Outputs:** Pre-limit warnings, action suggestions (e.g., freeze card, nudge notifications).

---

**These subagents, working together or as needed, can comprehensively address a user’s financial management needs.** Feel free to ask for dialogue examples, pseudocode, or subagent flows if you want implementation advice!nil
