import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { productionSkillDefinitions, productionSkillText } from '../scripts/production-skill-definitions.mjs'

test('Headless methodology adapters expose small relevant indexes and retain pinned sources',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../resources/production-guidance/manifest.json',import.meta.url),'utf8'))
  assert.equal(manifest.sources.find(source=>source.id==='bmad').commit,'2486f5f5f3b8870baa6cee4615a870c0330f441c')
  assert.equal(manifest.sources.find(source=>source.id==='tea').commit,'d99ad29c62697c152e3393351406686d5bcd323c')
  for(const skill of productionSkillDefinitions) {
    assert.ok(skill.references.length<=4)
    assert.ok(skill.references.every(path=>!/(?:customize|playwright|pact|party)/i.test(path)))
    const path=`skills/${skill.name}/SKILL.md`,entry=manifest.files.find(file=>file.path===path)
    const bytes=await readFile(new URL('../resources/production-guidance/'+path,import.meta.url))
    assert.equal(bytes.toString('utf8'),productionSkillText(skill))
    assert.equal(bytes.length,entry.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256)
    for(const reference of skill.references)assert.ok(manifest.files.some(file=>file.path===reference))
  }
})
