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

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile(PYTHON, ['-m', 'yt_dlp', ...args], {
      maxBuffer: 10 * 1024 * 1024,
      cwd: __dirname,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr.split('\n').filter(l => l.startsWith('ERROR'))[0] || err.message;
        reject(new Error(msg.replace(/^ERROR:\s*/, '')));
      } else {
        resolve(stdout);
      }
    });
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/video-info', async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    const stdout = await ytdlp(['--dump-json', '--no-warnings', youtubeUrl]);
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
  const id = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(CACHE_DIR, `${id}.mp3`);
  const duration = endSec - startSec;

  try {
    await ytdlp([
      '-f', 'bestaudio',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--postprocessor-args', `ffmpeg:-ss ${startSec} -t ${duration}`,
      '-o', path.join(CACHE_DIR, `${id}.%(ext)s`),
      '--no-warnings',
      '--no-playlist',
      '--no-check-formats',
      '--embed-metadata',
      youtubeUrl,
    ]);

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
