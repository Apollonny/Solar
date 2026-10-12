import { app, screen, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SceneEditorAction, SceneEditorState, StageRect } from '../../shared/types'
import { getMainWindow, sendToRenderer } from '../window'
import { resolveEmbeddedGodot, resolveGodot } from './binaries'
import { libGodotAvailable, startLibGodotEditor, type LibGodotSession } from './libgodot-host'
import { stopGame } from './game'
import { createWinHost, windowHandleArg, type WinHost } from './winhost'

// Godot's editor viewport is hosted in Solar's scene area. LibGodot creates
// its HWND as a Solar child; the standalone executable remains a recovery
// backend. This never touches the game embed session or project settings.
let state: SceneEditorState = { status: 'idle' }
let processHandle: ChildProcess | null = null
let processClosing: Promise<void> | null = null
let librarySession: LibGodotSession | null = null
let libraryClosing: Promise<void> | null = null
let nativeHost: WinHost | null = null
let nativeAttached = false
let projectPath: string | null = null
let bounds: StageRect | null = null
let visible = false
let launchId = 0
let pendingLaunch: Promise<void> | null = null
let trackedWindow: BrowserWindow | null = null

class LibGodotStartError extends Error {
  constructor(error: unknown) {
    super(`LibGodot could not start: ${error instanceof Error ? error.message : String(error)}`)
    this.name = 'LibGodotStartError'
  }
}

function setState(next: SceneEditorState): void {
  state = next
  sendToRenderer('scene:state', next)
}

export function getSceneEditorState(): SceneEditorState {
  return state
}

/** Identity of the actual embedded backend, never a guessed editor process. */
export function getEmbeddedEditorIdentity(): { projectPath: string; pid: number; backend: string } | null {
  const pid = librarySession?.pid ?? processHandle?.pid
  return state.status === 'ready' && projectPath && pid ? { projectPath, pid, backend: librarySession ? 'libgodot' : 'executable' } : null
}

export function sceneEditorMustCloseBeforeWindow(): boolean {
  return processHandle !== null || processClosing !== null || librarySession !== null || libraryClosing !== null
}

function waitForProcessExit(editor: ChildProcess, forceAfterMs?: number): Promise<void> {
  if (!editor.pid || editor.exitCode !== null || editor.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let forceTimer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (forceTimer) clearTimeout(forceTimer)
      if (killTimer) clearTimeout(killTimer)
      editor.removeListener('exit', finish)
      editor.removeListener('error', finish)
      resolve()
    }
    editor.once('exit', finish)
    editor.once('error', finish)
    if (forceAfterMs !== undefined) {
      forceTimer = setTimeout(() => {
        if (editor.exitCode !== null || editor.signalCode !== null) return finish()
        try { editor.kill() } catch { return finish() }
        killTimer = setTimeout(finish, 1000)
      }, forceAfterMs)
    }
  })
}

