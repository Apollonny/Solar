import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { AGENT_BUDGET } from '../../shared/agent-budget'
import type { AgentTaskIdentity, ProjectValidationResult } from '../../shared/agent-task'
import { agentStateDirectory, pruneAgentRecords } from './agent-state-store'
import { writeAtomic } from './json-file'
import { snapshotProject } from './project-snapshot'
import { isSolarNativeSkillName } from './game-guidance'

type Outcome = 'response_completed' | 'failed' | 'cancelled'
type Usage = { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null; cost: number | null }
const EMPTY_USAGE: Usage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, cost: null }
let activeRun: AgentRunMetrics | null = null
const writes = new Map<string, Promise<void>>()

function unionDuration(intervals: [number, number][]): number {
  const sorted = intervals.sort((a, b) => a[0] - b[0])
  let total = 0, start = 0, end = 0
  for (const [a, b] of sorted) {
    if (a > end) { total += end - start; start = a; end = b } else end = Math.max(end, b)
  }
  return total + end - start
}

/** Privacy boundary: numeric usage, event/tool names and allowlisted public skill names.
 * Never accept prompt text, tool arguments, provider errors or image payloads here.
 */
export class AgentRunMetrics {
  readonly identity: AgentTaskIdentity = { runId: randomUUID(), taskRevision: 1, projectRevision: null, eventSeq: 0 }
  readonly controller = new AbortController()
  readonly started = Date.now()
  private finished = false
  private firstResponseMs: number | null = null
  private startupMs = 0
  private requestWaitMs = 0
  private activeRequestStarted: number | null = null
  private activeStartupStarted: number | null = null
  private providerRetries = 0
  private contextRollovers = 0
  private repairRoundsInferred = 0
  private previousValidationFailed = false
  private snapshotMs = 0
  private events: { seq: number; elapsedMs: number; type: string; data?: Record<string, string | number | boolean | null> }[] = []
  private eventsTruncated = false
  private tools = new Map<string, { start: number; end?: number }>()
  private usage = new Map<string, Usage>()
  private loadedSkillParts = new Set<string>()
  private initialRevision: Promise<string | null>

  constructor(readonly projectPath: string) {
    this.event('started')
    this.initialRevision = snapshotProject(projectPath, { signal: this.controller.signal }).then((snapshot) => {
      this.snapshotMs += snapshot.durationMs
      if (!this.identity.projectRevision) this.identity.projectRevision = snapshot.revision
      return snapshot.revision
    }).catch(() => null)
  }

  private event(type: string, data?: Record<string, string | number | boolean | null>): void {
    if (this.finished) return
    this.identity.eventSeq++
    if (this.events.length >= 2048) { this.eventsTruncated = true; return }
    this.events.push({ seq: this.identity.eventSeq, elapsedMs: Date.now() - this.started, type, data })
  }

  starting(): void { if (!this.finished) this.activeStartupStarted = Date.now() }
  startup(durationMs: number): void {
    if (this.finished) return
    this.activeStartupStarted = null
    this.startupMs += durationMs
    this.event('assistant_ready', { durationMs })
  }
  requesting(): void { if (!this.finished) this.activeRequestStarted = Date.now() }
  request(durationMs: number): void {
    if (this.finished) return
    this.activeRequestStarted = null
    this.requestWaitMs += durationMs
  }
  retry(kind: 'provider' | 'context'): void {
    if (this.finished) return
    if (kind === 'provider') this.providerRetries++
    else this.contextRollovers++
    this.event('retry', { kind })
  }
  response(): void {
    if (this.firstResponseMs !== null || this.finished) return
    this.firstResponseMs = Date.now() - this.started
    this.event('first_response')
  }
  tool(id: string, name: string, status: string): void {
    if (this.finished || !/^[\w.:-]{1,120}$/.test(name)) return
    let tool = this.tools.get(id)
    if (!tool && this.tools.size < 2048) {
      tool = { start: Date.now() }
      this.tools.set(id, tool)
      this.event('tool_started', { name })
    }
    if (tool && tool.end === undefined && ['completed', 'error'].includes(status)) {
      tool.end = Date.now()
      this.event('tool_finished', { name, ok: status === 'completed', durationMs: tool.end - tool.start })
    }
  }
  skillLoaded(partId: string, name: string): void {
    if (this.finished || !isSolarNativeSkillName(name) || this.loadedSkillParts.has(partId) || this.loadedSkillParts.size >= 2048) return
    this.loadedSkillParts.add(partId)
    this.event('skill_loaded', { name })
  }

