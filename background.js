// background.js
const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null;

/* ---------- Estado de auto-interceptación ---------- */
let autoIntercept = false;

// Cargar al arrancar
chrome.storage.local.get(['autoIntercept']).then(r => {
  autoIntercept = r.autoIntercept === true;
});

// Reaccionar a cambios desde el popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoIntercept) {
    autoIntercept = changes.autoIntercept.newValue === true;
  }
});

/* ---------- Gestión del offscreen document ---------- */
async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    if (ctxs.length > 0) return;
  }
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: 'Realizar descargas multi-hilo y construir Blobs grandes.'
  });
  try {
    await creatingOffscreen;
  } catch (e) {
    /* Ya existe */
  }
  creatingOffscreen = null;
}

/* ---------- Utilidades ---------- */
function guessFilename(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'descarga';
  } catch {
    return 'descarga';
  }
}

function basename(path) {
  if (!path) return null;
  return path.split(/[\\/]/).pop();
}

/* ---------- Iniciar descarga acelerada ---------- */
async function startAcceleratedDownload({ url, filename, connections }) {
  await ensureOffscreen();
  const downloadId = crypto.randomUUID();
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_ACCELERATED',
    url,
    filename: filename || guessFilename(url),
    connections: Math.max(1, Math.min(16, connections || 8)),
    downloadId
  });
  return { downloadId };
}

/* ---------- 🔥 AUTO-INTERCEPTAR DESCARGAS DEL NAVEGADOR ---------- */
chrome.downloads.onCreated.addListener(async (item) => {
  if (!autoIntercept) return;

  // Ignorar descargas creadas por nuestra propia extensión (blob final)
  if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) return;

  const url = item.finalUrl || item.url;
  if (!url) return;

  // Ignorar blob:/data: (son las nuestras) y esquemas no http(s)
  if (url.startsWith('blob:') || url.startsWith('data:')) return;
  if (!/^https?:/i.test(url)) return;

  // Cancelar y borrar la descarga nativa
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (e) {
    console.warn('[Turbo] No se pudo cancelar la descarga:', e);
    return;
  }

  // Notificar al popup si está abierto
  chrome.runtime.sendMessage({
    type: 'AUTO_INTERCEPTED',
    url
  }).catch(() => {});

  // Badge de feedback
  try {
    chrome.action.setBadgeText({ text: '⚡' });
    chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
  } catch {}

  // Relanzar por el motor acelerado
  const filename = basename(item.filename) || guessFilename(url);
  startAcceleratedDownload({
    url,
    filename,
    connections: 8
  }).catch(err => {
    console.error('[Turbo] Error al acelerar descarga interceptada:', err);
  });
});

/* ---------- Mensajería ---------- */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignorar mensajes dirigidos al offscreen
  if (message.target === 'offscreen') return;

  if (message.type === 'START') {
    startAcceleratedDownload(message)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'OFFSCREEN_PROGRESS') {
    chrome.runtime.sendMessage({
      type: 'PROGRESS',
      downloadId: message.downloadId,
      downloaded: message.downloaded,
      total: message.total,
      speed: message.speed
    }).catch(() => {});
    return;
  }

  if (message.type === 'OFFSCREEN_DONE') {
    chrome.downloads.download(
      {
        url: message.blobUrl,
        filename: message.filename || undefined,
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[Turbo] Error al guardar:', chrome.runtime.lastError.message);
        }
      }
    );
    chrome.runtime.sendMessage({
      type: 'DONE',
      downloadId: message.downloadId
    }).catch(() => {});
    return;
  }

  if (message.type === 'OFFSCREEN_ERROR') {
    chrome.runtime.sendMessage({
      type: 'ERROR',
      downloadId: message.downloadId,
      error: message.error
    }).catch(() => {});
    return;
  }
});

/* ---------- Menú contextual ---------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'turbo-download-link',
    title: '⚡ Descargar con Turbo Download',
    contexts: ['link']
  });
  // Valor por defecto: desactivado
  chrome.storage.local.get(['autoIntercept']).then(r => {
    if (r.autoIntercept === undefined) {
      chrome.storage.local.set({ autoIntercept: false });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'turbo-download-link' && info.linkUrl) {
    startAcceleratedDownload({
      url: info.linkUrl,
      filename: guessFilename(info.linkUrl),
      connections: 8
    });
  }
});