function screenBounds(win: BrowserWindow, rect: StageRect): Electron.Rectangle {
  const content = win.getContentBounds()
  return screen.dipToScreenRect(win, {
    x: Math.round(content.x + rect.x),
    y: Math.round(content.y + rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  })
}

function updateFrame(): void {
  const win = trackedWindow ?? getMainWindow()
  if (!nativeAttached || !nativeHost || !win || !bounds || bounds.width < 2 || bounds.height < 2) return
  const rect = screenBounds(win, bounds)
  nativeHost.setFrame(rect.x, rect.y, rect.width, rect.height)
}

function untrackWindow(): void {
  trackedWindow?.removeListener('move', updateFrame)
  trackedWindow?.removeListener('resize', updateFrame)
  trackedWindow = null
}

function endSession(closeProcess: boolean): void {
  launchId++
  pendingLaunch = null
  const editor = processHandle
  const library = librarySession
  const host = nativeHost
  const wasAttached = nativeAttached
  const wasReady = state.status === 'ready'
  processHandle = null
  librarySession = null
  nativeHost = null
  nativeAttached = false
  projectPath = null
  untrackWindow()
  if (library && closeProcess) {
    // Give Godot's editor a chance to process WM_CLOSE (including its save
    // prompt) before detaching the native child window.
    if (wasReady && wasAttached) host?.requestClose()
    else {
      // Native startup can create a window before start() returns. Hide that
      // window even if the worker is stuck and the scene never became ready.
      const win = getMainWindow()
      if (!wasAttached && host && win && !win.isDestroyed() && bounds) {
        try {
          const rect = screenBounds(win, bounds)
          host.attach(win.getNativeWindowHandle(), library.pid,
            rect.x, rect.y, rect.width, rect.height, false)
        } catch (error) {
          console.warn('[solar] could not hide an unfinished Godot editor window:', error)
        }
      }
      library.forceStop()
    }
    let startupTimer: ReturnType<typeof setTimeout> | null = null
    const exited = wasReady ? library.exited : Promise.race([
      library.exited,
      new Promise<Error>((resolve) => {
        startupTimer = setTimeout(() => {
          library.abandon()
          resolve(new Error('LibGodot startup did not stop after cancellation.'))
        }, 2000)
      })
    ])
    libraryClosing = exited.then(() => {
      try { host?.setVisible(false); host?.detach() } catch (err) {
        console.warn('[solar] LibGodot scene detach failed:', err)
      }
    }).finally(() => {
      if (startupTimer) clearTimeout(startupTimer)
      libraryClosing = null
    })
  } else if (host) {
    try {
      if (closeProcess && wasReady) host.requestClose()
      else if (closeProcess) {
        host.setVisible(false)
        host.requestClose()
      }
      else {
        host.setVisible(false)
        host.detach()
      }
    } catch (err) {
      console.warn('[solar] scene window detach failed:', err)
    }
  }
  if (closeProcess && editor) {
    // WM_CLOSE may show Godot's unsaved-changes prompt. Keep the window
    // available and wait for the user to finish closing before switching.
    // A ready editor may need the user to answer a save prompt. Startup that
    // never reached ready has no useful work to preserve and must not hang
    // project switching if it has no discoverable window to receive WM_CLOSE.
    const closing = waitForProcessExit(editor, wasReady ? undefined : 2000).then(() => {
      try { host?.setVisible(false); host?.detach() } catch (err) {
        console.warn('[solar] scene window detach failed:', err)
      }
    }).finally(() => {
      if (processClosing === closing) processClosing = null
    })
    processClosing = closing
  }
  setState({ status: 'idle' })
}

export function closeSceneEditor(): Promise<void> {
  if (processHandle || librarySession || pendingLaunch) endSession(true)
  else launchId++
  return Promise.all([libraryClosing, processClosing].filter((closing): closing is Promise<void> => closing !== null))
    .then(() => undefined)
}

export function setSceneEditorBounds(rect: StageRect): void {
  if (bounds && bounds.x === rect.x && bounds.y === rect.y &&
    bounds.width === rect.width && bounds.height === rect.height) return
  bounds = rect
  updateFrame()
}

export function setSceneEditorVisible(next: boolean): void {
  visible = next
  if (nativeAttached) nativeHost?.setVisible(next)
}

/** Godot's default Windows shortcuts: 2D, 3D and distraction-free mode. */
export function sceneEditorAction(action: SceneEditorAction): void {
  if (state.status !== 'ready' || !visible || !nativeAttached || !nativeHost) {
    throw new Error('Open the 2D / 3D workspace before using scene controls.')
  }
  const ctrl = 0x11
  const shift = 0x10
  const keys = action === '2d' ? [ctrl, 0x70]
    : action === '3d' ? [ctrl, 0x71]
      : action === 'focus' ? [ctrl, shift, 0x7a]
        : null
  if (!keys) throw new Error('Unknown scene editor action.')
  if (!nativeHost.focusAndSendShortcut(keys)) {
    throw new Error('Godot could not receive the shortcut. Release held keys, click its scene view, then try again.')
  }
}

async function waitForStageBounds(id: number): Promise<StageRect | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (id !== launchId) return null
    if (bounds && bounds.width >= 2 && bounds.height >= 2) return bounds
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Solar could not measure the scene area. Switch to Game and open 2D / 3D again.')
}