  providerUsage(id: unknown, tokens: unknown, cost: unknown): void {
    if (this.finished || typeof id !== 'string' || this.usage.size >= 2048) return
    const data = tokens && typeof tokens === 'object' ? tokens as Record<string, unknown> : {}
    const cache = data.cache && typeof data.cache === 'object' ? data.cache as Record<string, unknown> : {}
    const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    const next: Usage = {
      input: number(data.input), output: number(data.output), reasoning: number(data.reasoning),
      cacheRead: number(cache.read), cacheWrite: number(cache.write), cost: number(cost)
    }
    // message.updated may be repeated. Latest values replace that message's usage.
    if (Object.values(next).some((value) => value !== null)) this.usage.set(id, next)
  }
  validation(result: ProjectValidationResult): void {
    if (this.finished) return
    if (this.previousValidationFailed) this.repairRoundsInferred++
    this.previousValidationFailed = result.status === 'fail'
    this.identity.projectRevision = result.projectRevision
    this.snapshotMs += result.snapshotMs
    this.event('validation_finished', {
      status: result.status, cacheStatus: result.cacheStatus, durationMs: result.durationMs,
      cachedChecks: result.checks.cached, projectRevision: result.projectRevision
    })
  }
  finish(outcome: Outcome): void {
    if (this.finished) return
    const ended = Date.now()
    if (this.activeRequestStarted !== null) this.requestWaitMs += ended - this.activeRequestStarted
    if (this.activeStartupStarted !== null) this.startupMs += ended - this.activeStartupStarted
    this.event('finished', { outcome })
    this.finished = true
    this.controller.abort()
    const totals: Usage = { ...EMPTY_USAGE }
    for (const key of Object.keys(totals) as (keyof Usage)[]) {
      const values = [...this.usage.values()].map((entry) => entry[key]).filter((value): value is number => value !== null)
      totals[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null
    }
    const toolsMs = unionDuration([...this.tools.values()].map((entry) => [entry.start, entry.end ?? ended]))
    // Capture completion revision immediately, before a subsequent turn can edit.
    // Queue only record writes; a delayed write must not snapshot the next task.
    const finalSnapshotPromise = snapshotProject(this.projectPath).catch(() => null)
    const persist = async (): Promise<void> => {
      const startRevision = await this.initialRevision
      const finalSnapshot = await finalSnapshotPromise
      const directory = await agentStateDirectory(this.projectPath, 'run-metrics')
      const record = {
        schemaVersion: 1, ...this.identity, outcome,
        startedAt: new Date(this.started).toISOString(), durationMs: ended - this.started,
        initialProjectRevision: startRevision, finalProjectRevision: finalSnapshot?.revision ?? null,
        startupMs: this.startupMs, firstResponseMs: this.firstResponseMs,
        requestWaitMs: this.requestWaitMs, toolWallMs: toolsMs,
        // A blocking OpenCode request includes tools, retries and model generation.
        // The API does not expose exact model-only waiting; never mislabel the total.
        modelWaitMs: null, usage: totals, usageScope: 'reported_primary_session_messages',
        usageComplete: false, playableVerified: false,
        providerRetries: this.providerRetries, contextRollovers: this.contextRollovers,
        repairRoundsInferred: this.repairRoundsInferred,
        snapshotMs: this.snapshotMs + (finalSnapshot?.durationMs ?? 0),
        events: this.events, eventsTruncated: this.eventsTruncated
      }
      await writeAtomic(join(directory, `${this.identity.runId}.json`), JSON.stringify(record))
      await pruneAgentRecords(directory, AGENT_BUDGET.metricsBytes)
    }
    const key = resolve(this.projectPath)
    const queued = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(persist).catch(() => {
      console.warn('[solar] Could not persist local task metrics.')
    })
    writes.set(key, queued)
    void queued.finally(() => { if (writes.get(key) === queued) writes.delete(key) })
  }
}

export function startAgentRun(projectPath: string): AgentRunMetrics {
  activeRun?.finish('cancelled')
  activeRun = new AgentRunMetrics(projectPath)
  return activeRun
}

export function getActiveAgentRun(projectPath?: string): AgentRunMetrics | null {
  const run = getBoundAgentRun(projectPath)
  return run && !run.controller.signal.aborted ? run : null
}

/** A stopped run remains identifiable until the next user turn starts. */
export function getBoundAgentRun(projectPath?: string): AgentRunMetrics | null {
  return activeRun && (!projectPath || resolve(projectPath) === resolve(activeRun.projectPath)) ? activeRun : null
}

export async function flushAgentMetrics(): Promise<void> {
  await Promise.allSettled([...writes.values()])
}
