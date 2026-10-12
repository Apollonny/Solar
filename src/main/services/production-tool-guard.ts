import { createHash } from 'node:crypto'
import type { ProductionRole } from '../../shared/production'
import { isConnectionFailure } from '../../shared/connection-recovery'

/** Unique tool calls, not SSE deliveries or model turns. Never stores inputs. */
export class ProductionToolGuard {
  private calls = new Set<string>()
  private finished = new Set<string>()
  private failed = new Map<string, number>()
  private retrieved = new Map<string, number>()
  private failures = 0
  private references = 0

  constructor(private role: ProductionRole) {}

  observe(part: { type?: string; id?: string; tool?: string; state?: { status?: string; input?: unknown; error?: string } }): Error | null {
    if (part.type !== 'tool' || typeof part.id !== 'string') return null
    if (!this.calls.has(part.id)) {
      this.calls.add(part.id)
      const ceiling = this.role === 'developer' ? 96 : this.role === 'planner' ? 32 : this.role === 'vision-reviewer' ? 12 : 64
      if (this.calls.size > ceiling) return this.stop('The role exceeded its tool-call budget without finishing its artifact.')
      if (part.tool === 'solar_production_guidance' && ++this.references > (this.role === 'tea-gate' ? 16 : 12)) return this.stop('The role kept retrieving methodology instead of submitting its artifact.')
    }
    if (!['completed', 'error'].includes(part.state?.status ?? '') || this.finished.has(part.id)) return null
    this.finished.add(part.id)
    if (part.state?.status === 'error' && isConnectionFailure(part.state.error)) {
      return new Error('PRODUCTION_TRANSIENT: A read-only executor tool lost its upstream connection. Reconnecting the saved stage.')
    }
    // Private session metadata and optional empty fields do not distinguish a
    // repeated request. Bound encoding so hostile arguments cannot grow state.
    const input = part.state?.input
    const normalized = input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== '_solar_session' && value !== undefined && value !== null && value !== '').sort(([a], [b]) => a.localeCompare(b))) : input
    const encoded = JSON.stringify(normalized) ?? ''
    if (encoded.length > 256 * 1024) return this.stop('The role submitted an oversized tool request.')
    const key = `${part.tool}:${createHash('sha256').update(encoded).digest('hex')}`
    if (part.state?.status === 'error') {
      const count = (this.failed.get(key) ?? 0) + 1
      this.failed.set(key, count)
      if (++this.failures >= 8 || count >= 3) return this.stop('The role repeated rejected tool requests. Correct the reference/tool arguments before resuming.')
    } else if (['skill', 'solar_game_guidance', 'solar_production_guidance'].includes(part.tool ?? '')) {
      const count = (this.retrieved.get(key) ?? 0) + 1
      this.retrieved.set(key, count)
      if (count >= 4) return this.stop('The role repeatedly retrieved the same reference instead of producing its artifact.')
    }
    return null
  }

  private stop(message: string): Error {
    return Object.assign(new Error(`Production tool loop stopped: ${message} No feature was accepted.`), { code: 'PRODUCTION_TOOL_LOOP' })
  }
}
