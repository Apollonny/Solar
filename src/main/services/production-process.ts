import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Cancellable bounded runner, with process-tree teardown before returning. */
export function productionProcess(binary: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs = 120_000, environment: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; log: string; truncated: boolean; cancelled: boolean; timeout: boolean }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = spawn(binary, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...environment } })
    let log = '', bytes = 0, truncated = false, timeout = false, killed = false
    const stop = (): void => {
      if (killed || child.exitCode !== null) return
      killed = true
      if (process.platform === 'win32' && child.pid) {
        const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        kill.on('error', () => child.kill())
      } else { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill() } }
    }
    const timer = setTimeout(() => { timeout = true; stop() }, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    const a = new StringDecoder('utf8'), b = new StringDecoder('utf8')
    const append = (data: Buffer, decoder: StringDecoder): void => { bytes += data.length; if (bytes > 4 * 1024 * 1024) { truncated = true; stop() } else log += decoder.write(data) }
    child.stdout.on('data', (data: Buffer) => append(data, a)); child.stderr.on('data', (data: Buffer) => append(data, b))
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve({ code, log: log + (truncated ? '' : a.end() + b.end()), truncated, cancelled: signal.aborted, timeout }) })
    if (signal.aborted) stop()
  })
}
