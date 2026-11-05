// Server-side tools so Claude can follow a link or search instead of refusing
// ("I can't access URLs..."). web_fetch only works on a URL already present
// in the prompt; web_search covers everything else. No beta header needed.
// Using the basic (non-dynamic-filtering) tool versions since the model is
// user-configurable and may be older than Opus/Sonnet 4.6, which is required
// for the newer _20260209 variants.
const WEB_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search' },
  { type: 'web_fetch_20250910', name: 'web_fetch' }
];

async function askClaude(prompt) {
  const { apiKey, model, systemPrompt, webAccess } = logseq.settings;
  const messages = [{ role: 'user', content: prompt }];
  let data;
  // Loop to resume if a server-tool round hits its internal iteration cap
  // (stop_reason "pause_turn") — otherwise we'd return a half-finished answer.
  for (let i = 0; i < 5; i++) {
    const body = {
      model: model || 'claude-sonnet-4-5',
      max_tokens: 2048,
      messages
    };
    if (systemPrompt) body.system = systemPrompt;
    if (webAccess !== false) body.tools = WEB_TOOLS;
    // console.log("api: " + JSON.stringify(body));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-allow-browser': 'true'
      },
      body: JSON.stringify(body)
    });
    data = await res.json();
    if (data.error) throw new Error(data.error.message);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  // With tools enabled, content can include server_tool_use / tool_result
  // blocks alongside text — join just the text blocks for the answer.
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
}

function nestListItems(items) {
  const result = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const children = [];
    i++;
    while (i < items.length && items[i].indent > item.indent) {
      children.push(items[i]);
      i++;
    }
    const block = { content: item.content };
    if (children.length > 0) block.children = nestListItems(children);
    result.push(block);
  }
  return result;
}

function markdownToBlocks(md) {
  const lines = md.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    // Code block — keep as single block
    if (line.trimStart().startsWith('```')) {
      let content = line;
      i++;
      while (i < lines.length) {
        content += '\n' + lines[i];
        if (lines[i].trimStart().startsWith('```')) { i++; break; }
        i++;
      }
      result.push({ content });
      continue;
    }

    // Table — keep contiguous pipe rows as one block with their newlines
    // (the paragraph rule below would join the rows into one line)
    if (line.trimStart().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(lines[i].trim());
        i++;
      }
      result.push({ content: rows.join('\n') });
      continue;
    }

    // List items — collect contiguous list, then nest by indentation
    if (line.match(/^(\s*)([-*+]|\d+\.)\s+/)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
        if (!m) break;
        items.push({ indent: m[1].length, content: m[3] });
        i++;
      }
      result.push(...nestListItems(items));
      continue;
    }

    // Header — single block, no continuation
    if (line.startsWith('#')) {
      result.push({ content: line });
      i++;
      continue;
    }

    // Paragraph — collect lines until blank/list/header/code
    const paraLines = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') break;
      if (next.match(/^(\s*)([-*+]|\d+\.)\s+/)) break;
      if (next.startsWith('#')) break;
      if (next.trimStart().startsWith('```')) break;
      paraLines.push(next);
      i++;
    }
    // Soft-wrapped lines join into one flowing line (Logseq renders \n as a
    // visible break); keep a real newline only for an explicit hard break.
    let content = paraLines[0];
    for (let j = 1; j < paraLines.length; j++) {
      const hardBreak = /(  |\\)$/.test(paraLines[j - 1]);
      content = hardBreak
        ? content.replace(/[ \t]+$/, '') + '\n' + paraLines[j].trim()
        : content.trimEnd() + ' ' + paraLines[j].trim();
    }
    result.push({ content });
  }

  return result;
}

// Logseq keeps properties (collapsed::, id::, …) in raw block content; they're
// noise in a prompt.
function stripProperties(content) {
  return content
    .split('\n')
    .filter(l => !/^\s*[\w-]+::\s/.test(l))
    .join('\n')
    .trim();
}

function subtreeHas(block, uuid) {
  if (block.uuid === uuid) return true;
  return (block.children || []).some(c => subtreeHas(c, uuid));
}

