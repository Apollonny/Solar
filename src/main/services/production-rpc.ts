import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Private, bounded, bidirectional JSON-RPC; stdout is protocol only. */
export class ProductionRpc {
  private readonly process: ChildProcessWithoutNullStreams
  private nextId = 0
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private terminated = false
  private startupCode = ''
  private diagnosticTail = ''
  onRequest: (method: string, args: unknown) => Promise<unknown> = async () => { throw new Error('Executor is not registered.') }
  onNotification: (method: string, args: unknown) => void = () => {}
  onExit: (error: Error) => void = () => {}
  constructor(binary: string, args: string[] = [], environment: NodeJS.ProcessEnv = {}, private readonly label = 'Microsoft orchestrator') {
    this.process = spawn(binary, args, { stdio: 'pipe', windowsHide: true, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...environment } })
    this.process.stdout.on('data', (bytes: Buffer) => {
      try {
        this.buffer += this.decoder.write(bytes)
        if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) throw new Error('Orchestrator response exceeds its limit.')
        let newline: number
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
          if (line.trim()) this.receive(JSON.parse(line))
        }
      } catch { this.fail(new Error('Orchestrator sent an invalid protocol frame.')); this.terminate() }
    })
    // Only a typed upstream startup code escapes stderr. Capability tokens,
    // environment values and arbitrary trace text are never shown or persisted.
    this.process.stderr.on('data', (bytes: Buffer) => {
      this.diagnosticTail = (this.diagnosticTail + bytes.toString('utf8')).slice(-2048)
      const code = this.diagnosticTail.match(/godot-ai attach \[([A-Z0-9_]{1,80})\]/)?.[1]
      if (code) this.startupCode = code
    })
    this.process.stdin.on('error', () => this.fail(new Error(`${this.label} input disconnected.`)))
    this.process.on('error', () => this.fail(new Error(`${this.label} could not start.`)))
    this.process.on('exit', (code, signal) => this.fail(new Error(`${this.label} disconnected (${this.startupCode || (signal ? 'signal ' + signal : 'exit ' + code)}).${this.label === 'Microsoft orchestrator' ? ' Resume its checkpoint.' : ' Reopen the prepared project gateway.'}`)))
  }
  private send(value: unknown): void {
    if (this.closed) throw new Error('Orchestrator is disconnected.')
    const data = JSON.stringify(value)
    if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('Orchestrator request exceeds its limit.')
    this.process.stdin.write(data + '\n')
  }
  private receive(value: { jsonrpc?: string; id?: string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }): void {
    if (value.jsonrpc !== '2.0') throw new Error('Invalid RPC version.')
    if (value.method) {
      if (!value.id) { this.onNotification(value.method, value.params); return }
      void this.onRequest(value.method, value.params).then(
        result => this.send({ jsonrpc: '2.0', id: value.id, result }),
        () => this.send({ jsonrpc: '2.0', id: value.id, error: { code: -32000, message: 'Solar executor failed. Review its local workflow report.' } })
      ).catch(() => {})
      return
    }
    if (!value.id) return
    const pending = this.pending.get(value.id)
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(value.id)
    if (value.error) pending.reject(new Error(value.error.message?.slice(0, 500) || 'Orchestrator request failed.'))
    else pending.resolve(value.result)
  }
  call<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = 'app-' + ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)) }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  notify(method: string, params: unknown = {}): void { this.send({ jsonrpc: '2.0', method, params }) }
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear(); this.onExit(error)
  }
  private terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.process.stdin.end()
    // EOF lets authenticated attach close its lease. Its backend may have been
    // adopted by another editor/client; process-tree killing would revoke that
    // client's runtime. The upstream idle reaper owns detached-backend cleanup.
    const timer = setTimeout(() => { if (this.process.exitCode === null) this.process.kill() }, 3000)
    timer.unref()
    this.process.once('close', () => clearTimeout(timer))
  }
  close(): void { this.fail(new Error('Orchestrator stopped.')); this.terminate() }
}
