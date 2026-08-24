import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, globalShortcut, Menu, session, shell, Tray } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { cleanupIpcHandlers, initializeIpcHandlers } from './ipc/handlers'
import { installMainProcessLogCapture, setTerminalLogWindow } from './services/terminalLog'

// Keep normal console output intact while making safe, structured copies available to the UI.
installMainProcessLogCapture()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showMainWindow()
  }
}

function createTray(): void {
  tray = new Tray(icon)
  tray.setToolTip('Interview Copilot — Alt+Z to show or hide')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Interview Copilot', click: showMainWindow },
      { label: 'Hide Interview Copilot', click: () => mainWindow?.hide() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', toggleMainWindow)
}

function createWindow(): void {
  // Create the browser window with screen share protection
  mainWindow = new BrowserWindow({
    width: 620,
    height: 880,
    minWidth: 380,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    frame: false, // Frameless for custom title bar
    transparent: false,
    alwaysOnTop: true, // Stay on top by default
    // The app is controlled from Alt+Z or the system tray, not the taskbar.
    skipTaskbar: true,
    resizable: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setTerminalLogWindow(mainWindow)

  // Enable screen share protection - hides window from screen capture
  mainWindow.setContentProtection(true)

  // Set window to be excluded from screen capture on Windows
  if (process.platform === 'win32') {
    mainWindow.setContentProtection(true)
  }

  mainWindow.on('ready-to-show', () => {
    showMainWindow()
  })

  // Closing or minimizing keeps the interview session alive in the tray.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Initialize IPC handlers
  initializeIpcHandlers(mainWindow)

  // Grant microphone permissions
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'audioCapture']
    if (allowedPermissions.includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  // HMR for renderer base on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.interview-copilot')

  // Default open or close DevTools by F12 in development
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  createTray()

  // Global means this works even when the app window is not focused.
  globalShortcut.register('Alt+Z', toggleMainWindow)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  setTerminalLogWindow(null)
  cleanupIpcHandlers()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Cleanup on quit
app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  cleanupIpcHandlers()
})
