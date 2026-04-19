async function askClaude(prompt) {
  const { apiKey, model, systemPrompt } = logseq.settings;
  const body = {
    model: model || 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  };
  if (systemPrompt) body.system = systemPrompt;
    // console.log("api: " + body);
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
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
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
    let content = line;
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') break;
      if (next.match(/^(\s*)([-*+]|\d+\.)\s+/)) break;
      if (next.startsWith('#')) break;
      if (next.trimStart().startsWith('```')) break;
      content += '\n' + next;
      i++;
    }
    result.push({ content });
  }

  return result;
}

async function buildPrompt(block) {
  const mode = logseq.settings.contextMode || 'ancestors';

  if (mode === 'block') {
    return block.content;
  }

  if (mode === 'page') {
    const pageBlocks = await logseq.Editor.getPageBlocksTree(block.page.name);
    const lines = [];
    function collectUntil(blocks) {
      for (const b of blocks) {
        if (b.content) lines.push(b.content);
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
  logseq.Editor.registerSlashCommand('Ask Claude', async () => {
    const blockRef = await logseq.Editor.getCurrentBlock();
    if (!blockRef?.uuid) return;
    const block = await logseq.Editor.getBlock(blockRef.uuid);
    if (!block?.content) return;
    const placeholder = await logseq.Editor.insertBlock(block.uuid, '⏳ thinking...', { sibling: false });
    try {
      const prompt = await buildPrompt(block);
	console.log("Prompt: " + prompt);
      const reply = await askClaude(prompt);
      const blocks = markdownToBlocks(reply);
      const tag = logseq.settings.responseTag;
      if (tag && blocks.length > 0) {
        blocks[0].content = blocks[0].content + ' ' + tag;
      }

      await logseq.Editor.removeBlock(placeholder.uuid);
      await logseq.Editor.insertBatchBlock(block.uuid, blocks, { sibling: false });
    } catch (e) {
      await logseq.Editor.updateBlock(placeholder.uuid, `Error: ${e.message}`);
      logseq.UI.showMsg(e.message, 'error');
    }
  });
});
