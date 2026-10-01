# URL access from AskClaude queries

Got this:
- OK Claude, read that and tell me if I got that one right, and how Coase related #AskClaude
	- I can't access URLs or read external content. I only have my training data, which has a cutoff and doesn't include the ability to fetch live web pages.
	- Tell me what the article argues, or paste the key excerpts, and I'll engage with it directly. I can also tell you what I know about Coase's relevance to network vs. hierarchical organization arguments if that helps frame the conversation.

Cause: `askClaude()` was a bare Messages API call with no tools, so Claude had nothing but training data no matter what was in the prompt.

# Fix — DONE

The Messages API has server-side `web_search` and `web_fetch` tools
(`web_search_20250305` / `web_fetch_20250910` — the basic, non-dynamic-
filtering versions, since the model is user-configurable via settings and
may be older than the Opus/Sonnet 4.6+ required for the newer
`_20260209` variants). Declare them in `tools` on the request — no
client-side loop, no beta header. Claude decides when to search or fetch
and the result comes back inline in the same response.

- `web_fetch` only fetches a URL already present in the conversation —
  works as long as the block or an ancestor block has the link, which
  `buildPrompt` already includes.
- `web_search` covers "what does X say" when there's no URL to fetch.

## Implementation (`index.js`)

- `askClaude()` sends both tools by default.
- Response parsing changed from `data.content[0].text` to filtering for
  `type === 'text'` blocks and joining them — with tools on, `content` can
  include `server_tool_use` / `*_tool_result` blocks before the answer.
- A server-tool round can pause (`stop_reason: "pause_turn"`) after enough
  internal search/fetch iterations. `askClaude()` resumes automatically
  (append the assistant turn, re-send, up to 5 rounds) instead of returning
  a half-finished answer.

## Setting

New **Web Access** toggle (default on) in plugin settings — off disables
both tools for cost/latency or to force training-data-only answers.
