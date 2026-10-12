import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { AGENT_BUDGET } from '../../shared/agent-budget'
import { StringDecoder } from 'node:string_decoder'
import type { DiagnosticCode, ProjectDiagnostic, ProjectValidationResult, ValidationMode } from '../../shared/agent-task'
import { agentStateDirectory, pruneAgentRecords, readAgentRecord } from './agent-state-store'
import { resolveGodot } from './binaries'
import { writeAtomic } from './json-file'
import { snapshotProject } from './project-snapshot'
import { inspectLockedDependency, type ValidationDependency } from './validation-dependencies'

const VALIDATOR_VERSION = 1
const limits = AGENT_BUDGET.validation
interface ValidationRequest {
  mode?: ValidationMode; paths?: string[]; runId?: string; taskRevision?: number; signal?: AbortSignal
  /** Internal adapter only: exact locked sources, still included in whole-project import/revision. */
  dependencies?: ValidationDependency[]
  verifiedEditorPlugins?: string[]
}
const queues = new Map<string, Promise<unknown>>()
const pending = new Map<string, Set<AbortController>>()
let transitionSuspensions = 0

export function suspendProjectValidations(): () => void {
  transitionSuspensions++
  return () => { transitionSuspensions = Math.max(0, transitionSuspensions - 1) }
}

export async function cancelProjectValidations(projectPath?: string): Promise<void> {
  const keys = projectPath ? [resolve(projectPath)] : [...pending.keys()]
  for (const key of keys) for (const controller of pending.get(key) ?? []) controller.abort()
  await Promise.allSettled(keys.map((key) => queues.get(key)))
}

/** Per-project queue; requests capture identity and cancellation before waiting. */
export function validateProject(projectPath: string, request: ValidationRequest = {}): Promise<ProjectValidationResult> {
  const key = resolve(projectPath)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (request.signal?.aborted) controller.abort()
  request.signal?.addEventListener('abort', abort, { once: true })
  const controllers = pending.get(key) ?? new Set<AbortController>()
  const blockedReason = transitionSuspensions ? 'The project is changing; retry after it opens.' : controllers.size >= 8 ? 'The project validation queue is full; retry after pending checks finish.' : null
  pending.set(key, controllers)
  controllers.add(controller)
  const started = Date.now()
  const queued = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    return performValidation(key, { ...request, signal: controller.signal }, started, blockedReason)
  })
  queues.set(key, queued)
  void queued.finally(() => {
    request.signal?.removeEventListener('abort', abort)
    controllers.delete(controller)
    if (!controllers.size) pending.delete(key)
    if (queues.get(key) === queued) queues.delete(key)
  }).catch(() => {})
  return queued
}

interface ProcessOutput { text: string; code: number | null; timeout: boolean; cancelled: boolean; truncated: boolean; unavailable: boolean }

/** Kill the whole validator process group and wait for close before removing its workspace. */
function runProcess(binary: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<ProcessOutput> {
  return new Promise((done) => {
    if (signal.aborted) { done({ text: '', code: null, timeout: false, cancelled: true, truncated: false, unavailable: false }); return }
    const localData = join(dirname(cwd), 'user-data')
    const child = spawn(binary, args, {
      cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PWD: cwd, APPDATA: localData, LOCALAPPDATA: localData, XDG_DATA_HOME: localData, XDG_CONFIG_HOME: localData, XDG_CACHE_HOME: localData }
    })
    let text = '', bytes = 0, timeout = false, truncated = false, unavailable = false, stopping = false
    const terminate = (): void => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return
      stopping = true
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', () => child.kill('SIGKILL'))
        killer.once('exit', () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
      } else {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const timer = setTimeout(() => { timeout = true; terminate() }, Math.max(1, timeoutMs))
    const abort = (): void => terminate()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) terminate()
    const append = (chunk: Buffer, decoder: StringDecoder): void => {
      bytes += chunk.length
      if (bytes <= maxBytes) text += decoder.write(chunk)
      else { truncated = true; terminate() }
    }
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
    child.stdout.on('data', (chunk: Buffer) => append(chunk, stdoutDecoder))
    child.stderr.on('data', (chunk: Buffer) => append(chunk, stderrDecoder))
    child.once('error', () => { unavailable = true })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (!truncated) text += stdoutDecoder.end() + stderrDecoder.end()
      // Strip engine ANSI escapes. Output remains bounded and contains no tool inputs.
      // eslint-disable-next-line no-control-regex
      done({ text: text.replace(/\x1b\[[0-9;]*m/g, ''), code, timeout, cancelled: signal.aborted, truncated, unavailable })
    })
  })
}

