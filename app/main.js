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
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');

// The published site is the one address we control and can refresh at any time, so it doubles as the
// announcement board: version.json says what the newest code hash is, and the code pack that carries it is
// 169 KB instead of the 137 MB a fresh install needs. Read over https, once, at startup, and treated as
// data only - the app never runs anything it finds there, never downloads by itself, and says nothing at
// all when the machine has no network, because running with no network is the reason it exists.
const VERSION_URL = process.env.FC_VERSION_URL ||
  'https://focuschangeai-pc-fibfycas7he.qoder.website/version.json';

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
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      // The page asks its own origin, so a browser tab on the published site never reaches this and a
      // machine with no network gets the answer we already have instead of a failed external request.
      if (p === '/update-info') return send(res, 200, JSON.stringify(updateInfo), TYPES['.json']);
      serveFile(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function sha256File(target) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(target);
    s.on('error', () => resolve(null));
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function readJsonSafe(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    return null;
  }
}

function getJson(url, ms) {
  return new Promise((resolve) => {
    // http is only ever reached through FC_VERSION_URL, which exists so the notice can be proved against
    // a local server; the shipped default is the https site.
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { timeout: ms }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 200000) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// status: checking | current | code | model | offline | unknown
let updateInfo = { status: 'checking' };

async function checkForUpdate() {
  const local = readJsonSafe(path.join(DIST, 'BUILD.json'));
  const remote = await getJson(VERSION_URL, 6000);
  dlog('update: remote=' + JSON.stringify(remote) + ' local=' + JSON.stringify(local));
  if (!remote || !remote.code || !remote.pack || !remote.pack.url) return (updateInfo = { status: 'offline' });
  // An install built before stamps existed cannot be compared, and guessing would be worse than silence.
  if (!local || !local.code) return (updateInfo = { status: 'unknown' });
  // The pack is described by the release it comes from, so the page can say WHICH build a download lands on
  // instead of only what it costs. builtAt and code are copied out of the hosted version.json, never measured
  // here, so a stale cache cannot make the notice claim a newer build than the file it is about to hand over.
  const pack = { url: remote.pack.url, bytes: remote.pack.bytes, builtAt: remote.builtAt || '', code: remote.code };
  // The whole archive, when the site bothers to describe it. A machine that never installed anything, or
  // whose model no longer matches, cannot be repaired by a code pack, so it has to be told the real price
  // of a fresh copy instead of being offered a 171 KB file that would leave it broken.
  const full = remote.full && remote.full.bytes ?
    { bytes: remote.full.bytes, sha256: remote.full.sha256, url: remote.full.url || '' } : null;
  // code is index.html alone, so a fix that only touches js/*.mjs would look current forever. files hashes
  // every module beside it, and both have to agree before this machine is called up to date.
  if (local.code === remote.code && local.files === remote.files) return (updateInfo = { status: 'current', full });
  const model = await sha256File(path.join(DIST, 'yolo11n.onnx'));
  updateInfo = {
    // A machine whose model differs cannot be fixed by the code pack, so it gets told to take a whole
    // fresh copy rather than being handed a half-update it has to discover later.
    status: model && remote.model && model === remote.model ? 'code' : 'model',
    pack,
    full,
    // The machine's own stamp, so the row can name both ends of the jump and be checked by eye.
    from: local.code,
    fromBuiltAt: local.builtAt || '',
    dir: __dirname,
  };
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

  // Started, not awaited: the window must come up at once, and /update-info replies "checking" until this
  // lands, which the page retries for a few seconds.
  checkForUpdate()
    .then(() => dlog('update status=' + updateInfo.status + ' url=' + VERSION_URL))
    .catch((e) => {
      updateInfo = { status: 'offline' };
      dlog('update threw: ' + e.message);
    });

  await createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => app.quit());
