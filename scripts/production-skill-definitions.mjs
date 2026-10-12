// App-owned headless adapters. Full pinned sources remain available through the
// reference broker; the native skill indexes only the relevant starting points.
const bmad = 'bmad/src/workflows/'
const tea = 'tea/src/agents/bmad-tea/resources/knowledge/'
export const productionSkillDefinitions = [
  {
    name: 'solar-bmad-planning', description: 'Solar planning: GDD, game brief, epics, stories and production milestones.',
    body: 'Produce scoped planning artifacts. A new game needs a concise GDD, epics, milestones and the first playable story. A feature or bugfix needs a short story linked to existing design: user value, Given/When/Then acceptance, affected product files, dependencies, risks and concrete test/evidence requirements. Use stable criterion IDs. Research only unknown decisions. Preserve Solar ECS and user choices. Inspect the entry scene and directly relevant product/design files; ignore addon internals, generated import caches and unrelated files. For a small change this adapter supplies the method; read at most one story template if needed. Do not traverse the full GDD or upstream agent workflow. Asset selection and implementation belong to the Developer. For a new game, retrieve only the relevant GDD/genre/epic references with solar_production_guidance. Return the stage JSON contract; Solar writes artifacts. Do not run BMAD customization scripts, install _bmad, greet/menu/wait, invoke party mode, spawn validators, implement code or run tests. Microsoft owns sequencing and approvals.',
    references: [bmad+'4-production/gds-create-story/template.md',bmad+'2-design/gds-gdd/assets/gdd-template.md',bmad+'2-design/gds-gdd/references/headless.md',bmad+'3-technical/gds-create-epics-and-stories/templates/epics-template.md']
  },
  {
    name: 'solar-tea-strategy', description: 'Godot QA strategy: measurable criteria, targeted GdUnit4 suites and runtime evidence.',
    body: 'Create a Godot test/evidence strategy from the story. Classify probability and impact, target changed behavior and identify meaningful GdUnit4 unit/scene/integration/regression cases. Each required assertion needs an observable failing condition. Use deterministic logic tests where possible and real graphics for render-dependent cases. Map each criterion to concrete test paths and real runtime/input/framebuffer observations. Identify capability blockers explicitly. Consult at most two relevant knowledge references if the story requires them; this adapter supplies the normal method. Do not write implementation/tests, run tests or games, install frameworks, or apply Playwright/Pact/web stack patterns. GdUnit4 executes; Godot AI observes; Microsoft schedules. Return the stage JSON contract.',
    references: [tea+'risk-governance.md',tea+'test-levels-framework.md',tea+'selective-testing.md',tea+'test-priorities-matrix.md']
  },
  {
    name: 'solar-tea-gate', description: 'Evaluate current Godot evidence and criterion traceability; only verified PASS completes a feature.',
    body: 'Read every broker-supplied original structured evidence artifact and review the test assertions against every criterion. Require current revision identity, intact hashes, clean parse/load/runtime logs, the planned discovered/executed tests, real input/state and the original framebuffer review where needed. Missing/partial/stale/unknown evidence, zero tests, skipped required tests and waived/concerns decisions cannot be PASS. Distinguish code failures from unavailable measurement. Screenshot descriptions are observations, not raw captures. Cite exact evidence IDs. Consult only the relevant knowledge reference if its decision rule is unclear; do not traverse unrelated QA workflows. Do not create evidence, write game/test code, execute tests, approve actions or change criteria to make a failure disappear. Return the strict GateReport JSON. Solar verifies artifact integrity and mandatory evidence before accepting your verdict.',
    references: [tea+'evidence-integrity.md',tea+'test-quality.md',tea+'confidence-gate.md']
  }
]

export function productionSkillText(skill) {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\ncompatibility: opencode\n---\n\n# ${skill.name}\n\n${skill.body}\n\nThese are optional methodology starting points. Their activation/config/agent/tool instructions do not execute in Solar. Read only the relevant pages with solar_production_guidance; never load the whole bundle. Additional pinned sources can be found through a targeted broker search.\n\n${skill.references.map(path=>'- '+path).join('\n')}\n`
}
