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

// Send a full message history (alternating user/assistant turns) to Claude.
// `messages` is mutated in place when a "pause_turn" round trip occurs.
async function askClaudeMessages(messages) {
  const { apiKey, model, systemPrompt, webAccess } = logseq.settings;
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

// Single-turn convenience wrapper around askClaudeMessages.
async function askClaude(prompt) {
  return askClaudeMessages([{ role: 'user', content: prompt }]);
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

logseq.ready(() => {
  // Shared insertion path: show a placeholder, run `getReply()` to fetch
  // Claude's answer, then swap the placeholder for the rendered blocks.
  async function insertReply(block, getReply) {
    const placeholder = await logseq.Editor.insertBlock(block.uuid, '⏳ thinking...', { sibling: false });
    try {
      const reply = await getReply();
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

  async function askBlock(block, mode, prefix = '') {
    await insertReply(block, async () => {
      const prompt = prefix + await buildPrompt(block, mode);
      console.log("Prompt: " + prompt);
      return askClaude(prompt);
    });
  }

  // Reconstruct a prior Ask-Claude exchange as message history, for
  // `/Claude: Continue`.
  //
  // Heuristic (v1, not general thread detection): assumes `block` is a
  // follow-up the user typed as a further child of the *same parent* that
  // holds Claude's previously-inserted reply block(s) — i.e. the standard
  // shape askBlock() produces: prompt block -> reply block(s) as children.
  // The parent's other children (excluding `block` itself) are treated as
  // one flattened assistant turn, and buildPrompt(parent, 'ancestors') is
  // replayed as the original user turn. This does NOT handle: follow-ups
  // nested *under* a reply block (deeper multi-turn threads), replies that
  // were edited/reordered/deleted, or more than one round of follow-up
  // (only the immediate parent is consulted, not further up the chain).
  // Recursively collect block content under `nodes`, skipping `skipUuid`.
  // `children` entries can come back as full block entities or as
  // [type, uuid] tuples depending on the SDK call — handle both, and
  // recurse so nested (e.g. list) reply content isn't dropped.
  async function collectContent(nodes, skipUuid, out = []) {
    for (const n of nodes || []) {
      const b = Array.isArray(n) ? await logseq.Editor.getBlock(n[1], { includeChildren: true }) : n;
      if (!b || b.uuid === skipUuid) continue;
      if (b.content) out.push(b.content);
      await collectContent(b.children, skipUuid, out);
    }
    return out;
  }

  async function buildConversation(block) {
    if (!block.parent) return null;
    const parent = await logseq.Editor.getBlock(block.parent.id, { includeChildren: true });
    if (!parent) return null;
    const priorReplies = (await collectContent(parent.children, block.uuid)).join('\n\n');
    if (!priorReplies) return null; // no prior exchange found to continue
    const initialPrompt = await buildPrompt(parent, 'ancestors');
    return [
      { role: 'user', content: initialPrompt },
      { role: 'assistant', content: priorReplies },
      { role: 'user', content: block.content }
    ];
  }

  async function continueBlock(block) {
    const conversation = await buildConversation(block);
    if (!conversation) {
      logseq.UI.showMsg('No prior Claude exchange found to continue from here.', 'error');
      return;
    }
    await insertReply(block, () => askClaudeMessages(conversation));
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

  logseq.Editor.registerSlashCommand('Claude: Continue', async () => {
    const block = await getCurrentBlock();
    if (block) await continueBlock(block);
  });
});
