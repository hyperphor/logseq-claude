<p align="center">
  <img src="logo.svg" width="96" height="96" alt="Ask Claude logo">
</p>

<h1 align="center">Ask Claude</h1>
<p align="center"><em>Query Claude AI from any Logseq block — no copy-paste, no context switching.</em></p>

<p align="center">
  <a href="https://github.com/hyperphor/logseq-claude/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/logseq-plugin-8957e5.svg" alt="Logseq plugin">
  <img src="https://img.shields.io/badge/build-no%20build%20step-brightgreen.svg" alt="No build step">
</p>

A Logseq plugin that lets you query Claude AI directly from any block using slash commands. Responses are inserted as nested child blocks with full markdown support (lists, code blocks, headers).

## Commands

| Command | Context sent | Description |
|---------|-------------|-------------|
| `/Ask Claude` | Ancestor chain | General-purpose query |
| `/Ask Claude (page)` | Full page up to current block | Query with broad page context |
| `/Ask Claude (block)` | Current block only | Query without any surrounding context |
| `/Claude: Summarize` | Ancestor chain | Summarize concisely |
| `/Claude: Improve Writing` | Current block only | Rewrite for clarity and style |
| `/Claude: Explain` | Ancestor chain | Explain simply and clearly |

## Installation

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
2. Install from the Logseq Marketplace, or load as an unpacked plugin:
   - Logseq → Settings → Plugins → Load unpacked plugin → select this folder

## Configuration

In Logseq, go to **Settings → Plugins → Ask Claude**:

- **Anthropic API Key** — your API key (required)
- **Model** — model ID to use (default: `claude-sonnet-4-5`)
- **System Prompt** — sent with every request; tune Claude's tone and style
- **Response Tag** — if set (e.g. `#ai`), this tag is appended to the block from which the command was invoked, making AI-assisted blocks easy to find with Logseq queries
- **Web Access** — on by default; lets Claude fetch a linked URL or search the web when answering, instead of only using training data

## Credits

Built by [Mike Travers](https://github.com/hyperphor). Powered by [Claude](https://www.anthropic.com/claude) and the [Logseq](https://logseq.com) plugin SDK.

## License

MIT
