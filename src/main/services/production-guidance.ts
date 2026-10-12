import { app } from 'electron'
import { readFile, lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { prepareSkillSnapshot, type NativeSkillBundle } from './opencode-skills'
import { methodologyFileAllowed, methodologySource, methodologyPage, type GuidanceScope } from './guidance-scope'

interface Manifest { schemaVersion: number; sources: { id: string; repository: string; commit: string; version: string }[]; skills: { name: string; description: string }[]; files: { path: string; bytes: number; sha256: string }[] }
const root = (): string => app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked/resources/production-guidance') : join(app.getAppPath(), 'resources/production-guidance')
async function manifest(): Promise<Manifest> {
  const info = await lstat(join(root(), 'manifest.json'))
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('Production guidance manifest is unavailable.')
  const data = JSON.parse(await readFile(join(root(), 'manifest.json'), 'utf8')) as Manifest
  if (data.schemaVersion !== 1 || !Array.isArray(data.files) || data.files.length > 2000 || !Array.isArray(data.skills) || data.skills.map(s => s.name).sort().join(',') !== 'solar-bmad-planning,solar-tea-gate,solar-tea-strategy' || !Array.isArray(data.sources) || data.sources.length !== 2 || data.sources.find(s => s.id === 'bmad')?.commit !== '2486f5f5f3b8870baa6cee4615a870c0330f441c' || data.sources.find(s => s.id === 'tea')?.commit !== 'd99ad29c62697c152e3393351406686d5bcd323c') throw new Error('Invalid production guidance manifest.')
  if (new Set(data.files.map(f => f.path.toLowerCase())).size !== data.files.length || data.files.some(f => !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error('Invalid production guidance inventory.')
  return data
}
async function verified(path: string, data: Manifest): Promise<string> {
  const entry = data.files.find(f => f.path === path)
  if (!entry || !/^(?:skills|bmad|tea)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || entry.bytes > 1024 * 1024) throw new Error('Unknown production guidance file.')
  let candidate = root()
  const rootInfo = await lstat(candidate)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Linked guidance root is not allowed.')
  for (const part of path.split('/')) { candidate = join(candidate, part); if ((await lstat(candidate)).isSymbolicLink()) throw new Error('Linked guidance path is not allowed.') }
  const info = await lstat(candidate)
  if (!info.isFile() || info.size !== entry.bytes) throw new Error('Production guidance file is incomplete.')
  const handle = await open(candidate, 'r')
  let bytes: Buffer
  try {
    bytes = Buffer.alloc(entry.bytes + 1)
    let offset = 0
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
    bytes = bytes.subarray(0, offset)
  } finally { await handle.close() }
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Production guidance integrity failed.')
  return bytes.toString('utf8')
}
let prepared: Promise<NativeSkillBundle> | null = null
export function prepareProductionSkills(): Promise<NativeSkillBundle> {
  return prepared ??= (async () => {
    const data = await manifest()
    const files = await Promise.all(data.skills.map(async skill => ({ path: `${skill.name}/SKILL.md`, contents: await verified(`skills/${skill.name}/SKILL.md`, data) })))
    for (const source of data.sources) files.push({ path: `${source.id}-LICENSE.txt`, contents: await verified(`${source.id}/LICENSE`, data) })
    return prepareSkillSnapshot({ names: data.skills.map(s => s.name), files }, 'native-production-skills')
  })().catch(error => { prepared = null; throw error })
}
export async function productionGuidance(args: Record<string, unknown>, scope?: GuidanceScope): Promise<unknown> {
  // Providers sometimes fill unused optional fields. Only empty/default values
  // may be ignored; unknown keys and meaningful cross-action arguments fail.
  args = { ...args }
  args.action ??= 'search'
  const unused = args.action === 'read' ? ['query'] : ['file', 'start_line']
  for (const key of unused) if (args[key] === null || args[key] === undefined || args[key] === '' || key === 'start_line' && args[key] === 1) delete args[key]
  if (!['search','read'].includes(String(args.action))) throw new Error('Invalid production guidance action.')
  const allowed = args.action === 'read' ? ['action','file','start_line'] : ['action','query']
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported methodology argument for this action.')
  const data = await manifest()
  const sources = scope ? data.sources.filter(source => source.id === methodologySource(scope)) : data.sources
  if (args.action === 'read') {
    if (typeof args.file !== 'string') throw new Error('A methodology file is required.')
    const path = args.file
    if (scope && !methodologyFileAllowed(path, scope)) throw new Error('This methodology source belongs to another role.')
    const start = args.start_line ?? 1
    const content = await verified(path, data)
    return { file: path, sources, ...methodologyPage(content, start) }
  }
  if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 256)) throw new Error('Invalid methodology search query.')
  const query = String(args.query ?? '').trim().toLowerCase()
  const terms = [...new Set(query.match(/[a-z0-9]+/g) ?? [])]
  const available = data.files.filter(f => !scope || methodologyFileAllowed(f.path, scope))
  const matches = available.map(f => {
    const path = f.path.toLowerCase()
    const words = new Set(path.match(/[a-z0-9]+/g) ?? [])
    const matched = terms.filter(term => words.has(term))
    const score = matched.length * 100 + (query && path.includes(query) ? 50 : 0) + (matched.length && /template|headless/.test(path) ? 10 : 0)
    return { path: f.path, score }
  }).filter(f => !query || f.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 12).map(f => f.path)
  const startingPoints = available.filter(f => /(?:template|evidence-integrity|risk-governance|test-levels-framework)\.md$/.test(f.path)).slice(0, 4).map(f => f.path)
  return {
    sources, skills: data.skills.filter(skill => !scope || scope.skills.includes(skill.name)), files: matches,
    ...(!matches.length ? { suggestedFiles: startingPoints, note: 'No matching path. Do not repeat this search or invent paths. Use a returned suggestion or the supplied assigned skill.' } : {}),
    ...(matches[0] ?? startingPoints[0] ? { readExample: { action: 'read', file: matches[0] ?? startingPoints[0], start_line: 1 } } : {}),
    instructions: 'Copy a returned library-relative file path exactly. Repository names, versions and URLs are provenance, not file paths. Read only necessary pages; then submit StructuredOutput.'
  }
}
