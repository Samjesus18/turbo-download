// offscreen.js
const MIN_CHUNK_SIZE = 256 * 1024; // 256 KB mínimo por chunk

/* ---------- Comprobar soporte de Range ---------- */
async function probeRanges(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-0' }
    });
    const accept = res.headers.get('accept-ranges');
    const range = res.headers.get('content-range'); // "bytes 0-0/12345"
    if (res.status === 206 && range) {
      const total = parseInt(range.split('/').pop(), 10);
      if (!isNaN(total) && total > 0) {
        // Cancelar el cuerpo por si acaso
        res.body?.cancel?.();
        return { supported: true, total };
      }
    }
    res.body?.cancel?.();
  } catch (e) {
    console.warn('[Turbo] probeRanges falló:', e);
  }
  return { supported: false, total: 0 };
}

/* ---------- Descarga de una sola conexión ---------- */
async function singleConnectionDownload(url, filename, downloadId) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const parts = [];
  let downloaded = 0;
  const t0 = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    downloaded += value.length;
    const elapsed = (Date.now() - t0) / 1000;
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PROGRESS',
      downloadId,
      downloaded,
      total: total || downloaded,
      speed: elapsed > 0 ? downloaded / elapsed : 0
    }).catch(() => {});
  }

  const blob = new Blob(parts);
  const blobUrl = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_DONE',
    downloadId,
    blobUrl,
    filename
  });
}

/* ---------- Descarga multi-hilo ---------- */
async function multiConnectionDownload(url, filename, connections, total, downloadId) {
  const chunkSize = Math.max(MIN_CHUNK_SIZE, Math.ceil(total / connections));
  const actualConnections = Math.ceil(total / chunkSize);
  const chunks = new Array(actualConnections);
  let downloaded = 0;
  const t0 = Date.now();

  const tasks = [];
  for (let i = 0; i < actualConnections; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, total - 1);
    if (start > end) continue;

    tasks.push((async () => {
      const res = await fetch(url, {
        headers: { 'Range': `bytes=${start}-${end}` }
      });
      if (res.status !== 206) {
        throw new Error(`El servidor no soporta Range (status ${res.status})`);
      }
      const reader = res.body.getReader();
      const parts = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        downloaded += value.length;
        const elapsed = (Date.now() - t0) / 1000;
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_PROGRESS',
          downloadId,
          downloaded,
          total,
          speed: elapsed > 0 ? downloaded / elapsed : 0
        }).catch(() => {});
      }
      chunks[i] = new Blob(parts);
    })());
  }

  await Promise.all(tasks);
  const finalBlob = new Blob(chunks);
  const blobUrl = URL.createObjectURL(finalBlob);
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_DONE',
    downloadId,
    blobUrl,
    filename
  });
}

/* ---------- Orquestador ---------- */
async function startDownload({ url, filename, connections, downloadId }) {
  const { supported, total } = await probeRanges(url);

  if (supported && total > MIN_CHUNK_SIZE * 2) {
    await multiConnectionDownload(url, filename, connections, total, downloadId);
  } else {
    await singleConnectionDownload(url, filename, downloadId);
  }
}

/* ---------- Listener ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'START_ACCELERATED') {
    sendResponse({ started: true });
    startDownload(msg).catch(err => {
      console.error('[Turbo] Error:', err);
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        downloadId: msg.downloadId,
        error: err.message || String(err)
      }).catch(() => {});
    });
    return true;
  }
});