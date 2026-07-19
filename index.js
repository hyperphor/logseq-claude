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

// ---- Google Voice import (/Import Google Voice) ----
// See spec/voice.md for the full design, the Takeout export layout this is
// written against, and the documented gap (below) around plugin file access.

// Resolve a { year, month, day } date from a journal page. Prefers the
// PageEntity's `journalDay` field (documented as a YYYYMMDD integer in the
// Logseq plugin API), and falls back to parsing common journal-title formats
// in case `journalDay` is absent — this repo's research had no live Logseq
// instance to confirm `journalDay`'s exact shape, so the fallback is load-bearing,
// not decorative.
function resolveJournalDate(page) {
  if (!page) return null;
  if (typeof page.journalDay === 'number') {
    const s = String(page.journalDay);
    if (s.length === 8) {
      return { year: +s.slice(0, 4), month: +s.slice(4, 6), day: +s.slice(6, 8) };
    }
  }
  const name = page.originalName || page.name || '';
  let m = name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = name.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) {
    const idx = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (idx !== -1) return { year: +m[3], month: idx + 1, day: +m[2] };
  }
  return null;
}

function formatDateYMD(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

// Google Takeout names Voice recordings like:
//   "<Caller Name> - Voicemail - 2026-07-19T23_04_11Z.html"
//   "<Caller Name> - Voicemail - 2026-07-19T23_04_11Z.mp3"
// The date in the filename is UTC — a voicemail near local midnight can land
// on the adjacent UTC day. Not corrected for here; documented as a known
// limitation in spec/voice.md rather than silently guessed at.
const GOOGLE_VOICE_FILENAME_RE = /-\s*(Voicemail|Received|Missed|Placed)\s*-\s*(\d{4})-(\d{2})-(\d{2})T\d{2}_\d{2}_\d{2}Z\.(html|mp3)$/i;

function parseGoogleVoiceFilename(filename) {
  const m = filename.match(GOOGLE_VOICE_FILENAME_RE);
  if (!m) return null;
  return { kind: m[1], year: +m[2], month: +m[3], day: +m[4], ext: m[5].toLowerCase() };
}

function callerFromFilename(filename) {
  const m = filename.match(/^(.*?)\s*-\s*(Voicemail|Received|Missed|Placed|Text)\s*-/i);
  return m ? m[1].trim() : 'Unknown';
}

function matchesDate(parsed, date) {
  return !!parsed && parsed.year === date.year && parsed.month === date.month && parsed.day === date.day;
}

// Best-effort transcript extraction. Google's Takeout voicemail HTML markup
// was not verified against a live export in this repo's research (no sample
// export was available) — this strips all tags rather than targeting a
// specific selector, so it should degrade gracefully even if the real markup
// differs from what's assumed in spec/voice.md. Revisit against a real
// exported .html file before relying on this for anything precise.
function extractVoicemailTranscript(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function googleVoiceRecordingToBlock(rec) {
  const header = `**${rec.caller || 'Unknown'}** — ${rec.timestamp || ''}`.trim();
  const content = [header, rec.transcript ? rec.transcript : '_(no transcript captured)_'].join('\n');
  const block = { content };
  const includeAudio = logseq.settings.googleVoiceIncludeAudioLink !== false;
  if (includeAudio && rec.audioPath) {
    // encodeURI: Takeout filenames always contain spaces (e.g. "Alice Smith
    // - Voicemail - ...") and markdown link targets break on raw spaces.
    block.children = [{ content: `[Voicemail audio](file://${encodeURI(rec.audioPath)})` }];
  }
  return block;
}

// Pairs up the .html/.mp3 files sharing a basename and turns the ones
// matching `date` into block specs for insertBatchBlock. This is real,
// exercisable logic given `files` — the part that isn't implemented is
// producing `files` from disk (see findGoogleVoiceExportFiles below).
function selectGoogleVoiceBlocks(files, date) {
  const byBase = new Map();
  for (const f of files) {
    const parsed = parseGoogleVoiceFilename(f.name);
    if (!matchesDate(parsed, date)) continue;
    const base = f.name.replace(/\.(html|mp3)$/i, '');
    const entry = byBase.get(base) || { caller: callerFromFilename(f.name), timestamp: formatDateYMD(parsed) };
    if (parsed.ext === 'html') entry.transcript = extractVoicemailTranscript(f.htmlText);
    if (parsed.ext === 'mp3') entry.audioPath = f.audioPath;
    byBase.set(base, entry);
  }
  return Array.from(byBase.values()).map(googleVoiceRecordingToBlock);
}

// GAP: Logseq plugins run in an embedded webview/iframe, not a Node process
// with unrestricted `fs`. There is no confirmed, documented plugin API for
// "read this absolute path from disk" analogous to `logseq.settings`. The
// realistic options (File System Access API directory picker with a
// persisted handle, or a manual <input type=file webkitdirectory> picker)
// both need verification against a real running Logseq instance, which this
// implementation did not have access to. Rather than fake a result, this
// throws — see spec/voice.md "Known gap: plugin sandbox file access is
// unverified" for the options to evaluate next.
async function findGoogleVoiceExportFiles(_exportPath) {
  throw new Error('local file reading not implemented yet — see spec/voice.md');
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

  // Scaffold only — see spec/voice.md. Date resolution, matching, and
  // block-shaping are real; local file reading is a documented gap, so this
  // reports its status honestly instead of pretending to import anything.
  logseq.Editor.registerSlashCommand('Import Google Voice', async () => {
    const block = await getCurrentBlock();
    if (!block) return;

    const page = await logseq.Editor.getPage(block.page.id);
    const date = resolveJournalDate(page);
    if (!date) {
      logseq.UI.showMsg('Import Google Voice: run this from a journal page — could not resolve a date.', 'error');
      return;
    }

    const exportPath = logseq.settings.googleVoiceExportPath;
    if (!exportPath) {
      logseq.UI.showMsg('Import Google Voice: set "Google Voice Export Path" in plugin settings first.', 'error');
      return;
    }

    try {
      const files = await findGoogleVoiceExportFiles(exportPath);
      const blocks = selectGoogleVoiceBlocks(files, date);
      if (blocks.length === 0) {
        logseq.UI.showMsg(`Import Google Voice: no recordings found for ${formatDateYMD(date)}.`);
        return;
      }
      await logseq.Editor.insertBatchBlock(block.uuid, blocks, { sibling: false });
    } catch (e) {
      logseq.UI.showMsg(
        `Import Google Voice: resolved date ${formatDateYMD(date)}, but local file reading is not yet wired up (${e.message}). See spec/voice.md.`,
        'warning'
      );
    }
  });
});
