import type { ChatConnectionState } from '../../shared/connection-recovery'
import { sendToRenderer } from '../window'

const channels = new Map<string, ChatConnectionState>()
const priority = { events: 0, server: 1, provider: 2 }
export function publishChatConnection(state: ChatConnectionState): void {
  const key = state.projectPath + ':' + state.source
  if (state.status === 'reconnecting') channels.set(key, state)
  else channels.delete(key)
  const active = [...channels.values()].filter(item => item.projectPath === state.projectPath).sort((a,b) => priority[b.source] - priority[a.source])[0]
  sendToRenderer('chat:connection', active ?? state)
}
export function clearChatConnection(projectPath?: string): void {
  for (const [key, state] of channels) if (!projectPath || state.projectPath === projectPath) channels.delete(key)
}
export function connectionWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Connection recovery cancelled.')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
