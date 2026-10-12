import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { EvidenceArtifact, TaskContract, TestExecutionResult } from '../../shared/production'
import { validProjectPath } from '../../shared/production-gate'
import { resolveGodot } from './binaries'
import { snapshotProject } from './project-snapshot'
import { inspectLockedDependency } from './validation-dependencies'
import { productionProcess } from './production-process'
import { runDirectory, saveEvidence, vendorDirectory, verifyVendor } from './production-store'
interface TestReport { discovered: number; executed: number; failed: number; skipped: number; reports: unknown[]; cases: { path: string; name: string }[]; scopeMatched: boolean }

export async function runProductionTests(task: TaskContract, signal: AbortSignal, render: boolean, repair: number): Promise<{ result: TestExecutionResult; artifact: EvidenceArtifact }> {
  await verifyVendor('execution')
  if (!task.tests.length || task.tests.length > 20 || task.tests.some(path => !validProjectPath(path) || !path.startsWith('tests/') || !path.endsWith('.gd'))) throw new Error('The test strategy must select concrete tests/*.gd suites.')
  const godot = await resolveGodot()
  if (!godot) throw new Error('The GdUnit4 Godot runner is unavailable.')
  // One immutable saved-project copy per repair; never share live .godot cache.
  const directory = join(runDirectory(task.runId), `test-${repair}-${randomUUID()}`), project = join(directory, 'project'), reports = join(directory, 'reports')
  await mkdir(project, { recursive: true })
  const snapshot = await snapshotProject(task.projectPath, { signal, copyTo: project })
  if (!snapshot.complete || snapshot.revision !== task.projectRevision) throw new Error('The project changed before the test snapshot.')
  for (const path of task.tests) if (!snapshot.files.has(path)) throw new Error('A selected test suite is missing: ' + path)
  const bundled = join(vendorDirectory('execution'), 'gdunit4'), addon = join(project, 'addons/gdUnit4')
  // Compare the entire pinned addon, not just its version label.
  const existing = await readFile(join(addon, 'plugin.cfg')).catch(() => null)
  if (existing) {
    const manifest = JSON.parse(await readFile(join(vendorDirectory('execution'), 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] }
    const inventory = manifest.files.filter(file => file.path.startsWith('gdunit4/'))
    inspectLockedDependency(snapshot, { directory: 'addons/gdUnit4', files: Object.fromEntries(inventory.map(file => ['addons/gdUnit4/' + file.path.slice('gdunit4/'.length), file.sha256])) })
  }
  if (!existing) await cp(bundled, addon, { recursive: true, errorOnExist: true, force: false })
  const local = join(directory, 'user-data')
  await mkdir(local, { recursive: true })
  const overridePath = join(project, 'override.cfg')
  const override = await readFile(overridePath, 'utf8').catch(() => '')
  // OS user-directory APIs may ignore APPDATA. A unique custom user:// name
  // protects the user's game's saves on every supported runner platform.
  await writeFile(overridePath, `${override}\n[application]\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name=${JSON.stringify('Solar/production-tests/' + basename(directory))}\n`)
  const environment = { APPDATA: local, LOCALAPPDATA: local, XDG_DATA_HOME: local, XDG_CONFIG_HOME: local, XDG_CACHE_HOME: local }
  const imported = await productionProcess(godot, ['--headless', '--path', project, '--editor', '--import'], project, signal, 90_000, environment)
  const resources = join(app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'resources')
  const selectedFile = join(directory, 'selected.json'), discoveryFile = join(directory, 'discovery.json')
  await writeFile(selectedFile, JSON.stringify(task.tests), { flag: 'wx' })
  const discovery = imported.code === 0 && !imported.timeout && !imported.truncated ? await productionProcess(godot, ['--headless', '--path', project, '--script', join(resources, 'gdunit-discover.gd'), '--', selectedFile, discoveryFile], project, signal, 30_000, environment) : imported
  const args = [...(render ? [] : ['--headless']), '--path', project, '--script', 'addons/gdUnit4/bin/GdUnitCmdTool.gd', '-rd', reports, '-rc', '1', ...(!render ? ['--ignoreHeadlessMode'] : []), ...task.tests.flatMap(path => ['-a', 'res://' + path])]
  const run = discovery.code === 0 && !discovery.timeout && !discovery.truncated ? await productionProcess(godot, args, project, signal, 120_000, environment) : discovery
  let parsed: TestReport | null = null
  const parser = join(resources, 'gdunit-report.py')
  if (!run.cancelled && !run.truncated && !run.timeout) {
    const report = await productionProcess(join(vendorDirectory('execution'), 'python/python.exe'), [parser, reports, discoveryFile], directory, signal, 10_000, { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' })
    if (report.code === 0 && !report.truncated) parsed = JSON.parse(report.log) as TestReport
  }
  const count: TestReport | null = parsed
  const status = run.cancelled ? 'cancelled' : run.timeout || run.truncated || !count?.executed || !count.scopeMatched ? 'blocked' : run.code !== 0 || count.failed || count.skipped ? 'fail' : 'pass'
  const artifact = await saveEvidence(task, 'test', 'gdunit4', { snapshotRevision: snapshot.revision, selected: task.tests, exitCode: run.code, imported, discovery, run, junit: count }, status === 'pass' || status === 'fail')
  return { artifact, result: { status, exitCode: run.code, selected: task.tests, discovered: count?.discovered ?? 0, executed: count?.executed ?? 0, failed: count?.failed ?? 0, skipped: count?.skipped ?? 0, report: count?.reports.length ? artifact.file : null, truncated: run.truncated || run.timeout, scopeMatched: count?.scopeMatched === true } }
}
