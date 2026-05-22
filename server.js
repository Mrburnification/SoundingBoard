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

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function extractVideoId(url) {
  const match = url.match(/(?:v=|\/shorts\/|embed\/|v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

const INVIDIOUS_INSTANCES = [
  'vid.puffyan.us',
  'invidious.fdn.fr',
  'inv.tux.pizza',
  'invidious.privacyredirect.com',
  'yt.artemislena.eu',
];

const PIPED_INSTANCES = [
  'pipedapi.kavin.rocks',
  'pipedapi.in.projectsegfau.lt',
  'api.piped.projectsegfau.lt',
  'piped-api.privacyredirect.com',
];

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

async function tryOembed(youtubeUrl) {
  try {
    console.log('Trying YouTube oEmbed API...');
    const encodedUrl = encodeURIComponent(youtubeUrl);
    const data = await fetchJson('www.youtube.com', `/oembed?url=${encodedUrl}&format=json`);
    if (data && data.title) {
      console.log('oEmbed succeeded');
      return {
        title: data.title,
        duration: 0,
        thumbnail: data.thumbnail_url || null,
      };
    }
  } catch (e) {
    console.log('oEmbed failed:', e.message);
  }
  return null;
}

async function tryInvidious(videoId) {
  for (const host of INVIDIOUS_INSTANCES) {
    try {
      console.log('Trying Invidious:', host);
      const data = await fetchJson(host, `/api/v1/videos/${videoId}`);
      if (data && data.title) {
        console.log('Invidious succeeded:', host);
        return {
          title: data.title,
          duration: data.lengthSeconds || 0,
          thumbnail: data.videoThumbnails?.find(t => t.quality === 'maxresdefault')?.url || data.videoThumbnails?.[0]?.url || null,
        };
      }
    } catch (e) {
      console.log('Invidious failed:', host, e.message);
    }
  }
  return null;
}

async function tryPipedStreams(videoId) {
  for (const host of PIPED_INSTANCES) {
    try {
      console.log('Trying Piped:', host);
      const data = await fetchJson(host, `/streams/${videoId}`);
      if (data && data.audioStreams) {
        console.log('Piped succeeded:', host);
        return data.audioStreams;
      }
    } catch (e) {
      console.log('Piped failed:', host, e.message);
    }
  }
  return null;
}

function downloadAndTrim(audioUrl, outputPath, startSec, duration) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-y',
      '-i', audioUrl,
      '-ss', String(startSec),
      '-t', String(duration),
      '-vn',
      '-acodec', 'libmp3lame',
      '-q:a', '9',
      '-ar', '44100',
      '-ac', '2',
      outputPath,
    ];
    const proc = execFile('ffmpeg', ffmpegArgs, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120_000,
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg error:', err.message);
        reject(new Error(stderr.split('\n').filter(l => l.startsWith('Error')).join(' ') || err.message));
      } else {
        resolve();
      }
    });
  });
}

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
  console.log('No cookies found. Will use Piped/Invidious fallback.');
}

const YTDLP_CLIENTS = [
  'youtube:player_client=tv_embedded;player_skip=webpage',
  'youtube:player_client=mweb;player_skip=webpage',
  'youtube:player_client=ios;player_skip=webpage',
  'youtube:player_client=web;player_skip=webpage',
];

const YTDLP_CLIENTS_DOWNLOAD = [
  'youtube:player_client=tv_embedded',
  'youtube:player_client=mweb',
  'youtube:player_client=web',
  'youtube:player_client=ios',
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
  throw new Error('All player clients failed');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/video-info', async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    let data;
    // Try oEmbed first (free, unlimited, never blocked)
    data = await tryOembed(youtubeUrl);
    if (!data) {
      // Fallback to Invidious
      console.log('oEmbed failed, trying Invidious fallback...');
      data = await tryInvidious(videoId);
    }
    if (!data) {
      // Last resort: yt-dlp
      console.log('Invidious failed, trying yt-dlp...');
      try {
        const stdout = await ytdlpWithRetry(['--dump-json', '--no-warnings', youtubeUrl]);
        const ytdlpData = JSON.parse(stdout);
        data = {
          title: ytdlpData.title || 'Unknown',
          duration: ytdlpData.duration || 0,
          thumbnail: ytdlpData.thumbnail || null,
        };
      } catch (ytdlpErr) {
        throw new Error('Could not fetch video info. All sources failed.');
      }
    }
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sounds', async (req, res) => {
  const { youtubeUrl, startSec, endSec } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
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
    ], 120_000, YTDLP_CLIENTS_DOWNLOAD);
    res.json({ id });
  } catch (ytdlpErr) {
    console.log('yt-dlp download failed, trying Piped fallback...');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    try {
      const audioStreams = await tryPipedStreams(videoId);
      if (!audioStreams || audioStreams.length === 0) {
        throw new Error('No audio streams available from Piped');
      }
      const audioUrl = audioStreams[0].url;
      console.log('Downloading from Piped stream:', audioUrl.substring(0, 80) + '...');
      await downloadAndTrim(audioUrl, outputPath, startSec, duration);
      if (!fs.existsSync(outputPath)) {
        throw new Error('ffmpeg failed to produce output file');
      }
      console.log('Piped download + ffmpeg trim succeeded');
      res.json({ id });
    } catch (pipedErr) {
      res.status(500).json({ error: `yt-dlp: ${ytdlpErr.message}. Piped fallback: ${pipedErr.message}` });
    }
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
