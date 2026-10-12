import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { selectedSkillContext, skillHash, type SkillSnapshot } from '../src/main/services/skill-context'
import { gameReferenceAllowed, methodologyFileAllowed, methodologyPage } from '../src/main/services/guidance-scope'
import { validateRoleSkills } from '../src/main/services/production-role-config'

async function fixture(body: string, run: (bundle: SkillSnapshot) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), 'solar-skill-check-')), name = 'solar-godot-gdscript-mastery'
  try {
    const content = `---\nname: ${name}\ndescription: fixture\n---\n${body}`
    const files = [{ path: `${name}/SKILL.md`, bytes: Buffer.byteLength(content), sha256: skillHash(content) }]
    const manifest = JSON.stringify({schemaVersion: 1, names: [name], files})
    await mkdir(join(path, name)); await writeFile(join(path, files[0].path), content); await writeFile(join(path, 'manifest.json'), manifest)
    await run({path, names: [name], files, manifest})
  } finally {
    const target = resolve(path)
    if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1)?.startsWith('solar-skill-check-')) throw new Error('Unsafe fixture cleanup.')
    await rm(target, {recursive: true, force: true})
  }
}
test('Selected references arrive complete beyond the former truncation limit; native loads are not invented', async () => {
  await fixture('x'.repeat(16000) + '\nEND-OF-SKILL-REQUIRED-RULE', async bundle => {
    const result = await selectedSkillContext(bundle.names, [bundle])
    assert.ok(result.context.endsWith('END-OF-SKILL-REQUIRED-RULE'))
    assert.deepEqual(result.receipts, [{name: bundle.names[0], ...bundle.files[0], manifestSha256: skillHash(bundle.manifest), delivery: 'host-context'}].map(({path: _path, ...receipt}) => receipt))
    assert.equal(result.paths.length, 1)
  })
})
test('Cached documents and manifests are verified on every stage, including same-size tampering', async () => {
  await fixture('first value', async bundle => {
    await selectedSkillContext(bundle.names, [bundle])
    const file = join(bundle.path, bundle.files[0].path)
    const content = `---\nname: ${bundle.names[0]}\ndescription: fixture\n---\nfirst value`
    await writeFile(file, content.replace('first', 'other'))
    await assert.rejects(selectedSkillContext(bundle.names, [bundle]), /content changed/)
    await writeFile(file, content)
    await writeFile(join(bundle.path, 'manifest.json'), bundle.manifest.replace('schemaVersion', 'schemaVersioN'))
    await assert.rejects(selectedSkillContext(bundle.names, [bundle]), /manifest changed/)
  })
})
test('Unknown, duplicate, ambiguous, oversized and cancelled selections fail before delivery', async () => {
  await fixture('small', async bundle => {
    await assert.rejects(selectedSkillContext(['solar-unknown'], [bundle]), /missing/)
    await assert.rejects(selectedSkillContext([...bundle.names, ...bundle.names], [bundle]), /duplicate/)
    await assert.rejects(selectedSkillContext(bundle.names, [bundle, bundle]), /duplicated/)
    await assert.rejects(selectedSkillContext(['../outside'], [bundle]), /Invalid/)
    await assert.rejects(selectedSkillContext(bundle.names, [bundle], AbortSignal.abort()), /abort/i)
  })
  await fixture('x'.repeat(65536), async bundle => {
    await assert.rejects(selectedSkillContext(bundle.names, [bundle]), /budget.*no skill was truncated/)
  })
})
test('Methodology and supporting files remain within the selected source and guide', () => {
  const guide = 'upstream/skills/godot-gdscript-mastery/SKILL.md'
  assert.equal(gameReferenceAllowed(guide, 'upstream/skills/godot-gdscript-mastery/examples/move.gd'), true)
  for (const path of ['upstream/skills/studio-router/SKILL.md','upstream/assets/unrelated/file.gd','solar/ecs.md']) assert.equal(gameReferenceAllowed(guide, path), false)
  assert.equal(gameReferenceAllowed('solar/2d.md', 'solar/3d.md'), false)
  const scope = {role: 'planner' as const, skills: ['solar-bmad-planning']}
  assert.equal(methodologyFileAllowed('bmad/template.md', scope), true)
  assert.equal(methodologyFileAllowed('skills/solar-bmad-planning/SKILL.md', scope), true)
  for (const path of ['tea/template.md','skills/solar-tea-gate/SKILL.md']) assert.equal(methodologyFileAllowed(path, scope), false)
})
test('Methodology pagination advances and refuses oversized lines instead of an endless empty page', () => {
  const first = methodologyPage(Array.from({length: 240}, () => 'line').join('\n'), 1)
  assert.equal(first.nextStartLine, 121)
  assert.equal(methodologyPage('line', 1).nextStartLine, null)
  assert.throws(() => methodologyPage('x'.repeat(12000), 1), /oversized/)
  for (const value of [0, 1.5, '1', NaN, 1_000_001]) assert.throws(() => methodologyPage('line', value), /Invalid/)
})
test('Every dispatched role has its own exact methodology scope; developer cannot become a studio router', () => {
  validateRoleSkills('planner', ['solar-bmad-planning'])
  validateRoleSkills('developer', ['solar-godot-gdscript-mastery','solar-ecs','solar-validation','solar-2d'])
  validateRoleSkills('vision-reviewer', [])
  for (const skills of [[], ['solar-tea-gate'], ['solar-bmad-planning','solar-bmad-planning']]) assert.throws(() => validateRoleSkills('planner', skills))
  assert.throws(() => validateRoleSkills('developer', ['solar-studio-router']))
  assert.throws(() => validateRoleSkills('developer', []))
  assert.throws(() => validateRoleSkills('developer', ['solar-godot-gdscript-mastery','solar-ecs','solar-2d']))
})