async function launch(project: string, id: number): Promise<void> {
  if (process.platform !== 'win32') throw new Error('The in-app Godot scene workspace is currently available on Windows.')
  const canonical = await realpath(project)
  if (!(await stat(join(canonical, 'project.godot'))).isFile()) throw new Error('The project.godot file is missing.')
  if (id !== launchId) return

  const libBinary = process.env.SOLAR_LIBGODOT === '0' ? null : await libGodotAvailable()
  const godot = await resolveGodot()
  if (!godot) throw new Error('Godot is unavailable. Locate or reinstall the Godot engine.')
  const embeddedGodot = libBinary ? null : await resolveEmbeddedGodot()
  if (!libBinary && !embeddedGodot) {
    throw new Error('Solar\'s native child-window Godot editor is missing or damaged. Rebuild the Windows Godot binaries.')
  }
  const win = getMainWindow()
  if (!win || win.isDestroyed()) throw new Error('The Solar window is unavailable.')
  const hostHandle = windowHandleArg(win)
  try {
    nativeHost = createWinHost()
  } catch (err) {
    throw new Error(`Windows scene embedding is unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (id !== launchId) return

  // The game runner temporarily edits project settings for its test agent.
  // Stop it before opening the project in the full Godot editor.
  stopGame()
  const logDir = join(app.getPath('userData'), 'logs')
  await mkdir(logDir, { recursive: true })
  if (id !== launchId) return
  const stage = await waitForStageBounds(id)
  if (!stage || id !== launchId) return
  const rect = screenBounds(win, stage)
  const origin = nativeHost.virtualScreenOrigin()
  const logPath = join(logDir, 'godot-scene-editor.log')
  let library: LibGodotSession | null = null
  if (libBinary) {
    try {
      library = startLibGodotEditor(libBinary, canonical, godot, logPath, hostHandle, rect, origin)
    } catch (error) {
      throw new LibGodotStartError(error)
    }
  }
  const editor = !libBinary ? spawn(embeddedGodot!, [
    '--editor', '--single-window', '--path', canonical,
    '--wid', hostHandle,
    '--position', `${rect.x - origin.x},${rect.y - origin.y}`,
    '--resolution', `${rect.width}x${rect.height}`,
    '--rendering-driver', 'vulkan',
    '--log-file', logPath
  ], {
    cwd: canonical, stdio: 'ignore', windowsHide: false,
    env: {
      ...process.env,
      // LibGodot sets this override in Solar's process. The standalone editor
      // must identify itself when it launches its own helpers or projects.
      SOLAR_GODOT_HELPER_EXECUTABLE: '',
      SOLAR_GODOT_CHILD_PARENT: hostHandle
    }
  }) : null
  processHandle = editor
  librarySession = library
  projectPath = canonical

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let libraryStarted = false
    let poll: ReturnType<typeof setInterval> | null = null
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      if (err) reject(err)
      else resolve()
    }
    if (editor) {
      editor.once('error', (err) => {
        if (!settled) finish(new Error(`Godot could not start: ${err.message}`))
        else if (processHandle === editor) {
          endSession(false)
          setState({ status: 'error', message: `Godot scene editor failed: ${err.message}` })
        }
      })
      editor.once('exit', (code, signal) => {
        if (processHandle !== editor) return
        if (!settled) finish(new Error(`Godot closed before its scene window opened (code ${code ?? 'unknown'}). Log: ${logPath}`))
        else {
          endSession(false)
          if (code !== 0) {
            const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
            setState({ status: 'error', message: `Godot scene editor exited unexpectedly (${reason}). Log: ${logPath}` })
          }
        }
      })
    }
    if (library) {
      void library.ready.then(() => { libraryStarted = true }).catch(finish)
      library.onExit((error) => {
        if (librarySession !== library) return
        if (!settled) finish(error ?? new Error('LibGodot closed before its scene window opened.'))
        else {
          endSession(false)
          if (error) setState({ status: 'error', message: error.message })
        }
      })
    }
    const deadline = Date.now() + 45000
    poll = setInterval(() => {
      if (id !== launchId || (editor && processHandle !== editor) || (library && librarySession !== library)) return finish()
      if (Date.now() > deadline) return finish(new Error(`Godot's scene window did not become ready. Log: ${logPath}`))
      if (library && !libraryStarted) return
      const pid = library?.pid ?? editor?.pid
      if (!pid) return
      const stage = bounds
      if (!stage || stage.width < 2 || stage.height < 2) return
      const rect = screenBounds(win, stage)
      try {
        if (nativeHost?.attach(win.getNativeWindowHandle(), pid, rect.x, rect.y, rect.width, rect.height, visible)) {
          // Both native backends must create a child HWND from birth. An owned
          // popup would visibly lag when Solar is dragged, so never attach it.
          if (!nativeHost.isChildEmbedded()) {
            nativeHost.setVisible(false)
            throw new Error('Godot did not create the editor as a Solar child window.')
          }
          nativeAttached = true
          trackedWindow = win
          // Native parentage handles movement; only layout and resize adjust bounds.
          win.on('resize', updateFrame)
          setState({ status: 'ready', mode: 'child', backend: library ? 'libgodot' : 'executable' })
          finish()
        }
      } catch (err) {
        finish(new Error(`Could not attach the Godot scene window: ${err instanceof Error ? err.message : String(err)}`))
      }
    }, 100)
  })
}

