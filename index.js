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

async function buildPrompt(block, mode = 'ancestors') {
  if (mode === 'block') {
    return block.content;
  }

  if (mode === 'page') {
    const page = await logseq.Editor.getPage(block.page.id);
    const pageBlocks = await logseq.Editor.getPageBlocksTree(page.name);
    const lines = [`# ${page.name}`];
    function collectUntil(blocks) {
      for (const b of blocks) {
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

  // ancestors (default)
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
    const placeholder = await logseq.Editor.insertBlock(block.uuid, '⏳ thinking...', { sibling: false });
    try {
      const prompt = prefix + await buildPrompt(block, mode);
      console.log("Prompt: " + prompt);
      const reply = await askClaude(prompt);
      const blocks = markdownToBlocks(reply);
      const tag = logseq.settings.responseTag;
      if (tag) {
        await logseq.Editor.updateBlock(block.uuid, block.content + ' ' + tag);
      }
      await logseq.Editor.removeBlock(placeholder.uuid);
      await logseq.Editor.insertBatchBlock(block.uuid, blocks, { sibling: false });
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
    if (block) await askBlock(block, 'ancestors');
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
