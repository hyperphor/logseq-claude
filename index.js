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

// Heuristic: is this the page's properties ("pre-block") block? Logseq
// exposes this as `preBlock` / `pre-block?` depending on API version, so
// check both, and fall back to a content-shape check (every line looks
// like `key:: value`) so this still works if neither flag is present.
function isPropertiesBlock(block) {
  if (!block) return false;
  if (block.preBlock || block['pre-block?']) return true;
  if (!block.content) return false;
  const lines = block.content.split('\n').map(l => l.trim()).filter(l => l !== '');
  if (lines.length === 0) return false;
  return lines.every(l => /^[A-Za-z0-9_-]+::\s*/.test(l));
}

// Render a block tree (as returned by getPageBlocksTree) into nested
// markdown list items, preserving the outline structure.
function blocksToMarkdown(blocks, depth = 0) {
  const lines = [];
  const indent = '  '.repeat(depth);
  for (const b of blocks) {
    if (b.content) {
      const contentLines = b.content.split('\n');
      lines.push(indent + '- ' + contentLines[0]);
      for (const extra of contentLines.slice(1)) {
        lines.push(indent + '  ' + extra);
      }
    }
    if (b.children && b.children.length > 0) {
      lines.push(...blocksToMarkdown(b.children, depth + 1));
    }
  }
  return lines;
}

// Build a full markdown "spec" document from an entire page: title,
// optional target-project note, then the page outline (properties block
// excluded). Unlike buildPrompt('page', …), this does not stop at any
// particular block — it always renders the whole page.
function buildPageSpec(pageTitle, pageBlocks, project) {
  const lines = [`# ${pageTitle}`];
  if (project) lines.push('', `_Target project: ${project}_`);
  const [first, ...rest] = pageBlocks;
  const body = first && isPropertiesBlock(first) ? rest : pageBlocks;
  lines.push('', ...blocksToMarkdown(body, 0));
  return lines.join('\n');
}

// project:: <value> on the page's properties block, if present.
function readProjectProperty(pageBlocks) {
  const first = pageBlocks[0];
  if (!first || !first.content) return null;
  const m = first.content.match(/^project::\s*(.+)$/m);
  return m ? m[1].trim() : null;
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

  async function getCurrentBlock() {
    const blockRef = await logseq.Editor.getCurrentBlock();
    if (!blockRef?.uuid) return null;
    return await logseq.Editor.getBlock(blockRef.uuid);
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

  // Turns the current page into a markdown "spec" and hands it off for use
  // with Claude Code. The plugin sandbox has no verified way to invoke the
  // `claude` CLI or write files outside Logseq's own storage (see
  // spec/claude-code.md) — so this copies the spec to the clipboard and
  // tells the user where to paste it, falling back to inserting it as a
  // code block if the clipboard write fails.
  logseq.Editor.registerSlashCommand('PushClaudeCode', async () => {
    const block = await getCurrentBlock();
    if (!block) return;
    try {
      const page = await logseq.Editor.getPage(block.page.id);
      const pageBlocks = await logseq.Editor.getPageBlocksTree(page.name);
      const project = readProjectProperty(pageBlocks) || logseq.settings.defaultProjectPath || null;
      const spec = buildPageSpec(page.originalName || page.name, pageBlocks, project);

      let copied = false;
      try {
        await navigator.clipboard.writeText(spec);
        copied = true;
      } catch (e1) {
        try {
          await parent.navigator.clipboard.writeText(spec);
          copied = true;
        } catch (e2) {
          copied = false;
        }
      }

      const where = project ? ` in ${project}` : '';
      if (copied) {
        logseq.UI.showMsg(`Spec copied to clipboard. Run "claude"${where} and paste it in.`, 'success');
      } else {
        await logseq.Editor.insertBlock(block.uuid, '```markdown\n' + spec + '\n```', { sibling: false });
        logseq.UI.showMsg(`Could not copy to clipboard. Spec inserted below — copy it and run "claude"${where}.`, 'warning');
      }
    } catch (e) {
      logseq.UI.showMsg(e.message, 'error');
    }
  });
});
