import type { ProductionRole } from '../../shared/production'

export interface GuidanceScope { role: ProductionRole|'legacy-developer'; skills: readonly string[]; sessionId?:string; selection?:import('../../shared/ai-task-selection').TaskSelectionPolicy }
const notices = new Set(['upstream/LICENSE','upstream/NOTICE.md','solar/GPL-3.0.txt','upstream/assets/godot-worldmap-builder/LICENSE.md'])
export function gameReferenceAllowed(guidePath: string, file: string): boolean {
  if (file === guidePath || notices.has(file)) return true
  if (guidePath.startsWith('solar/')) return false
  const directory = guidePath.slice(0, guidePath.lastIndexOf('/') + 1)
  return file.startsWith(directory) || guidePath === 'upstream/skills/godot-worldmap-builder/SKILL.md' && file.startsWith('upstream/assets/godot-worldmap-builder/')
}
export function methodologySource(scope: GuidanceScope): string | null {
  if (scope.role === 'planner' && scope.skills.includes('solar-bmad-planning')) return 'bmad'
  if (scope.role === 'tea-strategy' && scope.skills.includes('solar-tea-strategy') || scope.role === 'tea-gate' && scope.skills.includes('solar-tea-gate')) return 'tea'
  return null
}
export function methodologyFileAllowed(file: string, scope: GuidanceScope): boolean {
  const source = methodologySource(scope)
  return !!source && (file.startsWith(source + '/') || scope.skills.some(name => file === `skills/${name}/SKILL.md`))
}

/** Every successful page advances. Never silently truncate an oversized line. */
export function methodologyPage(content: string, start: unknown): { content: string; nextStartLine: number | null; totalLines: number } {
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1 || start > 1_000_000) throw new Error('Invalid source page.')
  const lines = content.split(/\r?\n/)
  if (start > lines.length) throw new Error('Source page is outside the file.')
  let text = '', count = 0
  for (const line of lines.slice(start - 1, start - 1 + 120)) {
    if (line.length + 1 > 12_000) throw new Error('This methodology reference has an oversized line; select another source.')
    if (text.length + line.length + 1 > 12_000) break
    text += line + '\n'; count++
  }
  return { content: text, nextStartLine: start + count <= lines.length ? start + count : null, totalLines: lines.length }
}
