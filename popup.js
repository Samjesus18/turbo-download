// popup.js
const $ = id => document.getElementById(id);
let currentDownloadId = null;

/* ---------- Slider de conexiones ---------- */
$('connections').addEventListener('input', e => {
  $('connVal').textContent = e.target.value;
});

/* ---------- Toggle auto-interceptar ---------- */
async function loadAutoState() {
  const { autoIntercept = false } = await chrome.storage.local.get('autoIntercept');
  updateAutoUI(autoIntercept);
}

function updateAutoUI(enabled) {
  const box = $('autoBox');
  if (enabled) {
    box.classList.add('active');
    $('autoHint').textContent = 'Activado — las descargas se aceleran solas';
  } else {
    box.classList.remove('active');
    $('autoHint').textContent = 'Las descargas del navegador se acelerarán automáticamente';
  }
}

$('autoBox').addEventListener('click', async () => {
  const { autoIntercept = false } = await chrome.storage.local.get('autoIntercept');
  const newVal = !autoIntercept;
  await chrome.storage.local.set({ autoIntercept: newVal });
  updateAutoUI(newVal);
});

/* ---------- Formateadores ---------- */
function formatBytes(b) {
  if (!b || b < 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(2) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
const formatSpeed = bps => formatBytes(bps) + '/s';

function setStatus(txt) { $('status').textContent = txt; }

/* ---------- Iniciar descarga manual ---------- */
$('start').addEventListener('click', async () => {
  const url = $('url').value.trim();
  if (!url) { setStatus('⚠️ Introduce una URL'); return; }

  const filename = $('filename').value.trim();
  const connections = parseInt($('connections').value, 10);

  $('start').disabled = true;
  $('progressWrap').classList.remove('hidden');
  $('bar').style.width = '0%';
  $('pct').textContent = '0%';
  $('speed').textContent = '0 B/s';
  $('size').textContent = '';
  setStatus('Conectando con el servidor...');

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'START', url, filename, connections
    });
    if (res?.error) throw new Error(res.error);
    currentDownloadId = res.downloadId;
    setStatus('Descargando...');
  } catch (e) {
    setStatus('❌ ' + (e.message || 'Error'));
    $('start').disabled = false;
  }
});

/* ---------- Escuchar eventos ---------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === 'offscreen') return;

  /* Cuando el auto-intercept captura una descarga del navegador */
  if (msg.type === 'AUTO_INTERCEPTED') {
    $('progressWrap').classList.remove('hidden');
    $('bar').style.width = '0%';
    $('pct').textContent = '0%';
    $('speed').textContent = '0 B/s';
    $('size').textContent = '';
    const shortUrl = msg.url.length > 40 ? msg.url.slice(0, 37) + '…' : msg.url;
    setStatus('⚡ Interceptada: ' + shortUrl);
    return;
  }

  if (!currentDownloadId) return;
  if (msg.downloadId && msg.downloadId !== currentDownloadId) return;

  if (msg.type === 'PROGRESS') {
    const pct = msg.total > 0 ? (msg.downloaded / msg.total) * 100 : 0;
    $('bar').style.width = pct.toFixed(1) + '%';
    $('pct').textContent = pct.toFixed(1) + '%';
    $('speed').textContent = formatSpeed(msg.speed);
    $('size').textContent =
      `${formatBytes(msg.downloaded)} / ${formatBytes(msg.total)}`;
  }

  if (msg.type === 'DONE') {
    setStatus('✅ Guardando archivo...');
    $('bar').style.width = '100%';
    $('pct').textContent = '100%';
    setTimeout(() => {
      setStatus('🎉 ¡Descarga completada!');
      $('start').disabled = false;
    }, 400);
  }

  if (msg.type === 'ERROR') {
    setStatus('❌ ' + msg.error);
    $('start').disabled = false;
  }
});

/* ---------- Init ---------- */
loadAutoState();