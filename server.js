const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Load Config ---

const CONFIG_PATH = path.join(__dirname, 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('');
  console.error('  config.json not found!');
  console.error('  Run setup first:  node setup.js');
  console.error('');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const VAULT_ROOT = config.vaultPath ? path.resolve(config.vaultPath) : path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(VAULT_ROOT, config.memoryFolder);
const INBOX_DIR = path.join(VAULT_ROOT, config.inboxFolder);
const PORT = config.port || 3117;
const SKIP_TAGS = new Set(config.skipTags || ['clippings', 'learning', 'inbox', 'transcript']);

// --- In-memory index ---
let noteIndex = [];
let tagIndex = {};
let wikiLinkIndex = {};
let allTags = [];
let lastIndexTime = 0;
const INDEX_TTL = 60000;

// --- Utility ---

function walkDir(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      results = results.concat(walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- YAML Frontmatter Parser ---

function parseNote(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath, '.md');
  const relPath = path.relative(MEMORY_DIR, filePath);
  const result = {
    file: relPath,
    title: fileName,
    type: null,
    tags: [],
    date: null,
    wikiLinks: [],
    excerpt: '',
    bodyText: ''
  };

  // Extract YAML frontmatter
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let bodyStart = 0;

  if (fmMatch) {
    bodyStart = fmMatch[0].length;
    const yaml = fmMatch[1];

    // Parse type
    const typeMatch = yaml.match(/^type:\s*(.+)$/m);
    if (typeMatch) result.type = typeMatch[1].trim().replace(/^["']|["']$/g, '');

    // Parse title
    const titleMatch = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (titleMatch) result.title = titleMatch[1];

    // Parse tags - inline array format: tags: [tag1, tag2]
    const tagsArrayMatch = yaml.match(/^tags:\s*\[([^\]]*)\]/m);
    if (tagsArrayMatch) {
      result.tags = tagsArrayMatch[1].split(',')
        .map(t => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''))
        .filter(Boolean);
    } else {
      // List format: tags:\n  - tag1\n  - tag2
      const tagSectionMatch = yaml.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
      if (tagSectionMatch && tagSectionMatch[1]) {
        const tagLines = tagSectionMatch[1].match(/-\s+["']?(.+?)["']?\s*$/gm);
        if (tagLines) {
          result.tags = tagLines.map(t =>
            t.replace(/^-\s+["']?/, '').replace(/["']\s*$/, '').replace(/^#/, '').trim()
          ).filter(Boolean);
        }
      }
    }

    // Parse date - check all known date fields
    const dateFields = ['date_created', 'created', 'Date added', 'dateCreated', 'date'];
    for (const field of dateFields) {
      const dateMatch = yaml.match(new RegExp(`^${field.replace(/\s/g, '\\s')}:\\s*["']?([\\d-]+)["']?`, 'm'));
      if (dateMatch) { result.date = dateMatch[1]; break; }
    }
  }

  const bodyText = raw.slice(bodyStart);

  // Readwise format: ## Metadata with Category: #type
  const categoryMatch = bodyText.match(/Category:\s*#(\w+)/);
  if (categoryMatch && !result.type) {
    result.type = categoryMatch[1];
  }

  // Extract inline hashtags from body (min 2 chars, skip markdown headings)
  const inlineTags = bodyText.match(/(?<=\s|^)#([a-zA-Z]\w{1,})/g);
  if (inlineTags) {
    const cleanInline = inlineTags.map(t => t.slice(1)).filter(t => !/^\d+$/.test(t));
    result.tags = [...new Set([...result.tags, ...cleanInline])];
  }

  // Extract wiki-links [[Like This]]
  const wikiLinks = bodyText.match(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g);
  if (wikiLinks) {
    result.wikiLinks = [...new Set(
      wikiLinks.map(l => l.replace(/\[\[/, '').replace(/(?:\|[^\]]+)?\]\]/, ''))
    )];
  }

  // Extract excerpt - first meaningful paragraph, max 250 chars
  const lines = bodyText.split('\n').filter(l => {
    const trimmed = l.trim();
    return trimmed
      && !trimmed.startsWith('#')
      && !trimmed.startsWith('!')
      && !trimmed.startsWith('- Author')
      && !trimmed.startsWith('- Full Title')
      && !trimmed.startsWith('- Category')
      && !trimmed.startsWith('http')
      && !trimmed.startsWith('---')
      && trimmed.length > 10;
  });
  if (lines.length > 0) {
    result.excerpt = lines[0].trim()
      .replace(/\*\*|__|==|\[\[|\]\]/g, '')
      .replace(/^>\s*/, '')
      .slice(0, 250);
  }

  // Store searchable body text (lowercase, first 2000 chars for perf)
  result.bodyText = bodyText.toLowerCase().slice(0, 2000);

  // Normalize tags to lowercase, dedupe
  result.tags = [...new Set(result.tags.map(t => t.toLowerCase()).filter(t => t.length > 1))];

  return result;
}

// --- Index Building ---

function buildIndex() {
  noteIndex = [];
  tagIndex = {};
  wikiLinkIndex = {};

  let mdFiles;
  try {
    mdFiles = walkDir(MEMORY_DIR);
  } catch (e) {
    console.error(`Could not read ${config.memoryFolder}/:`, e.message);
    return;
  }

  for (const file of mdFiles) {
    try {
      const note = parseNote(file);
      const idx = noteIndex.length;
      noteIndex.push(note);

      for (const tag of note.tags) {
        if (!tagIndex[tag]) tagIndex[tag] = [];
        tagIndex[tag].push(idx);
      }

      for (const link of note.wikiLinks) {
        const key = link.toLowerCase();
        if (!wikiLinkIndex[key]) wikiLinkIndex[key] = [];
        wikiLinkIndex[key].push(idx);
      }
    } catch (e) {
      // Skip unparseable files
    }
  }

  allTags = Object.keys(tagIndex).sort();
  lastIndexTime = Date.now();
  console.log(`Indexed ${noteIndex.length} notes, ${allTags.length} tags`);
}

function ensureIndex() {
  if (Date.now() - lastIndexTime > INDEX_TTL) buildIndex();
}

// --- Display Score ---

function displayScore(note) {
  let score = 0;
  if (note.title && note.title !== note.file) score += 2;
  if (note.type) score += 2;
  if (note.date) score += 1;
  if (note.tags.length > 1) score += 1;
  if (note.excerpt.length > 50) score += 2;
  return score;
}

// --- Note Serialization ---

function serializeNote(note) {
  return {
    title: note.title,
    type: note.type,
    tags: note.tags.slice(0, 6),
    date: note.date,
    excerpt: note.excerpt,
    file: note.file,
    wikiLinks: note.wikiLinks.slice(0, 5)
  };
}

// --- Random Connected Memories ---

function getRandomMemories() {
  ensureIndex();
  if (noteIndex.length === 0) return { connectingTag: null, notes: [] };

  // Find viable tags (2-15 notes, not in skip list)
  const viable = allTags.filter(t =>
    !SKIP_TAGS.has(t) && tagIndex[t].length >= 2 && tagIndex[t].length <= 15
  );

  if (viable.length === 0) {
    const fallback = allTags.filter(t => tagIndex[t].length >= 2);
    if (fallback.length === 0) {
      const random = shuffleArray(noteIndex).slice(0, 4);
      return { connectingTag: null, notes: random.map(serializeNote) };
    }
    viable.push(...fallback);
  }

  // Weight toward tags with 3-6 notes
  const weighted = viable.flatMap(t => {
    const count = tagIndex[t].length;
    const weight = (count >= 3 && count <= 6) ? 3 : 1;
    return Array(weight).fill(t);
  });

  const chosenTag = weighted[Math.floor(Math.random() * weighted.length)];
  let candidates = tagIndex[chosenTag].map(i => noteIndex[i]);

  if (candidates.length <= 4) {
    return {
      connectingTag: chosenTag,
      notes: shuffleArray(candidates).map(serializeNote)
    };
  }

  const scored = candidates.map(note => ({
    note,
    score: displayScore(note) + Math.random() * 2
  }));
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, 4).map(s => s.note);

  return {
    connectingTag: chosenTag,
    notes: shuffleArray(selected).map(serializeNote)
  };
}

// --- Search Memories ---

function searchMemories(query) {
  ensureIndex();
  if (!query || noteIndex.length === 0) return getRandomMemories();

  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/);
  const scored = [];

  for (const note of noteIndex) {
    let score = 0;
    for (const term of terms) {
      if (note.title.toLowerCase().includes(term)) score += 10;
      if (note.tags.some(t => t.includes(term))) score += 8;
      if (note.wikiLinks.some(l => l.toLowerCase().includes(term))) score += 6;
      if (note.type && note.type.toLowerCase().includes(term)) score += 5;
      if (note.bodyText.includes(term)) score += 3;
    }
    if (score > 0) {
      score += displayScore(note) * 0.5;
      scored.push({ note, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 4).map(s => s.note);

  return {
    connectingTag: null,
    query: query,
    notes: top.map(serializeNote)
  };
}

// --- Save Capture ---

function saveCapture(content, title) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');

  let safeTitle = title
    ? title.replace(/[^\w\s-]/g, '').trim().slice(0, 60)
    : dateStr;

  let fileName = `${safeTitle}.md`;
  let filePath = path.join(INBOX_DIR, fileName);

  if (fs.existsSync(filePath)) {
    fileName = `${safeTitle} ${timeStr}.md`;
    filePath = path.join(INBOX_DIR, fileName);
  }

  const frontmatter = [
    '---',
    'type: capture',
    `date_created: ${dateStr}`,
    'tags:',
    '  - inbox',
    '---',
    '',
    content
  ].join('\n');

  fs.writeFileSync(filePath, frontmatter, 'utf-8');
  return { success: true, file: fileName };
}

// --- HTTP Server ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Serve index.html
    if (url.pathname === '/' && req.method === 'GET') {
      const htmlPath = path.join(__dirname, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // GET /api/config (public config for frontend)
    if (url.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        vaultName: config.vaultName,
        inboxFolder: config.inboxFolder,
        memoryFolder: config.memoryFolder
      }));
      return;
    }

    // GET /api/memories?q=optional
    if (url.pathname === '/api/memories' && req.method === 'GET') {
      const query = url.searchParams.get('q');
      const result = query ? searchMemories(query) : getRandomMemories();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/capture
    if (url.pathname === '/api/capture' && req.method === 'POST') {
      const body = await readBody(req);
      const { content, title } = JSON.parse(body);
      if (!content || !content.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Content is required' }));
        return;
      }
      const result = saveCapture(content.trim(), title);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/note?file=relative/path.md
    if (url.pathname === '/api/note' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      if (!file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'file parameter required' }));
        return;
      }
      const filePath = path.join(MEMORY_DIR, file);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }
      try {
        const raw = fs.readFileSync(resolved, 'utf-8');
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ file, content: body }));
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Note not found' }));
      }
      return;
    }

    // GET /api/stats
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      ensureIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        noteCount: noteIndex.length,
        tagCount: allTags.length
      }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (e) {
    console.error('Request error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// --- Start ---
buildIndex();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Obsiddy In running at http://localhost:${PORT}`);
});
