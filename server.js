const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
const COOKIES_TMP = path.join(__dirname, 'cookies_runtime.txt');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── YouTube helpers ────────────────────────────────────────────────

function extractVideoId(url) {
  const match = url.match(/(?:v=|\/shorts\/|embed\/|v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function fetchJson(host, p) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://${host}${p}`, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
  });
}

// ── Cookie management ───────────────────────────────────────────────

const YTDLP = process.platform === 'win32' ? ['python', '-m', 'yt_dlp'] : ['yt-dlp'];
let cookiesPath = null;

function detectCookies() {
  if (fs.existsSync(COOKIES_TMP)) {
    cookiesPath = COOKIES_TMP;
  } else {
    const paths = [path.join(__dirname, 'cookies.txt'), '/etc/secrets/cookies.txt'];
    const found = paths.find(p => fs.existsSync(p));
    if (found) { cookiesPath = found; }
  }
  if (!cookiesPath && process.env.COOKIES) {
    try {
      fs.writeFileSync(COOKIES_TMP, process.env.COOKIES, 'utf-8');
      cookiesPath = COOKIES_TMP;
    } catch (e) { /* will try later */ }
  }
}

detectCookies();

function cookiesLoaded() {
  return !!cookiesPath;
}

// ── yt-dlp ──────────────────────────────────────────────────────────

const YTDLP_CLIENTS = [
  'youtube:player_client=tv_embedded;player_skip=webpage',
  'youtube:player_client=mweb;player_skip=webpage',
  'youtube:player_client=ios;player_skip=webpage',
  'youtube:player_client=web;player_skip=webpage',
];

function ytdlp(args, timeoutMs = 120_000) {
  const allArgs = [...args];
  if (cookiesPath) allArgs.push('--cookies', cookiesPath);
  return new Promise((resolve, reject) => {
    const proc = execFile(YTDLP[0], [...YTDLP.slice(1), ...allArgs], {
      maxBuffer: 10 * 1024 * 1024,
      cwd: __dirname,
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err) {
        const lines = stderr.split('\n');
        const errorLine = lines.find(l => l.startsWith('ERROR')) || lines.find(l => l.startsWith('WARNING'));
        const msg = errorLine ? errorLine.replace(/^(ERROR|WARNING):\s*/, '') : err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function ytdlpWithRetry(baseArgs, timeoutMs = 120_000, clients = YTDLP_CLIENTS) {
  for (const client of clients) {
    const args = [...baseArgs, '--extractor-args', client];
    try {
      const result = await ytdlp(args, timeoutMs);
      return result;
    } catch (err) {
      if (!err.message.includes('bot') && !err.message.includes('Sign in') &&
          !err.message.includes('format is not available') && !err.message.includes('Postprocessing')) {
        throw err;
      }
    }
  }
  throw new Error('All player clients failed');
}

// ── YouTube oEmbed (free, never blocked) ────────────────────────────

async function tryOembed(youtubeUrl) {
  try {
    const encodedUrl = encodeURIComponent(youtubeUrl);
    const data = await fetchJson('www.youtube.com', `/oembed?url=${encodedUrl}&format=json`);
    if (data && data.title) {
      return { title: data.title, duration: 0, thumbnail: data.thumbnail_url || null };
    }
  } catch { /* skip */ }
  return null;
}

async function tryYtdlpDuration(youtubeUrl) {
  try {
    const stdout = await ytdlp(['--dump-json', '--no-warnings', '--extractor-args', 'youtube:player_client=tv_embedded;player_skip=webpage', youtubeUrl], 30000);
    const d = JSON.parse(stdout);
    if (d && d.duration) return d.duration;
  } catch { /* skip */ }
  return null;
}

// ── API ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/cookies', (req, res) => {
  res.json({ loaded: cookiesLoaded() });
});

app.post('/api/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Cookies text is required' });
  try {
    fs.writeFileSync(COOKIES_TMP, cookies, 'utf-8');
    cookiesPath = COOKIES_TMP;
    console.log('Cookies updated via paste (runtime)');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save cookies' });
  }
});

app.post('/api/video-info', async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    let data = await tryOembed(youtubeUrl);
    if (data && data.duration === 0) {
      const dur = await tryYtdlpDuration(youtubeUrl);
      if (dur) data.duration = dur;
    }
    if (!data) {
      const stdout = await ytdlpWithRetry(['--dump-json', '--no-warnings', youtubeUrl]);
      data = JSON.parse(stdout);
      data = { title: data.title, duration: data.duration || 0, thumbnail: data.thumbnail || null };
    }
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sounds', async (req, res) => {
  const { youtubeUrl, startSec, endSec } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });
  const id = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(CACHE_DIR, `${id}.mp3`);
  const duration = endSec - startSec;

  try {
    await ytdlpWithRetry([
      '-f', 'bestaudio',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '10',
      '--postprocessor-args', `ffmpeg:-ss ${startSec} -t ${duration}`,
      '-o', path.join(CACHE_DIR, `${id}.%(ext)s`),
      '--no-warnings',
      '--no-playlist',
      '--no-check-formats',
      '--embed-metadata',
      '--force-ipv4',
      youtubeUrl,
    ]);
    res.json({ id });
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sounds/:id.mp3', (req, res) => {
  const filePath = path.join(CACHE_DIR, `${req.params.id}.mp3`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Sound not found' });
  res.sendFile(filePath);
});

app.delete('/api/sounds/:id', (req, res) => {
  const filePath = path.join(CACHE_DIR, `${req.params.id}.mp3`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

setInterval(() => {
  if (!fs.existsSync(CACHE_DIR)) return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const fp = path.join(CACHE_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* race */ }
  }
}, 5 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  const status = cookiesLoaded() ? `cookies at ${cookiesPath}` : 'NO cookies';
  console.log(`Soundboard running at http://0.0.0.0:${PORT} | ${status}`);
});
