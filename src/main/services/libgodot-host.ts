import { app } from 'electron'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface Manifest {
  version: string
  commit: string
  target: string
  architecture: string
  bridgeAbi: number
  sha256: string
}

export interface LibGodotBinary {
  path: string
  sha256: string
}

export interface LibGodotSession {
  /** Godot runs on a worker thread of this Electron process. */
  pid: number
  ready: Promise<void>
  exited: Promise<Error | null>
  onExit(callback: (error: Error | null) => void): void
  forceStop(): void
  abandon(): void
}

let used = false

function vendorPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'vendor') : join(app.getAppPath(), 'vendor')
}

function unfinishedMarkerPath(): string {
  return join(app.getPath('userData'), 'libgodot-unfinished.json')
}

/** An in-process editor can be created only once per Electron lifetime in Godot 4.7.1. */
export async function libGodotAvailable(): Promise<LibGodotBinary | null> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || used) return null
  const dir = join(vendorPath(), 'godot', 'win32')
  try {
    const dll = join(dir, 'libgodot.dll')
    const [raw, file] = await Promise.all([
      readFile(join(dir, 'libgodot-manifest.json'), 'utf8'),
      stat(dll)
    ])
    const manifest = JSON.parse(raw) as Manifest
    if (!file.isFile() || !/^[a-f0-9]{64}$/i.test(manifest.sha256) ||
      manifest.version !== '4.7.1-stable' ||
      manifest.commit !== 'a13da4feb8d8aefc283c3763d33a2f170a18d541' ||
      manifest.target !== 'editor' || manifest.architecture !== 'x86_64' ||
      manifest.bridgeAbi !== 2) return null
    if (process.env.SOLAR_LIBGODOT !== '1') {
      try {
        const unfinished = JSON.parse(await readFile(unfinishedMarkerPath(), 'utf8')) as { sha256?: string }
        if (unfinished.sha256 === manifest.sha256) return null
      } catch {
        // A missing or unreadable marker does not block a verified library.
      }
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(dll)) hash.update(chunk)
    return hash.digest('hex') === manifest.sha256 ? { path: dll, sha256: manifest.sha256 } : null
  } catch {
    return null
  }
}

export function startLibGodotEditor(
  binary: LibGodotBinary,
  projectPath: string,
  helperExecutablePath: string,
  logPath: string,
  hostHandle: string,
  rect: { x: number; y: number; width: number; height: number },
  origin: { x: number; y: number }
): LibGodotSession {
  if (used) throw new Error('This Solar process has already hosted LibGodot. Restart Solar to use it again.')
  const script = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'libgodot-worker.cjs')
    : join(app.getAppPath(), 'resources', 'libgodot-worker.cjs')
  // Godot itself starts helper processes while opening the editor. Without
  // this override it would spawn Solar.exe and wait forever for Godot output.
  process.env.SOLAR_GODOT_HELPER_EXECUTABLE = helperExecutablePath
  const marker = unfinishedMarkerPath()
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ sha256: binary.sha256, startedAt: Date.now() }))
  let worker: Worker
  try {
    worker = new Worker(script, {
      workerData: { libraryPath: binary.path, projectPath, logPath, hostHandle, rect, origin }
    })
  } catch (error) {
    try { unlinkSync(marker) } catch { /* No marker was written. */ }
    throw error
  }
  used = true
  let exitCallback: ((error: Error | null) => void) | null = null
  let reportedExit = false
  let exitError: Error | null = null
  let readySettled = false
  let resolveExited!: (error: Error | null) => void
  const exited = new Promise<Error | null>((resolve) => { resolveExited = resolve })
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const rememberError = (error: Error): void => {
    exitError ??= error
    if (!readySettled) {
      readySettled = true
      rejectReady(error)
    }
  }
  const reportExit = (error: Error | null): void => {
    if (reportedExit) return
    reportedExit = true
    exitError = error
    if (!error) {
      try { unlinkSync(marker) } catch { /* The profile may have been removed. */ }
    }
    if (!readySettled) {
      readySettled = true
      rejectReady(error ?? new Error('The LibGodot editor exited before it opened.'))
    }
    resolveExited(error)
    exitCallback?.(error)
  }
  worker.on('message', (message: { type?: string; message?: string }) => {
    if (message?.type === 'ready' && !readySettled) {
      readySettled = true
      resolveReady()
    } else if (message?.type === 'error') {
      rememberError(new Error(message.message || 'LibGodot failed.'))
    }
    // The worker's "exited" message means native destroy() returned, not that
    // its thread/FFI teardown finished. Keep the host window alive until the
    // real Worker exit event, including when an error preceded destruction.
  })
  worker.on('error', rememberError)
  worker.on('exit', (code) => {
    if (process.env.SOLAR_SHUTDOWN_DIAGNOSTICS === '1') console.log('[solar] shutdown: LibGodot worker thread stopped')
    reportExit(exitError ?? (code === 0 ? null : new Error(`LibGodot worker exited with code ${code}.`)))
  })
  return {
    pid: process.pid,
    ready,
    exited,
    onExit(callback) { exitCallback = callback; if (reportedExit) callback(exitError) },
    forceStop() {
      try { worker.postMessage({ type: 'force-stop' }) } catch {
        // The worker may already have exited after reporting a startup error.
      }
    },
    abandon() {
      // A synchronous native call cannot be interrupted through postMessage.
      // Stop holding Electron's event loop open if startup never returns.
      worker.unref()
      void worker.terminate().catch((error) => {
        console.warn('[solar] could not terminate a stalled LibGodot worker:', error)
      })
    }
  }
}
