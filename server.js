const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YTDLP = process.platform === 'win32' ? ['python', '-m', 'yt_dlp'] : ['yt-dlp'];

let COOKIES_ARG = null;

const COOKIES_PATHS = [
  path.join(__dirname, 'cookies.txt'),
  '/etc/secrets/cookies.txt',
];
for (const p of COOKIES_PATHS) {
  if (fs.existsSync(p)) {
    COOKIES_ARG = p;
    console.log('Cookies found at:', p);
    break;
  }
}

// Fallback: COOKIES env var (Render Environment Variable with raw cookie content)
if (!COOKIES_ARG && process.env.COOKIES) {
  const tmpPath = path.join(__dirname, 'cookies_env.txt');
  try {
    fs.writeFileSync(tmpPath, process.env.COOKIES, 'utf-8');
    COOKIES_ARG = tmpPath;
    console.log('Cookies loaded from COOKIES env var ->', tmpPath);
  } catch (e) {
    console.error('Failed to write cookies from env var:', e.message);
  }
}

if (!COOKIES_ARG) {
  console.log('No cookies found. Private/restricted videos will fail.');
}

const YTDLP_CLIENTS = [
  'youtube:player_client=mweb;player_skip=webpage',
  'youtube:player_client=tv_embedded;player_skip=webpage',
  'youtube:player_client=ios;player_skip=webpage',
  'youtube:player_client=web;player_skip=webpage',
  'youtube:player_client=tv;player_skip=webpage',
];

const YTDLP_CLIENTS_DOWNLOAD = [
  'youtube:player_client=mweb',
  'youtube:player_client=web',
  'youtube:player_client=ios',
  'youtube:player_client=tv_embedded',
  'youtube:player_client=tv',
];

function ytdlp(args, timeoutMs = 120_000) {
  const allArgs = [...args];
  if (COOKIES_ARG) allArgs.push('--cookies', COOKIES_ARG);
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
        console.error('yt-dlp error:', msg);
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
      console.log('Trying yt-dlp client:', client.split(';')[0].replace('youtube:', ''));
      const result = await ytdlp(args, timeoutMs);
      console.log('yt-dlp succeeded with client:', client.split(';')[0].replace('youtube:', ''));
      return result;
    } catch (err) {
      const isRetryable = err.message.includes('bot') || err.message.includes('Sign in') || err.message.includes('format is not available') || err.message.includes('Postprocessing');
      if (!isRetryable) {
        throw err;
      }
      console.log('Client', client.split(';')[0].replace('youtube:', ''), 'failed - trying next...');
    }
  }
  throw new Error('All player clients failed. Try refreshing cookies.');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/video-info', async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });
    const stdout = await ytdlpWithRetry(['--dump-json', '--no-warnings', youtubeUrl]);
    const data = JSON.parse(stdout);
    res.json({
      title: data.title || 'Unknown',
      duration: data.duration || 0,
      thumbnail: data.thumbnail || null,
    });
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
      youtubeUrl,
    ], 120_000, YTDLP_CLIENTS_DOWNLOAD);

    res.json({ id });
  } catch (err) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sounds/:id.mp3', (req, res) => {
  const filePath = path.join(CACHE_DIR, `${req.params.id}.mp3`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Sound not found' });
  }
  res.sendFile(filePath);
});

app.delete('/api/sounds/:id', (req, res) => {
  const filePath = path.join(CACHE_DIR, `${req.params.id}.mp3`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  res.json({ success: true });
});

// Global error handler — always return JSON
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Periodic cleanup of stale cache files (older than 10 minutes)
setInterval(() => {
  if (!fs.existsSync(CACHE_DIR)) return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const fp = path.join(CACHE_DIR, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    } catch { /* race condition, skip */ }
  }
}, 5 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Soundboard running at http://localhost:${PORT}`);
});