function diagnostic(code: DiagnosticCode, message: string, engineVersion: string | null, file: string | null = null, severity: 'error' | 'warning' = 'error'): ProjectDiagnostic {
  return { code, message: message.slice(0, 2000), engineVersion, file, line: null, column: null, severity, source: 'solar' }
}

function engineDiagnostics(text: string, engineVersion: string | null, fallbackFile: string | null): ProjectDiagnostic[] {
  const lines = text.split(/\r?\n/)
  const diagnostics: ProjectDiagnostic[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!/^(?:SCRIPT ERROR|ERROR):/.test(line)) continue
    const message = [line, ...lines.slice(index + 1, index + 4).filter((next) => /^\s+(?:at:|GDScript backtrace)/.test(next))].join('\n')
    const location = /res:\/\/(.+?):(\d+)(?::(\d+))?(?=[\s).]|$)/.exec(message)
    const file = location?.[1] ?? /res:\/\/([^"'\s)]+)/.exec(message)?.[1] ?? fallbackFile
    const code: DiagnosticCode = /(?:Parse Error|Parse error|parser error)/.test(message) ? 'GD_PARSE_ERROR'
      : /(?:non-existent resource|Resource file not found|Cannot open file|does not exist)/i.test(message) ? 'MISSING_RESOURCE'
        : 'UNCLASSIFIED_GODOT_ERROR'
    diagnostics.push({ ...diagnostic(code, message, engineVersion, file), source: 'godot', line: location ? Number(location[2]) : null, column: location?.[3] ? Number(location[3]) : null })
  }
  return diagnostics
}

async function fingerprint(binary: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const input = createReadStream(binary, { signal })
  for await (const chunk of input) hash.update(chunk)
  return hash.digest('hex')
}

