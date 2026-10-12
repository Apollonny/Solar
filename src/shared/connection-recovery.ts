/** Connection retries do not apply to auth, quota, invalid artifacts or writes. */
export const CONNECTION_RECOVERY = { attempts: 12, windowMs: 5 * 60_000, idleMs: 3 * 60_000 } as const
export function connectionRetryDelay(attempt: number): number { return Math.min(30_000, 2000 * 2 ** Math.min(Math.max(0, attempt), 4)) }
export function isConnectionFailure(error: unknown, depth = 0): boolean {
  if (depth > 8) return false
  const value = error as { message?: unknown; code?: unknown; status?: unknown; cause?: unknown }
  const message = typeof error === 'string' ? error : String(value?.message ?? '')
  if(value?.code==='AI_SELECTION_REJECTED'||value?.code==='PRODUCTION_TOOL_LOOP'||/Production tool loop stopped/.test(message))return false
  if (/\b(?:401|403)\b|invalid.*(?:api.?key|token)|unauthori[sz]ed|authorization failed|forbidden|quota|insufficient.*(?:credit|balance)|billing|payment required|free_tier_limit|context.{0,20}(?:overflow|window|length)|response limit|invalid.*(?:artifact|config)|indeterminate/i.test(message)) return false
  if (typeof value?.status === 'number') return [408,425,429].includes(value.status) || value.status >= 500 && value.status <= 599
  if (/PRODUCTION_TRANSIENT|(?:HTTP|status(?: code)?)[ :]*(?:408|425|429|5\d\d)\b|failed \((?:408|425|429|5\d\d)\)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|fetch failed|failed to fetch|socket hang up|network|disconnected|connection (?:closed|reset|refused|lost)|connection (?:recovery )?(?:is )?still unavailable|premature close|request aborted|timed? ?out|did not become ready|server exited unexpectedly|overloaded|temporarily unavailable|service unavailable|bad gateway|too many requests|internal server error|failed to find a worker|kv cache/i.test(message + ' ' + String(value?.code ?? ''))) return true
  return value?.cause !== undefined && value.cause !== error && isConnectionFailure(value.cause,depth+1)
}
export interface ChatConnectionState {
  projectPath: string; status: 'reconnecting' | 'connected'; source: 'events' | 'server' | 'provider'
  attempt?: number; maxAttempts?: number; nextAttemptAt?: string; message: string
}
