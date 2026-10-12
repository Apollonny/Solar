import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ProductionRole, ProductionState, SkillContextReceipt, StageExecution } from '../../shared/production'
import { writeAtomic } from './json-file'
import { runDirectory } from './production-store'

/** Diagnostic counters only: no prompts, credentials, tool inputs or output text. */
export function productionAttempt(stage: StageExecution, role: ProductionRole, sessionId: string, promptBytes: number, onProgress?: (progress: NonNullable<ProductionState['progress']>) => void) {
  const start = Date.now(), id = randomUUID(), seen = new Set<string>()
  const record = {
    schemaVersion: 1, id, runId: stage.runId, storyId: stage.task.storyId,
    taskRevision: stage.task.taskRevision, projectRevision: stage.task.projectRevision,
    stageId: stage.stageId, eventSeq: stage.eventSeq, role, sessionId,
    model: stage.task.model, startedAt: new Date(start).toISOString(), promptBytes,
    firstResponseMs: null as number | null, durationMs: 0, toolsStarted: 0,
    toolsFailed: 0, nativeRetriesStopped: 0, loadedSkills: [] as string[],
    toolsUsed: [] as string[], skillContext: [] as SkillContextReceipt[],
    finishReason: null as string | null, textBytes: 0, reasoningBytes: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    outcome: 'running', failure: null as string | null, cleanupConfirmed: false
  }
  const path = join(runDirectory(stage.runId), 'attempts', id + '.json')
  let writes = Promise.resolve()
  const save = () => { const copy = JSON.stringify(record); writes = writes.catch(() => {}).then(() => writeAtomic(path, copy)); return writes }
  let timer: ReturnType<typeof setTimeout> | null = null, finished = false
  const progress = () => {
    if (timer || finished) return
    timer = setTimeout(() => { timer = null; record.durationMs = Date.now() - start; onProgress?.({ role, startedAt: record.startedAt, firstResponse: record.firstResponseMs !== null, toolsStarted: record.toolsStarted, toolsFailed: record.toolsFailed }); void save().catch(() => {}) }, 2000)
    timer.unref()
  }
  return {
    started: () => { onProgress?.({ role, startedAt: record.startedAt, firstResponse: false, toolsStarted: 0, toolsFailed: 0 }); return save() },
    model(model: StageExecution['task']['model']) { record.model = model; progress() },
    skillContext(receipts: SkillContextReceipt[]) { record.skillContext = structuredClone(receipts) },
    response(info: { finish?: string; tokens?: { input?: number; output?: number; reasoning?: number } } | undefined, parts: { type: string; text?: string }[]) {
      record.finishReason = typeof info?.finish === 'string' && /^[a-z_-]{1,40}$/i.test(info.finish) ? info.finish : null
      for (const type of ['text', 'reasoning']) {
        const bytes = parts.filter(part => part.type === type).reduce((sum, part) => sum + Buffer.byteLength(part.text ?? ''), 0)
        if (type === 'text') record.textBytes = bytes
        else record.reasoningBytes = bytes
      }
      for (const key of ['input', 'output', 'reasoning'] as const) {
        const value = info?.tokens?.[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record.tokens[key] = value
      }
      progress()
    },
    observe(type: string, properties: Record<string, any>) {
      const part = properties.part
      if (record.firstResponseMs === null && (type === 'message.part.delta' && typeof properties.delta === 'string' && properties.delta.length || part?.type === 'tool' || part && ['text','reasoning'].includes(part.type) && typeof part.text === 'string' && part.text.length)) record.firstResponseMs = Date.now() - start
      if (part?.type === 'tool' && typeof part.id === 'string') {
        if (!seen.has(part.id)) { seen.add(part.id); record.toolsStarted++ }
        if (typeof part.tool === 'string' && /^[\w.:-]{1,120}$/.test(part.tool) && !record.toolsUsed.includes(part.tool) && record.toolsUsed.length < 64) record.toolsUsed.push(part.tool)
        if (part.state?.status === 'error' && !seen.has(part.id + ':failed')) { seen.add(part.id + ':failed'); record.toolsFailed++ }
      }
      if (type === 'session.status' && properties.status?.type === 'retry') record.nativeRetriesStopped++
      progress()
    },
    async finish(outcome: 'completed'|'blocked'|'transient'|'cancelled', loadedSkills: string[], failure: string | null, cleanupConfirmed: boolean) {
      finished = true
      if (timer) { clearTimeout(timer); timer = null }
      Object.assign(record, { outcome, loadedSkills, failure, cleanupConfirmed, durationMs: Date.now() - start })
      await save()
    }
  }
}
