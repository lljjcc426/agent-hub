const { app, BrowserWindow, dialog, Menu, shell } = require('electron')

const workspace = new URL('http://127.0.0.1:4337/chat')
let mainWindow
let ready = false

function isWorkspace(url) {
  if (!URL.canParse(url)) return false
  const target = new URL(url)
  return target.protocol === workspace.protocol && target.origin === workspace.origin &&
    !target.username && !target.password
}

function openWebLink(url) {
  if (URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)) {
    void shell.openExternal(url).catch(error => console.error('Unable to open link:', error.message))
  }
}

function setNavigation(contents) {
  contents.on('will-navigate', event => {
    if (isWorkspace(event.url)) return
    event.preventDefault()
    openWebLink(event.url)
  })
  contents.on('will-redirect', event => {
    if (event.isMainFrame && !isWorkspace(event.url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (isWorkspace(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { ...windowOptions(), show: true } }
    }
    openWebLink(url)
    return { action: 'deny' }
  })
}

function windowOptions() {
  return {
    title: 'Roppo',
    width: 1280,
    height: 840,
    backgroundColor: '#ffffff',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  }
}

function openWorkspace() {
  if (!ready) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }

  const win = new BrowserWindow(windowOptions())
  mainWindow = win
  win.on('closed', () => { mainWindow = undefined })
  const contents = win.webContents
  let showingError = false
  contents.on('did-fail-load', async (_event, code, _description, url, mainFrame) => {
    if (!mainFrame || !isWorkspace(url) || code === -3 || showingError || win.isDestroyed()) return
    showingError = true
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message: '暂时无法连接本地 AgentHub',
        detail: workspace.origin, buttons: ['重试', '关闭窗口'], defaultId: 0, cancelId: 1
      })
      if (!win.isDestroyed()) {
        if (response === 0) void win.loadURL(url).catch(() => {})
        else win.close()
      }
    } finally {
      showingError = false
    }
  })
  // Navigation failures are reported by did-fail-load, including reloads.
  void win.loadURL(workspace.href).catch(() => {})
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') setNavigation(contents)
  })
  app.on('second-instance', openWorkspace)
  app.on('activate', openWorkspace)
  app.on('window-all-closed', () => { /* On macOS the Dock can reopen the window. */ })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: '显示', submenu: [
        { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' },
        { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }
      ] },
      { role: 'windowMenu' }
    ]))
    ready = true
    openWorkspace()
  })
}