// Each reply is nested under a wrapper block holding just this tag — it marks
// the reply in the graph and lets later prompts leave earlier replies out.
const DEFAULT_RESPONSE_TAG = '#AskClaude';

function responseTag() {
  return logseq.settings.responseTag || DEFAULT_RESPONSE_TAG;
}

function isResponseBlock(b) {
  return stripProperties(b.content || '').startsWith(responseTag());
}

// Skip an earlier reply — unless the invoking block is inside it, in which case
// it's the context for a follow-up question.
function skipAsResponse(b, liveBlock) {
  return isResponseBlock(b) && !subtreeHas(b, liveBlock.uuid);
}

// Render blocks as an indented markdown list. liveBlock supplies the live
// content for the block being edited — persisted content is stale mid-edit.
function renderTree(blocks, liveBlock, depth = 0, lines = []) {
  const pad = '  '.repeat(depth);
  for (const b of blocks) {
    if (skipAsResponse(b, liveBlock)) continue;
    const raw = b.uuid === liveBlock.uuid ? liveBlock.content : (b.content || '');
    const content = stripProperties(raw);
    if (content) {
      content.split('\n').forEach((l, i) => lines.push(pad + (i === 0 ? '- ' : '  ') + l));
    }
    if (b.children && b.children.length > 0) renderTree(b.children, liveBlock, depth + 1, lines);
  }
  return lines;
}

async function buildPrompt(block, mode = 'tree') {
  if (mode === 'block') {
    return block.content;
  }

  if (mode === 'page') {
    const page = await logseq.Editor.getPage(block.page.id);
    const pageBlocks = await logseq.Editor.getPageBlocksTree(page.name);
    const lines = [`# ${page.name}`];
    function collectUntil(blocks) {
      for (const b of blocks) {
        if (skipAsResponse(b, block)) continue;
        // getPageBlocksTree reads persisted content, which is stale for the
        // block currently being edited — use the live content we resolved
        // in getCurrentBlock for that one entry.
        const content = b.uuid === block.uuid ? block.content : b.content;
        if (content) lines.push(content);
        if (b.uuid === block.uuid) return true;
        if (b.children && b.children.length > 0) {
          if (collectUntil(b.children)) return true;
        }
      }
      return false;
    }
    collectUntil(pageBlocks);
    return lines.join('\n');
  }

  if (mode === 'tree') {
    // Walk up to the topmost ancestor and send its whole subtree. The page
    // tree is used rather than getBlock(..., {includeChildren}) because it is
    // known to be fully recursive.
    const page = await logseq.Editor.getPage(block.page.id);
    const pageBlocks = page ? await logseq.Editor.getPageBlocksTree(page.name) : null;
    const top = pageBlocks && pageBlocks.find(b => subtreeHas(b, block.uuid));
    // Fall back to just this block's subtree if the page tree isn't available.
    const root = top || await logseq.Editor.getBlock(block.uuid, { includeChildren: true }) || block;
    const context = renderTree([root], block).join('\n');
    const ask = stripProperties(block.content);
    // The invoking block can sit anywhere in the subtree, so restate it —
    // otherwise the prompt is an outline with no identifiable question.
    const aloneInTree = root.uuid === block.uuid && !(root.children && root.children.length > 0);
    return ask && !aloneInTree
      ? `${context}\n\nRespond to this item from the outline above:\n\n${ask}`
      : context;
  }

  // ancestors
  const chain = [block.content];
  let current = block;
  while (current.parent && current.parent.id !== current.page.id) {
    const parent = await logseq.Editor.getBlock(current.parent.id);
    if (!parent) break;
    chain.unshift(parent.content);
    current = parent;
  }
  return chain.join('\n');
}

