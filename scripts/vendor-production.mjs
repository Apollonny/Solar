// Maintainer-only import. Never runs upstream installers, hooks or plugins.
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { productionSkillDefinitions, productionSkillText } from './production-skill-definitions.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'resources', 'production-guidance')
const sources = [
  { id: 'bmad', repository: 'bmad-code-org/bmad-module-game-dev-studio', version: 'v0.7.2', commit: '2486f5f5f3b8870baa6cee4615a870c0330f441c', patterns: [/^LICENSE$/, /^src\/workflows\/(?:1-preproduction\/(?:gds-create-game-brief|research\/gds-domain-research)|2-design\/gds-gdd|3-technical\/(?:gds-create-epics-and-stories|gds-game-architecture)|4-production\/(?:gds-create-story|gds-sprint-planning))\/.+\.(?:md|csv|yaml|toml)$/] },
  { id: 'tea', repository: 'bmad-code-org/bmad-method-test-architecture-enterprise', version: 'v1.27.2', commit: 'd99ad29c62697c152e3393351406686d5bcd323c', patterns: [/^LICENSE$/, /^src\/agents\/bmad-tea\/resources\/knowledge\/(?:evidence-integrity|risk-governance|selective-testing|test-levels-framework|test-priorities-matrix|test-quality|confidence-gate|nfr-criteria|probability-impact)\.md$/, /^src\/workflows\/testarch\/bmad-testarch-(?:test-design|test-review|trace|nfr)\/.+\.(?:md|yaml|csv)$/] }
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = []
if (process.argv.includes('--skills-only')) {
  const previous=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'))
  if(previous.schemaVersion!==1 || sources.some(source=>!previous.sources.some(item=>item.id===source.id&&item.commit===source.commit)))throw new Error('The pinned methodology inventory is unavailable.')
  for(const entry of previous.files.filter(file=>!file.path.startsWith('skills/'))) {
    if(!/^(?:bmad|tea)\/[a-zA-Z0-9_./-]+$/.test(entry.path)||entry.path.split('/').some(part=>part==='..'||part==='.'||!part))throw new Error('Invalid methodology inventory path.')
    const bytes=await readFile(join(output,entry.path))
    if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw new Error('Pinned methodology integrity failed: '+entry.path)
    files.push(entry)
  }
} else for (const source of sources) {
  const tree = await fetch(`https://api.github.com/repos/${source.repository}/git/trees/${source.commit}?recursive=1`).then(r => { if (!r.ok) throw new Error(`Source tree unavailable: ${source.id}`); return r.json() })
  if (tree.truncated) throw new Error('Source tree is incomplete.')
  const entries = tree.tree.filter(e => e.type === 'blob' && e.mode === '100644' && source.patterns.some(p => p.test(e.path)))
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < entries.length) {
      const entry = entries[next++]
      if (entry.size > 1024 * 1024 || entry.path.includes('..') || entry.path.includes('\\')) throw new Error('Invalid source file.')
      const path = `${source.id}/${entry.path}`
      let bytes
      try { bytes = await readFile(join(output, path)); if (hash(bytes) !== hash(await raw(source, entry.path))) bytes = null } catch {}
      bytes ??= await raw(source, entry.path)
      await mkdir(dirname(join(output, path)), { recursive: true })
      await writeFile(join(output, path), bytes)
      files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
    }
  }))
}
async function raw(source, path) {
  const response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${path}`)
  if (!response.ok) throw new Error(`Source unavailable: ${source.id}/${path}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 1024 * 1024) throw new Error('Oversized source.')
  return bytes
}
const skills = productionSkillDefinitions
for (const skill of skills) {
  if(skill.references.some(path=>!files.some(file=>file.path===path)))throw new Error('An adapter references an unavailable pinned source: '+skill.name)
  const content = productionSkillText(skill)
  const path = `skills/${skill.name}/SKILL.md`
  const bytes = Buffer.from(content)
  await mkdir(dirname(join(output, path)), { recursive: true }); await writeFile(join(output, path), bytes)
  files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
}
await writeFile(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sources: sources.map(({ patterns, ...s }) => s), skills: skills.map(({name,description})=>({name,description})), files: files.sort((a,b) => a.path.localeCompare(b.path)) }, null, 2))
console.log(`Imported ${files.length} methodology files; existing bgrenat bundle untouched.`)
