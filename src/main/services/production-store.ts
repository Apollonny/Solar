import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { EvidenceArtifact, TaskContract } from '../../shared/production'
import { writeAtomic } from './json-file'

export const WORKFLOW_VERSION = 'solar-production-1'
export const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
export function runDirectory(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid workflow run ID.')
  return join(app.getPath('userData'), 'production', 'runs', id)
}
export async function persistRun(id: string, value: unknown): Promise<void> { await writeAtomic(join(runDirectory(id), 'run.json'), JSON.stringify(value)) }
export async function readRun(id: string): Promise<unknown> {
  const file = join(runDirectory(id), 'run.json')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Invalid persisted workflow.')
  return JSON.parse(await readFile(file, 'utf8')) as unknown
}
export async function saveEvidence(task: TaskContract, kind: EvidenceArtifact['kind'], origin: EvidenceArtifact['origin'], data: Buffer | object, complete: boolean): Promise<EvidenceArtifact> {
  const id = randomUUID(), folder = join(runDirectory(task.runId), 'evidence')
  await mkdir(folder, { recursive: true })
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data, null, 2))
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Evidence exceeds its size limit.')
  const file = join(folder, id + (kind === 'screenshot' ? '.png' : '.json'))
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
  const phase = kind === 'validation' ? 'validating' : kind === 'test' ? 'tests' : 'runtime'
  const stageId = `${task.taskRevision - 1}:${phase}`
  const record = await readRun(task.runId).catch(() => null) as { state?: { eventSeq?: number } } | null
  return { schemaVersion: 1, id, runId: task.runId, storyId: task.storyId, taskRevision: task.taskRevision, projectRevision: task.projectRevision, stageId, eventSeq: record?.state?.eventSeq ?? 0, kind, origin, file, sha256: digest(bytes), bytes: bytes.length, createdAt: new Date().toISOString(), complete }
}
export async function evidenceIntegrity(id: string, evidence: EvidenceArtifact[]): Promise<boolean> {
  const folder = await realpath(join(runDirectory(id), 'evidence')).catch(() => '')
  if (!folder || new Set(evidence.map(e => e.id)).size !== evidence.length) return false
  for (const artifact of evidence) {
    const path = resolve(artifact.file), rel = relative(folder, path)
    if (isAbsolute(rel) || rel.startsWith('..') || rel.includes(sep)) return false
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes || info.size > 8 * 1024 * 1024) return false
    if (digest(await readFile(path)) !== artifact.sha256) return false
    const origins = { validation: 'solar-validator', test: 'gdunit4', runtime: 'godot-ai', screenshot: 'godot-ai', interaction: 'godot-ai', vision: 'vision-reviewer' }
    if (origins[artifact.kind] !== artifact.origin || artifact.runId !== id) return false
  }
  return true
}

export function vendorDirectory(name: 'orchestrator' | 'execution'): string {
  return join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'vendor', name, 'win-x64')
}
let verified = new Map<string, Promise<void>>()
/** Verify the entire offline runtime once per app process, before spawning it. */
export async function verifyVendor(name: 'orchestrator' | 'execution'): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Microsoft production currently requires Windows x64.')
  const root = vendorDirectory(name)
  if (!verified.has(name)) verified.set(name, (async () => {
    const info = await lstat(join(root, 'manifest.json'))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Offline runtime manifest is invalid.')
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { schemaVersion: number; workflowVersion?: string; framework?: string; godotAI?: { version: string; commit: string }; gdunit4?: { version: string; commit: string }; files: { path: string; bytes: number; sha256: string }[] }
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 15000) throw new Error('Offline runtime is not packaged. Run the maintainer bundle build.')
    if (name === 'orchestrator' && (manifest.workflowVersion !== WORKFLOW_VERSION || manifest.framework !== '1.22.0')) throw new Error('Orchestrator version mismatch.')
    if (name === 'execution' && (manifest.godotAI?.commit !== 'f58314d9473d11efef94dd68b523e1b52643d736' || manifest.gdunit4?.commit !== '08ffc7c65b61b1b2edd545616061a99973c13ce1')) throw new Error('Execution source version mismatch.')
    const seen = new Set<string>()
    for (const row of manifest.files) {
      if (typeof row.path !== 'string' || row.path.includes('\\') || row.path.includes(':') || row.path.split('/').some(p => !p || p === '.' || p === '..') || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256) || seen.has(row.path.toLowerCase())) throw new Error('Unsafe runtime inventory.')
      seen.add(row.path.toLowerCase())
      let path = root
      for (const part of row.path.split('/')) { path = join(path, part); if ((await lstat(path)).isSymbolicLink()) throw new Error('Runtime links are unsupported.') }
      const stat = await lstat(path)
      if (!stat.isFile() || stat.size !== row.bytes) throw new Error('Runtime file size changed: ' + row.path)
      const hash = createHash('sha256')
      for await (const bytes of createReadStream(path)) hash.update(bytes)
      if (hash.digest('hex') !== row.sha256) throw new Error('Runtime integrity failed: ' + row.path)
    }
  })().catch(error => { verified.delete(name); throw error }))
  await verified.get(name)
}