logseq.ready(() => {
  async function askBlock(block, mode, prefix = '') {
    // Build the prompt before inserting the placeholder — in tree mode the
    // placeholder would otherwise show up inside the context we collect.
    let prompt;
    try {
      prompt = prefix + await buildPrompt(block, mode);
    } catch (e) {
      logseq.UI.showMsg(e.message, 'error');
      return;
    }
    const placeholder = await logseq.Editor.insertBlock(block.uuid, '⏳ thinking...', { sibling: false });
    try {
      console.log("Prompt: " + prompt);
      const reply = await askClaude(prompt);
      const blocks = markdownToBlocks(reply);
      // Hang the reply off a fresh tag block, then drop the placeholder — in
      // that order, so a failure here still has the placeholder to report in.
      const wrapper = await logseq.Editor.insertBlock(block.uuid, responseTag(), { sibling: false });
      await logseq.Editor.insertBatchBlock(wrapper.uuid, blocks, { sibling: false });
      await logseq.Editor.removeBlock(placeholder.uuid);
    } catch (e) {
      await logseq.Editor.updateBlock(placeholder.uuid, `Error: ${e.message}`);
      logseq.UI.showMsg(e.message, 'error');
    }
  }

  // Slash commands we register — used to strip a leftover trigger fragment below.
  const SLASH_COMMANDS = [
    'Ask Claude (page)', 'Ask Claude (block)', 'Ask Claude',
    'Claude: Summarize', 'Claude: Improve Writing', 'Claude: Explain'
  ];

  // Defensive cleanup: while typing a slash command Logseq only ever shows a
  // *prefix* in the textarea (e.g. "/ask", or bare "/") until a menu item is
  // picked, so match a trailing "/<partial>" fragment (anchored so we don't
  // eat a URL or file path ending in a slash) and strip it if it's a
  // case-insensitive prefix of one of our registered command names.
  function stripSlashTrigger(content) {
    const m = content.match(/(?:^|\s)(\/[^\s/]*)$/);
    if (!m) return content;
    const typed = m[1].slice(1).toLowerCase();
    const isOurCommand = SLASH_COMMANDS.some(name => name.toLowerCase().startsWith(typed));
    if (!isOurCommand) return content;
    return content.slice(0, content.length - m[1].length).trimEnd();
  }

  async function getCurrentBlock() {
    const blockRef = await logseq.Editor.getCurrentBlock();
    if (!blockRef?.uuid) return null;
    const block = await logseq.Editor.getBlock(blockRef.uuid);
    if (!block) return null;
    // block.content (from getBlock) is read from the persisted block entity,
    // which Logseq only updates on blur/save — not on every keystroke. A
    // slash command fired mid-edit (notably the first edit of a block in a
    // session) can therefore see stale/incomplete content, missing the text
    // just typed, including the "/Ask Claude" trigger itself.
    // getEditingBlockContent() reads the live editing state instead, so
    // prefer it when available. Logseq's slash-command dispatch is supposed
    // to strip the trigger text before invoking this callback, but that
    // couldn't be verified against a live instance, hence stripSlashTrigger
    // as a belt-and-suspenders fallback.
    try {
      const live = await logseq.Editor.getEditingBlockContent();
      if (live) block.content = live;
    } catch (e) {
      // Not in edit mode, or API unavailable — fall back to block.content.
    }
    block.content = stripSlashTrigger(block.content);
    return block;
  }

  logseq.Editor.registerSlashCommand('Ask Claude', async () => {
    const block = await getCurrentBlock();
    if (block) await askBlock(block, 'tree');
  });

  logseq.Editor.registerSlashCommand('Ask Claude (page)', async () => {
    const block = await getCurrentBlock();
    if (block) await askBlock(block, 'page');
  });

  logseq.Editor.registerSlashCommand('Ask Claude (block)', async () => {
    const block = await getCurrentBlock();
    if (block) await askBlock(block, 'block');
  });

  logseq.Editor.registerSlashCommand('Claude: Summarize', async () => {
    const block = await getCurrentBlock();
    if (block) await askBlock(block, 'ancestors', 'Summarize the following concisely:\n\n');
  });

  logseq.Editor.registerSlashCommand('Claude: Improve Writing', async () => {
    const block = await getCurrentBlock();
    if (block) await askBlock(block, 'block', 'Improve the clarity and style of the following text. Return only the improved version, no explanation:\n\n');
  });

  logseq.Editor.registerSlashCommand('Claude: Explain', async () => {
    const block = await getCurrentBlock();
    if (block) await askBlock(block, 'ancestors', 'Explain the following simply and clearly:\n\n');
  });
});
