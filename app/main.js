// FocusChangeAI PC - standalone app entry point.
//
// Why a local HTTP server instead of loadFile('dist/index.html'): the page is a set of ES modules and
// calls getUserMedia, and file:// gives neither (modules are blocked by CORS, and a file origin is not a
// secure context, so the camera refuses). Serving over 127.0.0.1 keeps the exact same origin rules the
// published site and Chay-Webcam-PC.bat already satisfy, so the shipped code in dist/ runs unmodified.
// The port is chosen by the OS (port 0) so a second copy, or the launcher already using 8731, cannot
// collide with us.

const { app, BrowserWindow, session, shell, systemPreferences } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');

// Measured in this app: with the window behind another one the HUD dropped from 17 FPS to 0, because
// Chromium throttles requestAnimationFrame for occluded/background windows. A classroom tool must keep
// watching while the teacher checks a spreadsheet, and a run silently measured at 0 FPS is worse than a
// slow one - it is a wrong number in the record.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// FC_DEBUG=1 writes one line per permission request. Without it the shipped app logs nothing.
const DEBUG_LOG = process.env.FC_DEBUG ? path.join(app.getPath('userData'), 'perm.log') : null;
function dlog(msg) {
  if (!DEBUG_LOG) return;
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {
    /* logging must never break the app */
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = clean === '/' || clean === '' ? 'index.html' : clean.replace(/^\/+/, '');
  const abs = path.resolve(DIST, rel);
  if (abs !== DIST && !abs.startsWith(DIST + path.sep)) return null;
  return abs;
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function serveFile(req, res) {
  const abs = resolveSafe(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!abs) return send(res, 403, 'forbidden');
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      serveFile(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function createWindow(port) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'FocusChangeAI PC',
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    backgroundColor: '#fffbfe',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.FC_DEVTOOLS === '1',
    },
  });

  // One origin only: the page must never leave our server, and no window.open escape hatch.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== `http://127.0.0.1:${port}`) e.preventDefault();
  });

  // Downloads (a run export) should land in the user's Downloads folder like any other app, not open a
  // browser.
  win.webContents.session.on('will-download', (e, item) => {
    const dir = app.getPath('downloads');
    const base = path.basename(item.getFilename() || 'focuschangeai-download');
    let target = path.join(dir, base);
    let n = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(base);
      target = path.join(dir, `${path.basename(base, ext)} (${n})${ext}`);
      n += 1;
    }
    item.setSavePath(target);
    item.once('done', (ev, state) => {
      if (state === 'completed') shell.showItemInFolder(target);
    });
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

app.whenReady().then(async () => {
  const server = await startServer();
  const { port } = server.address();

  dlog('server port=' + port + ' cameraAccessStatus=' + (() => {
    try {
      return systemPreferences.getMediaAccessStatus('camera');
    } catch (e) {
      return 'throw:' + e.message;
    }
  })());

  // The camera is the product: a school PC that pops an OS prompt every launch is a demo that stalls.
  // Measured on Electron 33: details.requestingOrigin is undefined for a media request, so trusting it
  // silently denied our own page (NotAllowedError "Permission denied" while Windows reported
  // cameraAccessStatus=granted). The webContents' own URL is the reliable handle, and it still limits
  // the grant to this app's loopback origin.
  const ourOrigin = `http://127.0.0.1:${port}`;
  const sameOrigin = (wc) => {
    try {
      return new URL(wc.getURL()).origin === ourOrigin;
    } catch (e) {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const own = sameOrigin(wc);
    dlog(
      'request permission=' + permission + ' own=' + own + ' detailKeys=' +
      JSON.stringify(Object.keys(details || {})) + ' url=' + (() => { try { return wc.getURL(); } catch (e) { return '?'; } })(),
    );
    callback(permission === 'media' && own);
  });
  session.defaultSession.on('permission-check-complete', (e, permission, status) => {
    dlog('check permission=' + permission + ' status=' + status);
  });

  await createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => app.quit());
