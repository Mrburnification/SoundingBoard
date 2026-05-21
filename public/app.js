let soundboard = [];
let polyphonic = false;
let currentAudio = null;
let editingId = null;
let videoInfo = null;

const $ = (sel) => document.querySelector(sel);

const els = {
  soundboard: $('#soundboard'),
  emptyState: $('#emptyState'),
  polyToggle: $('#polyToggle'),
  addBtn: $('#addBtn'),
  modal: $('#modal'),
  modalTitle: $('#modalTitle'),
  closeBtn: $('.close-btn'),
  youtubeUrl: $('#youtubeUrl'),
  fetchBtn: $('#fetchBtn'),
  fetchStatus: $('#fetchStatus'),
  stepInfo: $('#stepInfo'),
  videoTitle: $('#videoTitle'),
  videoDuration: $('#videoDuration'),
  startSlider: $('#startSlider'),
  endSlider: $('#endSlider'),
  startDisplay: $('#startDisplay'),
  endDisplay: $('#endDisplay'),
  btnLabel: $('#btnLabel'),
  btnEmoji: $('#btnEmoji'),
  btnBgColor: $('#btnBgColor'),
  btnTextColor: $('#btnTextColor'),
  saveBtn: $('#saveBtn'),
};

const DB_NAME = 'SoundboardDB';
const STORE_NAME = 'audio';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveAudioToDB(id, arrayBuffer) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(arrayBuffer, id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getAudioFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function deleteAudioFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

const blobUrls = {};

function revokeBlobUrl(id) {
  if (blobUrls[id]) {
    URL.revokeObjectURL(blobUrls[id]);
    delete blobUrls[id];
  }
}

function loadState() {
  try {
    soundboard = JSON.parse(localStorage.getItem('soundboard')) || [];
    polyphonic = localStorage.getItem('polyphonic') === 'true';
  } catch {
    soundboard = [];
  }
  els.polyToggle.checked = polyphonic;
}

function saveState() {
  localStorage.setItem('soundboard', JSON.stringify(soundboard));
  localStorage.setItem('polyphonic', polyphonic);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function render() {
  els.soundboard.innerHTML = '';

  if (soundboard.length === 0) {
    els.soundboard.appendChild(els.emptyState);
    return;
  }

  soundboard.forEach((sound, i) => {
    const btn = document.createElement('button');
    btn.className = 'sound-btn';
    btn.style.backgroundColor = sound.bgColor || '#6c5ce7';
    btn.style.color = sound.textColor || '#ffffff';
    btn.innerHTML = `
      <span class="btn-emoji">${sound.emoji || '🔊'}</span>
      <span class="btn-label">${escapeHtml(sound.label || 'Sound')}</span>
      <span class="btn-actions">
        <span data-action="up" data-i="${i}" title="Move left">◀</span>
        <span data-action="down" data-i="${i}" title="Move right">▶</span>
        <span data-action="edit" data-i="${i}" title="Edit">✎</span>
        <span data-action="delete" data-i="${i}" title="Delete">✕</span>
      </span>
    `;
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.btn-actions')) return;
      playSound(sound.id);
    });
    els.soundboard.appendChild(btn);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function playSound(id) {
  if (!polyphonic) {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  }

  revokeBlobUrl(id);

  try {
    const arrayBuffer = await getAudioFromDB(id);
    if (!arrayBuffer) {
      console.warn('Sound not in local storage, needs re-add');
      return;
    }
    const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    blobUrls[id] = url;

    const audio = new Audio(url);
    audio.play();
    if (!polyphonic) {
      currentAudio = audio;
      audio.addEventListener('ended', () => { currentAudio = null; });
    }
  } catch (err) {
    console.error('Failed to play sound:', err);
  }
}

function openModal(sound) {
  editingId = sound ? sound.id : null;
  els.modal.classList.remove('hidden');

  if (sound) {
    els.modalTitle.textContent = 'Edit Sound';
    els.youtubeUrl.value = sound.youtubeUrl || '';
    els.btnLabel.value = sound.label || '';
    els.btnEmoji.value = sound.emoji || '';
    els.btnBgColor.value = sound.bgColor || '#6c5ce7';
    els.btnTextColor.value = sound.textColor || '#ffffff';
    els.saveBtn.textContent = 'Update';
    els.fetchStatus.textContent = '';
    if (sound.youtubeUrl) {
      fetchVideoInfo(sound.youtubeUrl, sound.startSec, sound.endSec);
    }
  } else {
    els.modalTitle.textContent = 'Add Sound';
    resetForm();
    els.saveBtn.textContent = 'Add to Soundboard';
  }
}

function closeModal() {
  els.modal.classList.add('hidden');
  editingId = null;
  videoInfo = null;
}

function resetForm() {
  els.youtubeUrl.value = '';
  els.stepInfo.classList.add('hidden');
  els.fetchStatus.textContent = '';
  els.startSlider.value = 0;
  els.endSlider.value = 100;
  els.btnLabel.value = '';
  els.btnEmoji.value = '';
  els.btnBgColor.value = '#6c5ce7';
  els.btnTextColor.value = '#ffffff';
  els.saveBtn.disabled = false;
}

async function fetchVideoInfo(url, presetStart, presetEnd) {
  els.stepInfo.classList.add('hidden');
  els.saveBtn.disabled = true;
  els.fetchStatus.textContent = 'Fetching video info...';

  try {
    const res = await fetch('/api/video-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: url }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch video info');
    }
    const data = await res.json();
    videoInfo = data;

    els.videoTitle.textContent = data.title;
    els.videoDuration.textContent = formatTime(data.duration);
    els.fetchStatus.textContent = '';

    els.startSlider.max = data.duration;
    els.endSlider.max = data.duration;

    if (presetStart !== undefined) els.startSlider.value = presetStart;
    else els.startSlider.value = 0;

    if (presetEnd !== undefined) els.endSlider.value = presetEnd;
    else els.endSlider.value = data.duration;

    updateSliderDisplays();
    els.stepInfo.classList.remove('hidden');
    els.saveBtn.disabled = false;
  } catch (err) {
    els.fetchStatus.textContent = 'Error: ' + err.message;
    els.fetchStatus.style.color = '#e74c3c';
    els.saveBtn.disabled = false;
  }
}

function updateSliderDisplays(e) {
  let start = parseFloat(els.startSlider.value);
  let end = parseFloat(els.endSlider.value);

  if (start >= end) {
    if (e && e.target === els.startSlider) {
      els.endSlider.value = Math.min(start + 0.1, els.endSlider.max);
    } else {
      els.startSlider.value = Math.max(end - 0.1, els.startSlider.min);
    }
    start = parseFloat(els.startSlider.value);
    end = parseFloat(els.endSlider.value);
  }

  els.startDisplay.textContent = formatTime(start);
  els.endDisplay.textContent = formatTime(end);
}

async function processSound(youtubeUrl, startSec, endSec) {
  const res = await fetch('/api/sounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtubeUrl, startSec, endSec }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Processing failed');
  }
  const data = await res.json();
  const audioRes = await fetch(`/api/sounds/${data.id}.mp3`);
  if (!audioRes.ok) throw new Error('Failed to download audio');
  const arrayBuffer = await audioRes.arrayBuffer();
  await saveAudioToDB(data.id, arrayBuffer);
  fetch(`/api/sounds/${data.id}`, { method: 'DELETE' });
  return data.id;
}

async function saveSound() {
  const youtubeUrl = els.youtubeUrl.value.trim();
  const startSec = parseFloat(els.startSlider.value);
  const endSec = parseFloat(els.endSlider.value);
  const label = els.btnLabel.value.trim() || 'Sound';
  const emoji = els.btnEmoji.value.trim() || '🔊';
  const bgColor = els.btnBgColor.value;
  const textColor = els.btnTextColor.value;

  if (!youtubeUrl) {
    els.fetchStatus.textContent = 'Please enter a YouTube URL';
    return;
  }

  if (!videoInfo) {
    els.fetchStatus.textContent = 'Please fetch video info first';
    return;
  }

  els.saveBtn.disabled = true;
  els.saveBtn.textContent = 'Processing...';

  if (editingId) {
    const idx = soundboard.findIndex((s) => s.id === editingId);
    if (idx === -1) return;

    const old = soundboard[idx];
    const needsReprocess =
      old.youtubeUrl !== youtubeUrl || old.startSec !== startSec || old.endSec !== endSec;

    if (needsReprocess) {
      try {
        const oldId = editingId;
        const newId = await processSound(youtubeUrl, startSec, endSec);
        revokeBlobUrl(oldId);
        await deleteAudioFromDB(oldId);
        soundboard[idx] = { id: newId, youtubeUrl, startSec, endSec, label, emoji, bgColor, textColor };
      } catch (err) {
        els.fetchStatus.textContent = 'Error: ' + err.message;
        els.saveBtn.disabled = false;
        els.saveBtn.textContent = 'Update';
        return;
      }
    } else {
      soundboard[idx] = { ...old, label, emoji, bgColor, textColor };
    }
  } else {
    try {
      const newId = await processSound(youtubeUrl, startSec, endSec);
      soundboard.push({ id: newId, youtubeUrl, startSec, endSec, label, emoji, bgColor, textColor });
    } catch (err) {
      els.fetchStatus.textContent = 'Error: ' + err.message;
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = 'Add to Soundboard';
      return;
    }
  }

  saveState();
  render();
  closeModal();
}

async function deleteSound(id) {
  if (!confirm('Delete this sound?')) return;
  revokeBlobUrl(id);
  await deleteAudioFromDB(id);
  soundboard = soundboard.filter((s) => s.id !== id);
  saveState();
  render();
}

function moveSound(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= soundboard.length) return;
  [soundboard[i], soundboard[j]] = [soundboard[j], soundboard[i]];
  saveState();
  render();
}

