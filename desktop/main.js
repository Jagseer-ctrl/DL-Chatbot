// VISION desktop shell.
//
// Local mode  (default): spawns the Flask backend on 127.0.0.1, waits until it is healthy, and loads the UI
//                        from that same server (one origin, camera/mic allowed because localhost is a secure context).
// Remote mode (VISION_REMOTE_BACKEND=https://...): no Python needed; serves frontend/dist from a tiny local
//                        static server and sends API calls to the remote backend.
// Dev mode    (--dev):   loads the Vite dev server (http://127.0.0.1:5173) against the local backend.
//
// Lifecycle: the backend is started at launch and always stopped when the app quits or the window closes, so no
// orphaned Python process (and no open camera/microphone) outlives the app.
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, systemPreferences } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')

const DEV = process.argv.includes('--dev')
const RES = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(RES, 'backend')
const DIST = path.join(RES, 'frontend', 'dist')
const REMOTE = (process.env.VISION_REMOTE_BACKEND || '').replace(/\/$/, '')
const API_TOKEN = process.env.VISION_API_TOKEN || ''
const DEV_URL = process.env.VISION_DEV_URL || 'http://127.0.0.1:5173'
const STATIC_PORT = Number(process.env.VISION_STATIC_PORT || 5174)

let win = null
let backend = null
let backendLog = []
let staticServer = null
let quitting = false
let appOrigin = ''
let apiBase = ''

// ------------------------------------------------------------------ helpers
const freePort = (preferred) =>
  new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer()
      s.once('error', () => (p === 0 ? resolve(preferred) : tryPort(0)))
      s.once('listening', () => {
        const port = s.address().port
        s.close(() => resolve(port))
      })
      s.listen(p, '127.0.0.1')
    }
    tryPort(preferred)
  })

function findPython() {
  const exe = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const candidates = [
    process.env.VISION_PYTHON,
    path.join(BACKEND_DIR, '.venv', ...exe),
    path.join(app.getPath('userData'), 'venv', ...exe),
  ].filter(Boolean)
  return candidates.find((c) => fs.existsSync(c)) || (process.platform === 'win32' ? 'python' : 'python3')
}

async function waitForBackend(base, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!backend && !REMOTE) throw new Error('The backend process exited during startup.')
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('Timed out waiting for the backend to start.')
}

function startBackend(port) {
  const py = findPython()
  backendLog = []
  const env = {
    ...process.env,
    VISION_HOST: '127.0.0.1',
    VISION_PORT: String(port),
    VISION_SERVE_FRONTEND: DIST,
    VISION_CORS_ORIGINS: `${DEV_URL},http://localhost:5173`,
    PYTHONUNBUFFERED: '1',
  }
  backend = spawn(py, ['app.py'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const keep = (d) => {
    backendLog.push(...d.toString().split('\n').filter(Boolean))
    backendLog = backendLog.slice(-60)
    if (DEV) process.stdout.write(d)
  }
  backend.stdout.on('data', keep)
  backend.stderr.on('data', keep)
  backend.on('error', (e) => {
    backendLog.push(`spawn error: ${e.message}`)
    backend = null
  })
  backend.on('exit', (code, sig) => {
    backend = null
    if (!quitting && win) {
      dialog.showErrorBox('VISION backend stopped', `Exit code ${code ?? sig}.\n\n${backendLog.slice(-12).join('\n')}`)
    }
  })
}

function stopBackend() {
  return new Promise((resolve) => {
    if (!backend) return resolve()
    const p = backend
    const killer = setTimeout(() => p.kill('SIGKILL'), 3000)
    p.once('exit', () => {
      clearTimeout(killer)
      resolve()
    })
    p.kill('SIGTERM')
  })
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
function startStaticServer() {
  return new Promise((resolve, reject) => {
    staticServer = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      let file = path.normalize(path.join(DIST, rel))
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end()
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    })
    staticServer.once('error', reject)
    staticServer.listen(STATIC_PORT, '127.0.0.1', resolve)
  })
}

// ------------------------------------------------------------------ permissions (camera / microphone)
function setupPermissions() {
  const ours = (url) => {
    try {
      return new URL(url).origin === appOrigin
    } catch {
      return false
    }
  }
  session.defaultSession.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (permission !== 'media' || !ours(details.requestingUrl)) return callback(false)
    if (process.platform === 'darwin') {
      // Ask macOS for camera and microphone separately, exactly for the device(s) the page requested.
      for (const t of details.mediaTypes || []) {
        const kind = t === 'video' ? 'camera' : 'microphone'
        if (systemPreferences.getMediaAccessStatus(kind) !== 'granted') {
          if (!(await systemPreferences.askForMediaAccess(kind))) return callback(false)
        }
      }
    }
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && ours(origin))
}

// ------------------------------------------------------------------ window + menu
function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: '#0a0e1d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('https://')) shell.openExternal(u)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, u) => {
    if (new URL(u).origin !== appOrigin) e.preventDefault()
  })
  win.on('closed', () => {
    win = null
    app.quit() // closing the window shuts everything down, including the backend
  })
  win.loadURL(url)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'VISION',
      submenu: [
        { label: 'Stop Camera & Microphone', accelerator: 'CmdOrCtrl+Shift+.', click: () => win?.webContents.send('vision:stop-all') },
        { label: 'Restart Backend', click: () => restartBackend() },
        { type: 'separator' },
        { label: 'Show Backend Log', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Backend log', message: 'Last backend output', detail: backendLog.slice(-25).join('\n') || '(empty)' }) },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function restartBackend() {
  if (REMOTE) return false
  win?.webContents.send('vision:stop-all')
  await stopBackend()
  const port = Number(new URL(appOrigin || 'http://127.0.0.1:5001').port) || 5001
  startBackend(DEV ? Number(new URL(apiBase).port) : port)
  try {
    await waitForBackend(DEV ? apiBase : appOrigin)
    win?.reload()
    return true
  } catch (e) {
    dialog.showErrorBox('Backend failed to restart', `${e.message}\n\n${backendLog.slice(-12).join('\n')}`)
    return false
  }
}

// ------------------------------------------------------------------ startup
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  ipcMain.on('vision:config', (e) => {
    e.returnValue = { apiBase, apiToken: API_TOKEN, platform: process.platform }
  })
  ipcMain.handle('vision:restart-backend', () => restartBackend())

  app.whenReady().then(async () => {
    try {
      let url
      if (REMOTE) {
        await startStaticServer()
        appOrigin = `http://127.0.0.1:${STATIC_PORT}`
        apiBase = REMOTE
        url = appOrigin // remember: add this origin to the remote backend's VISION_CORS_ORIGINS
      } else {
        const port = await freePort(Number(process.env.VISION_PORT || 5001))
        startBackend(port)
        const base = `http://127.0.0.1:${port}`
        await waitForBackend(base)
        if (DEV) {
          appOrigin = new URL(DEV_URL).origin
          apiBase = base
          url = DEV_URL
        } else {
          appOrigin = base
          apiBase = '' // same origin
          url = base
        }
      }
      setupPermissions()
      buildMenu()
      createWindow(url)
    } catch (e) {
      dialog.showErrorBox(
        'VISION could not start',
        `${e.message}\n\n${backendLog.slice(-15).join('\n')}\n\nHave you run scripts/setup_mac.sh (creates backend/.venv)?`,
      )
      app.quit()
    }
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    if (backend) {
      e.preventDefault()
      stopBackend().finally(() => {
        staticServer?.close()
        app.quit()
      })
    }
  })
}
