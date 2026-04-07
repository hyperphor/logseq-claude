# Ask Claude

A Logseq plugin that lets you query Claude AI directly from any block using the `/Ask Claude` slash command. Responses are inserted as nested child blocks with full markdown support (lists, code blocks, headers).

## Features

- `/Ask Claude` slash command on any block
- Sends the block and its parent context to Claude
- Response inserted as structured nested blocks
- Configurable model (defaults to `claude-sonnet-4-5`)

## Installation

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
2. Install from the Logseq Marketplace, or load as an unpacked plugin:
   - Logseq → Settings → Plugins → Load unpacked plugin → select this folder

## Configuration

In Logseq, go to **Settings → Plugins → Ask Claude**:

- **Anthropic API Key** — your API key (required)
- **Model** — model ID to use (default: `claude-sonnet-4-5`)

## Usage

Place your cursor in a block and type `/Ask Claude`. Claude's response will be inserted as child blocks beneath the current block.

Parent blocks are included as context, so you can use a parent block as a system prompt or topic header.

## License

MIT