els.polyToggle.addEventListener('change', () => {
  polyphonic = els.polyToggle.checked;
  saveState();
});

els.addBtn.addEventListener('click', () => openModal(null));
els.closeBtn.addEventListener('click', closeModal);

els.fetchBtn.addEventListener('click', () => {
  const url = els.youtubeUrl.value.trim();
  if (url) fetchVideoInfo(url);
});

els.youtubeUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.fetchBtn.click();
});

els.startSlider.addEventListener('input', updateSliderDisplays);
els.endSlider.addEventListener('input', updateSliderDisplays);

els.saveBtn.addEventListener('click', saveSound);

els.modal.querySelector('.modal-overlay').addEventListener('click', closeModal);

document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const { action, i } = actionEl.dataset;
  const idx = parseInt(i);
  if (isNaN(idx)) return;

  switch (action) {
    case 'edit':
      openModal(soundboard[idx]);
      break;
    case 'delete':
      deleteSound(soundboard[idx].id);
      break;
    case 'up':
      moveSound(idx, -1);
      break;
    case 'down':
      moveSound(idx, 1);
      break;
  }
});

const wakeOverlay = $('#wakeOverlay');
const wakeBar = $('#wakeBarFill');

async function waitForServer() {
  let elapsed = 0;
  while (true) {
    try {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), 4000);
      await fetch('/api/health', { signal: ctrl.signal });
      clearTimeout(id);
      return;
    } catch {
      elapsed += 2;
      wakeBar.style.width = Math.min((elapsed / 60) * 100, 90) + '%';
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

(async () => {
  if (!navigator.onLine) {
    wakeOverlay.classList.add('hidden');
    loadState();
    render();
    return;
  }
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(id);
    wakeOverlay.classList.add('hidden');
  } catch {
    clearTimeout(id);
    await waitForServer();
    wakeOverlay.classList.add('hidden');
  }
  loadState();
  render();
})();
