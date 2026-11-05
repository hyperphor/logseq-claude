# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A minimal Logseq plugin that adds an `/Ask Claude` slash command. When invoked on a block, it sends surrounding context (by default the whole top-level subtree the block sits in, minus earlier replies) to the Anthropic API and inserts the response under a block holding the response tag (default `#AskClaude`), which is also how earlier responses are recognized and excluded.

## Architecture

The entire plugin is a single file: `index.html`. It uses no build step — Logseq loads it directly as an unpacked plugin.

- `index.html` — loads the Logseq plugin SDK from CDN, calls `logseq.ready()`, registers the slash command, and calls the Anthropic Messages API directly from the browser (requires the `anthropic-dangerous-allow-browser: true` header).
- `package.json` — plugin manifest consumed by Logseq (id, title, icon, settings schema). The `settingsSchema` defines the `apiKey` and `model` fields that appear in Logseq's plugin settings UI and are accessible at runtime via `logseq.settings`.
- `settings-example.json` — example of the external config file at `~/.logseq/settings/logseq-claude.json`.

## Installing / running

Load as an unpacked Logseq plugin: Logseq → Settings → Plugins → Load unpacked plugin → select this folder.

No build, no `npm install` needed.

## Configuration

Settings are stored by Logseq in `~/.logseq/settings/logseq-claude.json`. Required field: `apiKey` (Anthropic API key). Optional: `model` (defaults to `claude-sonnet-4-5`).

## Key Logseq SDK patterns used

- `logseq.Editor.getCurrentBlock()` — get the block the cursor is in
- `logseq.Editor.insertBlock(uuid, text, { sibling: false })` — insert a child block
- `logseq.Editor.getBlock(uuid, { includeChildren: true })` — fetch block with children
- `logseq.Editor.updateBlock(uuid, text)` — replace a block's content
- `logseq.Editor.getPageBlocksTree(pageName)` — full recursive block tree for a page
- `logseq.Editor.insertBatchBlock(uuid, blocks, { sibling: false })` — insert a nested batch
- `logseq.Editor.removeBlock(uuid)` — delete a block
- `logseq.UI.showMsg(msg, 'error')` — show a toast notification
