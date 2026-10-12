import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { migrateUserData, preserveLegacyUserDataPath } from './services/brand-migration'
import { loadShellPath } from './services/binaries'
import { stopGame } from './services/game'
import { closeSceneEditor, sceneEditorMustCloseBeforeWindow } from './services/scene-editor'
import { shutdownChat } from './services/opencode'
import { cancelProduction } from './services/production-workflow'
import { cancelProjectValidations } from './services/project-validation'
import { flushAgentMetrics } from './services/agent-run-metrics'
import { ensureOpencodeConfig } from './services/opencode-config'
import { startTestHarness, stopTestHarness } from './services/test-harness'
import { loadSettings } from './state'
import { sendToRenderer, setMainWindow } from './window'

// Keep existing installs on the original profile so Electron safeStorage can
// still decrypt credentials encrypted before the Solar rebrand.
app.setName('Solar')
preserveLegacyUserDataPath()

function shutdownTrace(message: string): void {
  if (process.env.SOLAR_SHUTDOWN_DIAGNOSTICS === '1') console.log(`[solar] shutdown: ${message}`)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#08090e',
    title: 'Solar',
    // Frameless-style titlebar on macOS for a modern, engine-like look.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      // Renderer stays sandboxed (the Electron default): the preload only
      // uses contextBridge/ipcRenderer/webUtils, which sandboxed preloads support.
      preload: join(__dirname, '../preload/index.js')
    }
  })

  setMainWindow(win)
  win.on('ready-to-show', () => win.show())
  let closeAfterScene = false
  win.on('close', (event) => {
    shutdownTrace(`window close; editor pending=${sceneEditorMustCloseBeforeWindow()}`)
    if (closeAfterScene || !sceneEditorMustCloseBeforeWindow()) return
    event.preventDefault()
    void cancelProduction().then(() => closeSceneEditor()).then(() => {
      closeAfterScene = true
      if (!win.isDestroyed()) win.close()
    }).catch((error) => {
      console.error('[solar] scene editor could not close:', error)
    })
  })

  // The macOS traffic lights (hiddenInset title bar) disappear in native
  // fullscreen — the renderer needs to know so it can collapse the padding
  // it otherwise reserves for them (see `.mac .titlebar` in global.css).
  win.on('enter-full-screen', () => sendToRenderer('window:fullscreenChange', true))
  win.on('leave-full-screen', () => sendToRenderer('window:fullscreenChange', false))

  // Any external link (e.g. opencode.ai in error hints) opens in the browser.
  // Web URLs only, matching the will-navigate handler below: openExternal on
  // other schemes (file:, app-registered protocols) can launch local apps.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Plain <a href> clicks (e.g. links in the chat's rendered markdown) don't
  // go through the window-open handler — they navigate this window, which
  // would replace the whole app UI. Block that and hand external URLs to the
  // OS default browser instead. Same-URL navigations (dev-server reloads)
  // stay allowed.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  if (!app.isPackaged) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log('[renderer]', message)
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await migrateUserData()
  await loadShellPath()
  loadSettings()
  // Before any chat server starts: OpenCode reads its config at boot.
  await ensureOpencodeConfig()
  startTestHarness()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quittingAfterGodot = false
let godotClosedForQuit = false
app.on('before-quit', (event) => {
  shutdownTrace(`before quit; cleanup complete=${godotClosedForQuit}`)
  if (!godotClosedForQuit) {
    event.preventDefault()
    if (!quittingAfterGodot) {
      quittingAfterGodot = true
      shutdownChat()
      stopGame()
      stopTestHarness()
      shutdownTrace('chat, game and tool server stopped; cancelling workflows/validation')
      // Keep the authenticated editor alive until its owned runtime has stopped.
      void Promise.allSettled([cancelProduction(), cancelProjectValidations()]).then(async (results) => {
        shutdownTrace('workflows/validation cancelled; closing editor and flushing metrics')
        for (const result of results) if (result.status === 'rejected') console.warn('[solar] shutdown cleanup failed:', result.reason)
        const closed = await Promise.allSettled([closeSceneEditor(), flushAgentMetrics()])
        shutdownTrace('editor closed and metrics flushed')
        for (const result of closed) if (result.status === 'rejected') console.warn('[solar] shutdown cleanup failed:', result.reason)
      }).finally(() => {
        godotClosedForQuit = true
        shutdownTrace('requesting final quit')
        app.quit()
      })
    }
    return
  }
  // Don't leave orphaned godot/opencode processes behind.
  stopGame()
  shutdownChat()
  stopTestHarness()
})

app.on('window-all-closed', () => {
  shutdownTrace('all windows closed')
  app.quit()
})
app.on('will-quit', () => shutdownTrace('will quit'))
app.on('quit', () => shutdownTrace('quit'))