async function performValidation(projectPath: string, request: ValidationRequest, started: number, blockedReason: string | null): Promise<ProjectValidationResult> {
  const signal = request.signal!
  const mode = request.mode ?? 'project'
  const result: ProjectValidationResult = {
    schemaVersion: 1, runId: request.runId ?? null, taskRevision: request.taskRevision ?? null,
    projectRevision: null, status: 'unavailable',
    scope: { mode, files: [], content: 'saved_files', runtime: 'not_checked', unsavedEditorChanges: 'not_inspected', importScope: 'whole_project' },
    diagnostics: [], durationMs: 0, snapshotMs: 0, truncated: false, cacheStatus: 'bypass',
    checks: { scripts: 0, resources: 0, cached: 0, import: 'not_run' }, engineVersion: null
  }
  let workspace: string | undefined
  let workspaceRoot: string | undefined
  let macUserWorkspace: string | undefined
  let pendingCache: { directory: string; key: string } | undefined
  let totalOutputBytes = 0
  const overall = new AbortController()
  const abort = (): void => overall.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) overall.abort()
  const deadline = setTimeout(abort, Math.max(1, limits.totalMs - (Date.now() - started)))
  const add = (items: ProjectDiagnostic[]): void => {
    for (const item of items) {
      if (result.diagnostics.length >= limits.maxDiagnostics) { result.truncated = true; break }
      if (!result.diagnostics.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) result.diagnostics.push(item)
    }
  }
  const command = async (binary: string, args: string[], ms: number, file: string | null, importing = false): Promise<boolean> => {
    overall.signal.throwIfAborted()
    const output = await runProcess(binary, args, workspace!, overall.signal, Math.min(ms, limits.totalMs - (Date.now() - started)), limits.outputBytes - totalOutputBytes)
    totalOutputBytes += Buffer.byteLength(output.text)
    result.truncated ||= output.truncated
    add(engineDiagnostics(output.text, result.engineVersion, file))
    if (output.cancelled) { result.status = signal.aborted ? 'cancelled' : 'timeout'; return false }
    if (output.timeout) {
      result.status = 'timeout'
      add([diagnostic(importing ? 'IMPORT_TIMEOUT' : 'VALIDATOR_TIMEOUT', `${importing ? 'Import' : 'Validation'} exceeded its ${ms / 1000}s deadline.`, result.engineVersion, file)])
      return false
    }
    if (output.unavailable || output.code === null) {
      result.status = 'unavailable'
      add([diagnostic('VALIDATOR_UNAVAILABLE', 'Godot could not complete the validator process.', result.engineVersion, file)])
      return false
    }
    if (output.truncated) { result.status = 'partial'; return false }
    if (output.code !== 0 && !result.diagnostics.some((item) => item.source === 'godot')) add([diagnostic('UNCLASSIFIED_GODOT_ERROR', `Godot exited with code ${output.code}. ${output.text.slice(-1000)}`, result.engineVersion, file)])
    if (output.code !== 0 || result.diagnostics.some((item) => item.severity === 'error')) result.status = 'fail'
    return output.code === 0
  }
  try {
    overall.signal.throwIfAborted()
    if (blockedReason) throw new Error(blockedReason)
    if (Date.now() - started >= limits.totalMs) { overall.abort(); overall.signal.throwIfAborted() }
    if (!['project', 'scripts', 'resources'].includes(mode)) throw new Error('mode must be project, scripts or resources.')
    if (request.paths && (!Array.isArray(request.paths) || request.paths.length > limits.maxUnits || request.paths.some((path) => typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.startsWith('res://') || path.split('/').includes('..') || posix.normalize(path) !== path))) {
      throw new Error('paths must contain normalized project-relative file paths within the validation unit limit.')
    }
    const binary = await resolveGodot()
    if (!binary) throw new Error('Godot executable is unavailable. Configure it in Settings.')
    workspaceRoot = await mkdtemp(join(tmpdir(), 'solar-validation-'))
    workspace = join(workspaceRoot, 'project')
    await mkdir(workspace)
    await mkdir(join(workspaceRoot, 'user-data'))
    const version = await runProcess(binary, ['--version'], workspace, overall.signal, 5000, 4096)
    if (version.cancelled || version.timeout) throw new Error('Godot version lookup did not complete.')
    result.engineVersion = version.text.trim()
    if (version.code !== 0 || !/^4\./.test(result.engineVersion)) throw new Error('The validator requires a Godot 4 editor executable.')
    const engineHash = await fingerprint(binary, overall.signal)
    const snapshot = await snapshotProject(projectPath, { signal: overall.signal })
    result.snapshotMs += snapshot.durationMs
    result.projectRevision = snapshot.revision
    if (!snapshot.complete) {
      result.status = 'partial'
      add(snapshot.issues.map((message) => diagnostic('VALIDATOR_UNAVAILABLE', message, result.engineVersion, null, 'warning')))
      return result
    }
    if (!snapshot.files.has('project.godot')) throw new Error('project.godot was not found.')
    const dependencyFiles = new Set<string>()
    for (const dependency of request.dependencies ?? []) {
      const inspected = inspectLockedDependency(snapshot, dependency)
      for (const path of inspected.paths) dependencyFiles.add(path)
      ;(result.scope.dependencies ??= []).push(inspected.summary)
    }
    const ignoredDirs = [...snapshot.files.keys()].filter((path) => path.endsWith('/.gdignore')).map((path) => posix.dirname(path))
    const eligible = (path: string): boolean => !dependencyFiles.has(path) && !ignoredDirs.some((directory) => path.startsWith(directory + '/'))
    const units = [...snapshot.files.keys()].filter((path) => eligible(path) && (mode === 'scripts' ? /\.gd$/i.test(path) : mode === 'resources' ? /\.(tscn|tres|scn|res)$/i.test(path) : /\.(gd|tscn|tres|scn|res)$/i.test(path))).sort()
    const paths = request.paths?.length ? [...new Set(request.paths)].sort() : units
    result.scope.files = paths.slice(0, limits.maxUnits)
    if (paths.length > limits.maxUnits) { result.truncated = true; add([diagnostic('VALIDATOR_UNAVAILABLE', 'Validation unit limit reached; request smaller batches.', result.engineVersion, null, 'warning')]) }
    for (const path of result.scope.files) {
      if (!snapshot.files.has(path)) add([diagnostic('MISSING_RESOURCE', `Requested file does not exist: ${path}`, result.engineVersion, path)])
      else if (!units.includes(path)) add([diagnostic('VALIDATOR_UNAVAILABLE', `File is outside the supported ${mode} scope: ${path}`, result.engineVersion, path, 'warning')])
    }
    const supported = result.scope.files.filter((path) => units.includes(path))
    const unsupported = [...snapshot.files.keys()].some((path) => eligible(path) && /\.(cs|gdextension)$/i.test(path))
    if (unsupported) {
      result.status = 'partial'
      add([diagnostic('VALIDATOR_UNAVAILABLE', 'C# or GDExtension dependencies require a separate validation adapter. This headless recovery-mode check was not run to avoid reporting dependency errors as game bugs.', result.engineVersion, null, 'warning')])
      return result
    }
    const dynamic = [...snapshot.files].some(([path, file]) => eligible(path) && file.text && /\b(?:load|preload|load_threaded_request|load_threaded_get)\s*\(\s*(?:[^"'\s]|["'](?!res:\/\/|uid:\/\/))/.test(file.text))
    if (dynamic && mode !== 'scripts') add([diagnostic('VALIDATOR_UNAVAILABLE', 'Dynamic resource paths require a runtime check; static loading cannot verify those targets.', result.engineVersion, null, 'warning')])
    const executableResources = [...snapshot.files.values()].some((file) => file.text && /@tool|\bfunc\s+_(?:static_)?init\s*\(/.test(file.text))
    const opaqueResources = [...snapshot.files.keys()].some((path) => /\.(res|scn)$/i.test(path))
    const enabledPlugins = /\[editor_plugins\]([^]*?)(?=\n\[|$)/.exec(snapshot.files.get('project.godot')!.text ?? '')?.[1] ?? ''
    const enabledEntry = /^enabled\s*=\s*PackedStringArray\(([^\r\n]*)\)/m.exec(enabledPlugins)
    const pluginPaths = enabledEntry?.[1].match(/"[^"]+"/g)?.map(path => path.slice(1, -1)) ?? []
    const verifiedPlugins = request.verifiedEditorPlugins ?? []
    if (verifiedPlugins.some(path => !path.startsWith('res://') || !dependencyFiles.has(path.slice(6)))) throw new Error('Editor verification is not bound to a locked dependency.')
    const editorPlugins = /^enabled\s*=/m.test(enabledPlugins) && (!enabledEntry || pluginPaths.some(path => !verifiedPlugins.includes(path)))
    if (verifiedPlugins.length) result.scope.verifiedEditorPlugins = verifiedPlugins
    if (editorPlugins && mode !== 'scripts') add([diagnostic('VALIDATOR_UNAVAILABLE', 'Editor plugins are disabled during isolated recovery-mode import; plugin-dependent resources need an additional editor/runtime check.', result.engineVersion, null, 'warning')])
    const cacheable = !request.dependencies?.length && !dynamic && !executableResources && !opaqueResources && !editorPlugins && !result.truncated && !result.diagnostics.length
    const cacheKey = createHash('sha256').update(JSON.stringify([VALIDATOR_VERSION, snapshot.revision, engineHash, process.platform, process.arch, mode, paths])).digest('hex')
    let cacheDir: string | undefined
    if (cacheable) {
      try {
        cacheDir = await agentStateDirectory(projectPath, 'validation-cache')
        const cached = await readAgentRecord(cacheDir, `${cacheKey}.json`) as { validatorVersion?: number; key?: string; result?: ProjectValidationResult }
        if (cached.validatorVersion === VALIDATOR_VERSION && cached.key === cacheKey && validCachedResult(cached.result, result, paths)) {
          const current = await snapshotProject(projectPath, { signal: overall.signal })
          result.snapshotMs += current.durationMs
          if (current.revision !== snapshot.revision) { result.status = 'stale'; add([diagnostic('STALE_CONTEXT', 'Project changed while reading validation cache.', result.engineVersion)]); return result }
          Object.assign(result, { status: cached.result!.status, diagnostics: cached.result!.diagnostics, checks: { ...cached.result!.checks, cached: cached.result!.checks.scripts + cached.result!.checks.resources }, cacheStatus: 'hit' })
          await utimes(join(cacheDir, `${cacheKey}.json`), new Date(), new Date()).catch(() => {})
          return result
        }
      } catch { /* Missing/corrupt cache is a miss, never a source-file mutation. */ }
      result.cacheStatus = 'miss'
    }
    const copied = await snapshotProject(projectPath, { signal: overall.signal, copyTo: workspace })
    result.snapshotMs += copied.durationMs
    if (!copied.complete || copied.revision !== snapshot.revision) { result.status = 'stale'; add([diagnostic('STALE_CONTEXT', 'Project changed before its isolated validation copy was ready.', result.engineVersion)]); return result }
    result.status = result.diagnostics.some((item) => item.severity === 'error') ? 'fail' : 'pass'
    const localUserDirectory = `Solar/validation/${basename(workspaceRoot)}`
    const overridePath = join(workspace, 'override.cfg')
    const override = await readFile(overridePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    // Isolate user:// as well as res://. Only the temporary copy is changed.
    await writeFile(overridePath, `${override}\n[application]\nconfig/name="Solar Validation"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name=${JSON.stringify(localUserDirectory)}\n`)
    if (process.platform === 'darwin') {
      macUserWorkspace = join(homedir(), 'Library', 'Application Support', localUserDirectory)
      await mkdir(macUserWorkspace, { recursive: true })
    }
    const common = ['--headless', '--path', workspace, '--log-file', join(workspace, `solar-validator-${randomUUID()}.log`)]
    const imported = await command(binary, [...common, '--editor', '--recovery-mode', '--import'], limits.importMs, null, true)
    result.checks.import = imported ? 'completed' : 'failed'
    if (['timeout', 'cancelled', 'unavailable', 'partial'].includes(result.status)) return result
    // A broken import environment cannot produce a reusable cache entry.
    for (const path of supported.filter((path) => /\.gd$/i.test(path))) {
      await command(binary, [...common, '--script', `res://${path}`, '--check-only'], limits.scriptMs, path)
      result.checks.scripts++
      if (['timeout', 'cancelled', 'unavailable', 'partial'].includes(result.status)) return result
    }
    const resources = supported.filter((path) => /\.(tscn|tres|scn|res)$/i.test(path))
    if ((resources.length || mode !== 'scripts') && imported) {
      // MainLoop avoids SceneTree's autoload/game startup; scenes are loaded, never instanced.
      const runnerName = `solar_validator_${randomUUID().replace(/-/g, '')}.gd`
      const marker = `SOLAR_VALIDATION_${randomUUID()}`
      const runner = resourceRunner(resources, marker, mode)
      await writeFile(join(workspace, runnerName), runner, { flag: 'wx' })
      const output = await runProcess(binary, [...common, '--script', `res://${runnerName}`], workspace, overall.signal, Math.min(limits.resourceMs, limits.totalMs - (Date.now() - started)), limits.outputBytes - totalOutputBytes)
      totalOutputBytes += Buffer.byteLength(output.text)
      result.truncated ||= output.truncated
      add(engineDiagnostics(output.text, result.engineVersion, null))
      if (output.cancelled) { result.status = signal.aborted ? 'cancelled' : 'timeout'; return result }
      if (output.timeout) { result.status = 'timeout'; add([diagnostic('VALIDATOR_TIMEOUT', 'Resource loading exceeded its deadline.', result.engineVersion)]); return result }
      if (output.truncated) { result.status = 'partial'; return result }
      const completion = output.text.split(/\r?\n/).find((line) => line.startsWith(marker))
      if (output.unavailable || output.code !== 0 || !completion) { result.status = 'unavailable'; add([diagnostic('VALIDATOR_UNAVAILABLE', 'Resource validation did not return a complete result.', result.engineVersion)]); return result }
      const loaded = JSON.parse(completion.slice(marker.length)) as { failures: string[]; mainSceneValid: boolean; autoloadFailures: string[] }
      add(loaded.failures.map((path) => diagnostic('MISSING_RESOURCE', `Godot could not load ${path}.`, result.engineVersion, path.replace(/^res:\/\//, ''))))
      if (mode !== 'scripts' && !loaded.mainSceneValid) add([diagnostic('MAIN_SCENE_MISSING', 'The configured main scene is missing or is not a PackedScene.', result.engineVersion, 'project.godot')])
      add(loaded.autoloadFailures.map((name) => diagnostic('AUTOLOAD_INVALID', `Autoload ${name} must resolve to a scene or a script inheriting Node.`, result.engineVersion, 'project.godot')))
      result.checks.resources = resources.length
    }
    if (result.diagnostics.some((item) => item.severity === 'error')) result.status = 'fail'
    else if (result.truncated || result.diagnostics.some((item) => item.severity === 'warning') || !imported) result.status = 'partial'
    const after = await snapshotProject(projectPath, { signal: overall.signal })
    result.snapshotMs += after.durationMs
    if (!after.complete || after.revision !== snapshot.revision) { result.status = 'stale'; add([diagnostic('STALE_CONTEXT', 'Saved project files changed during validation. Run validation again for the current revision.', result.engineVersion)]); return result }
    const engineAfter = await fingerprint(binary, overall.signal)
    if (engineAfter !== engineHash) { result.status = 'stale'; add([diagnostic('STALE_CONTEXT', 'The Godot executable changed during validation.', result.engineVersion)]); return result }
    const deterministic = result.status === 'pass' || (result.status === 'fail' && result.diagnostics.every((item) => ['GD_PARSE_ERROR', 'MAIN_SCENE_MISSING', 'AUTOLOAD_INVALID', 'MISSING_RESOURCE'].includes(item.code)))
    overall.signal.throwIfAborted()
    if (cacheable && imported && !result.truncated && deterministic && cacheDir) pendingCache = { directory: cacheDir, key: cacheKey }
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : overall.signal.aborted ? 'timeout' : 'unavailable'
    add([diagnostic(result.status === 'timeout' ? 'VALIDATOR_TIMEOUT' : 'VALIDATOR_UNAVAILABLE', result.status === 'cancelled' ? 'Validation was cancelled.' : error instanceof Error ? error.message : 'Validation is unavailable.', result.engineVersion)])
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    if (workspaceRoot && dirname(resolve(workspaceRoot)) === resolve(tmpdir()) && basename(workspaceRoot).startsWith('solar-validation-')) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    if (macUserWorkspace && dirname(resolve(macUserWorkspace)) === resolve(homedir(), 'Library', 'Application Support', 'Solar', 'validation') && basename(macUserWorkspace).startsWith('solar-validation-')) await rm(macUserWorkspace, { recursive: true, force: true }).catch(() => {})
    if (signal.aborted) result.status = 'cancelled'
    else if (overall.signal.aborted) result.status = 'timeout'
    result.durationMs = Date.now() - started
  }
  if (pendingCache && ['pass', 'fail'].includes(result.status) && !signal.aborted && !overall.signal.aborted) {
    const validationId = randomUUID()
    const cachePath = join(pendingCache.directory, `${pendingCache.key}.json`)
    await writeAtomic(cachePath, JSON.stringify({ validatorVersion: VALIDATOR_VERSION, key: pendingCache.key, validationId, result })).catch(() => {})
    await pruneAgentRecords(pendingCache.directory, limits.cacheBytes).catch(() => {})
    if (signal.aborted) {
      result.status = 'cancelled'
      const stored = await readAgentRecord(pendingCache.directory, `${pendingCache.key}.json`).catch(() => null) as { validationId?: string } | null
      if (stored?.validationId === validationId) await rm(cachePath, { force: true }).catch(() => {})
    }
  }
  return result
}

function validCachedResult(value: ProjectValidationResult | undefined, current: ProjectValidationResult, paths: string[]): boolean {
  if (!value || value.schemaVersion !== 1 || !['pass', 'fail'].includes(value.status) || value.truncated || value.projectRevision !== current.projectRevision || value.engineVersion !== current.engineVersion) return false
  if (!value.scope || value.scope.mode !== current.scope.mode || JSON.stringify(value.scope.files) !== JSON.stringify(paths)) return false
  if (!value.checks || value.checks.import !== 'completed' || ![value.checks.scripts, value.checks.resources].every((number) => Number.isInteger(number) && number >= 0 && number <= limits.maxUnits)) return false
  if (value.checks.scripts !== paths.filter((path) => /\.gd$/i.test(path)).length || value.checks.resources !== paths.filter((path) => /\.(tscn|tres|scn|res)$/i.test(path)).length) return false
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > limits.maxDiagnostics) return false
  const codes = ['GD_PARSE_ERROR', 'MISSING_RESOURCE', 'MAIN_SCENE_MISSING', 'AUTOLOAD_INVALID', 'UNCLASSIFIED_GODOT_ERROR']
  if (!value.diagnostics.every((item) => item && codes.includes(item.code) && ['error', 'warning'].includes(item.severity) && typeof item.message === 'string' && item.message.length <= 2000 && (item.file === null || typeof item.file === 'string') && ['solar', 'godot'].includes(item.source) && (item.line === null || Number.isInteger(item.line)) && (item.column === null || Number.isInteger(item.column)))) return false
  return value.status === 'pass' ? value.diagnostics.length === 0 : value.diagnostics.some((item) => item.severity === 'error')
}

function resourceRunner(resources: string[], marker: string, mode: ValidationMode): string {
  return `extends MainLoop

func _initialize() -> void:
	var failures: Array[String] = []
	var autoload_failures: Array[String] = []
	for path in ${JSON.stringify(resources.map((path) => 'res://' + path))}:
		if ResourceLoader.load(path) == null:
			failures.append(path)
	var main_valid: bool = true
	if ${mode === 'scripts' ? 'false' : 'true'}:
		var main_path: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
		main_valid = not main_path.is_empty() and ResourceLoader.load(main_path) is PackedScene
		for property in ProjectSettings.get_property_list():
			var name: String = str(property.name)
			if not name.begins_with("autoload/"):
				continue
			var path: String = str(ProjectSettings.get_setting(name)).trim_prefix("*")
			var resource: Resource = ResourceLoader.load(path)
			var valid: bool = resource is PackedScene
			if resource is Script:
				var script: Script = resource
				valid = ClassDB.is_parent_class(script.get_instance_base_type(), "Node")
			if not valid:
				autoload_failures.append(name.trim_prefix("autoload/"))
	print(${JSON.stringify(marker)} + JSON.stringify({"failures": failures, "mainSceneValid": main_valid, "autoloadFailures": autoload_failures}))

func _process(_delta: float) -> bool:
	return true
`
}
