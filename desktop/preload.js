// Runs in the sandboxed preload context. Exposes a tiny, explicit API to the React app.
const { contextBridge, ipcRenderer } = require('electron')

const cfg = ipcRenderer.sendSync('vision:config') // { apiBase, apiToken, platform }

contextBridge.exposeInMainWorld('visionDesktop', {
  isDesktop: true,
  platform: cfg.platform,
  apiBase: cfg.apiBase, // '' = same origin (local backend serves the UI); otherwise the remote backend URL
  apiToken: cfg.apiToken,
  // Called by the menu item / shortcut "Stop camera & microphone".
  onStopAll(cb) {
    const handler = () => cb()
    ipcRenderer.on('vision:stop-all', handler)
    return () => ipcRenderer.removeListener('vision:stop-all', handler)
  },
  restartBackend: () => ipcRenderer.invoke('vision:restart-backend'),
})
