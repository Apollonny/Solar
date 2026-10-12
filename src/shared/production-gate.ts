import type { AcceptanceCriterion, EvidenceArtifact, GateReport, TaskContract, TestExecutionResult } from './production'

/** Mechanical evidence constraints are part of TEA's gate, never a model override. */
export function enforceQualityGate(task: TaskContract, report: GateReport, artifacts: EvidenceArtifact[], tests: TestExecutionResult | null, validationStatus: string, integrity: boolean): GateReport {
  const reasons: string[] = []
  const current = artifacts.filter(e => e.runId === task.runId && e.storyId === task.storyId && e.taskRevision === task.taskRevision && e.projectRevision === task.projectRevision && e.complete)
  if (!integrity) reasons.push('Evidence artifact integrity or provenance is invalid.')
  if (artifacts.some(e => e.projectRevision !== task.projectRevision || e.taskRevision !== task.taskRevision)) return { schemaVersion: 1, status: 'STALE', reasons: ['Evidence belongs to another project/task revision.'], checks: report.checks ?? [] }
  if (!task.criteria.length) reasons.push('No acceptance criteria were defined.')
  if (validationStatus !== 'pass') reasons.push(`Saved-project validation is ${validationStatus}.`)
  if (!tests || !tests.scopeMatched || tests.status !== 'pass' || tests.executed < 1 || tests.discovered !== tests.executed || tests.skipped > 0 || tests.failed > 0 || tests.exitCode !== 0 || !tests.report || tests.truncated) reasons.push('The required GdUnit4 test run is absent, incomplete, empty or failed.')
  if (tests && task.tests.some(path => !tests.selected.includes(path))) reasons.push('Required test suites were not selected.')
  const ids = new Set<string>()
  const checks = task.criteria.map((criterion: AcceptanceCriterion) => {
    const check = report.checks?.find(c => c.criterionId === criterion.id)
    const evidence = current.filter(e => check?.evidenceIds?.includes(e.id))
    if (ids.has(criterion.id)) reasons.push('Acceptance criteria IDs are duplicated.')
    ids.add(criterion.id)
    const passed = check?.passed === true && criterion.evidence.length > 0 && criterion.evidence.every(kind => evidence.some(e => e.kind === kind))
    if (!passed) reasons.push(`Criterion ${criterion.id} lacks passing, current evidence.`)
    if (criterion.evidence.includes('screenshot') && !evidence.some(e => e.kind === 'vision')) reasons.push(`Criterion ${criterion.id} has not been visually inspected.`)
    return { criterionId: criterion.id, passed, evidenceIds: evidence.map(e => e.id) }
  })
  if (report.status !== 'PASS') return { ...report, reasons: [...(report.reasons ?? []), ...reasons], checks }
  return { schemaVersion: 1, status: reasons.length ? 'BLOCKED' : 'PASS', reasons, checks }
}

export function validProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 500 && !value.includes('\\') && !value.startsWith('/') && !value.includes(':') && !value.split('/').some(p => !p || p === '.' || p === '..') && !value.startsWith('.solar/') && !value.startsWith('.godot/') && !value.startsWith('.git/')
}