export async function openSceneEditor(project: string): Promise<void> {
  if (state.status === 'ready' && projectPath === project) return
  if (pendingLaunch) return pendingLaunch
  const closing = closeSceneEditor()
  const id = ++launchId
  setState({ status: 'opening' })
  const task = (async () => {
    try {
      await closing
      if (id !== launchId) return
      await launch(project, id)
    } catch (firstError) {
      if (id !== launchId) return
      const failedLibrary = librarySession !== null || firstError instanceof LibGodotStartError
      endSession(true)
      const cleanupId = launchId
      if (failedLibrary) {
        const failure = firstError instanceof Error ? firstError : new Error(String(firstError))
        console.error('[solar] LibGodot scene editor failed; retrying with solar-godot.exe.', failure)
        try {
          const logDir = join(app.getPath('userData'), 'logs')
          await mkdir(logDir, { recursive: true })
          await appendFile(join(logDir, 'godot-libgodot-fallback.log'),
            `[${new Date().toISOString()}] ${failure.stack ?? failure.message}\n`, 'utf8')
        } catch (logError) {
          console.warn('[solar] could not write the LibGodot fallback diagnostic:', logError)
        }
        await libraryClosing
        if (cleanupId !== launchId) return
        const fallbackId = ++launchId
        setState({ status: 'opening' })
        try {
          await launch(project, fallbackId)
          return
        } catch (fallbackError) {
          if (fallbackId !== launchId) return
          const firstMessage = firstError instanceof Error ? firstError.message : String(firstError)
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          endSession(true)
          const fallbackCleanupId = launchId
          await processClosing
          if (fallbackCleanupId !== launchId) return
          const message = `In-process Godot failed: ${firstMessage} Standalone fallback failed: ${fallbackMessage}`
          setState({ status: 'error', message })
          throw new Error(message)
        }
      }
      await processClosing
      if (cleanupId !== launchId) return
      const message = firstError instanceof Error ? firstError.message : String(firstError)
      setState({ status: 'error', message })
      throw firstError
    }
  })().finally(() => {
    if (pendingLaunch === task) pendingLaunch = null
  })
  pendingLaunch = task
  return task
}
