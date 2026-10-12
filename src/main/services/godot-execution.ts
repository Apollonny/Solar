import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ChangeSet, EditorCommand } from '../../shared/production'
import { developerTools, object } from '../../shared/production-changes'
import { getEmbeddedEditorIdentity } from './scene-editor'
import { ProductionRpc } from './production-rpc'
import { vendorDirectory, verifyVendor } from './production-store'
import { snapshotProject, type ProjectSnapshot } from './project-snapshot'
import { stopGame } from './game'
import { prepareLibraryImports, libraryWriteCommands, assertLibraryClasses } from './asset-library'

interface McpResult { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string; data?: string; mimeType?: string }[] }
function payload(reply: McpResult): Record<string, unknown> {
  if (reply.isError) throw new Error('Godot AI rejected the editor operation: ' + (reply.content?.find(c => c.type === 'text')?.text ?? '').slice(0, 600))
  let value = reply.structuredContent
  if (!value) {
    const text = reply.content?.find(c => c.type === 'text')?.text
    if (!text) throw new Error('Godot AI did not return a structured result.')
    value = JSON.parse(text) as unknown
  }
  const result = object(value)
  if (result.error || result.success === false) throw new Error('Godot AI reported an unsuccessful operation: ' + JSON.stringify(result.error ?? result).slice(0, 600))
  return result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? object(result.data) : result
}
let transport: ProductionRpc | null = null
let connecting: Promise<ProductionRpc> | null = null
let runtimeOwner: string | null = null
let cleanupUnconfirmed = false
let session: { id: string; project: string; pid: number } | null = null
const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', GODOT_AI_DISABLE_TELEMETRY: 'true', OTEL_SDK_DISABLED: 'true' }

async function connect(): Promise<ProductionRpc> {
  if (transport) return transport
  if (connecting) return connecting
  connecting = (async () => {
    await verifyVendor('execution')
    const python = join(vendorDirectory('execution'), 'python/python.exe')
    // Upstream attach serializes backend startup, generates independent rotating
    // capabilities and starts ONLY this bundled interpreter/package. No uvx or
    // dependency resolution. A separate manual spawn races its capability record.
    const rpc = new ProductionRpc(python, ['-m', 'godot_ai', 'attach', '--port', '8000', '--ws-port', '9500', '--exclude-domains', 'testing', '--disable-telemetry'], env, 'Godot execution gateway')
    rpc.onExit = () => { if (transport === rpc) transport = null; session = null }
    try {
      await rpc.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'solar-execution-gateway', version: '1.0.0' } }, 45_000)
      rpc.notify('notifications/initialized')
      transport = rpc; return rpc
    } catch (error) { rpc.close(); throw error }
  })().finally(() => { connecting = null })
  return connecting
}

async function raw(tool: string, args: Record<string, unknown>): Promise<McpResult> {
  return (await connect()).call<McpResult>('tools/call', { name: tool, arguments: args }, 45_000)
}
async function verifySession(projectPath: string): Promise<string> {
  const editor = getEmbeddedEditorIdentity()
  if (!editor || resolve(editor.projectPath).toLowerCase() !== resolve(projectPath).toLowerCase()) throw new Error('Godot execution is unavailable. Open this project in Solar’s 2D / 3D editor after preparing its gateway.')
  const root = await realpath(projectPath)
  const listed = payload(await raw('session_manage', { op: 'list' }))
  const sessions = listed.sessions
  if (!Array.isArray(sessions)) throw new Error('Godot AI did not enumerate editor sessions.')
  const matching = sessions.map(object).filter(item => typeof item.project_path === 'string' && resolve(item.project_path).toLowerCase() === root.toLowerCase() && item.editor_pid === editor.pid && item.plugin_version === '4.2.3')
  if (matching.length !== 1 || typeof matching[0].session_id !== 'string') throw new Error('Godot AI is unavailable for this embedded editor session. No separate editor will be launched.')
  const id = matching[0].session_id
  if (session?.id !== id) { await raw('session_activate', { session_id: id }); session = { id, pid: editor.pid, project: root } }
  return id
}
export async function gatewayTools(projectPath: string): Promise<unknown[]> {
  await verifySession(projectPath)
  const response = await (await connect()).call<{ tools: { name: string; inputSchema: unknown; description?: string }[] }>('tools/list', {})
  return response.tools.filter(t => developerTools.includes(t.name)).map(t => ({ name: t.name, inputSchema: t.inputSchema, description: t.description?.slice(0, 600) }))
}
export async function gatewayRead(projectPath: string, tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!['editor_state', 'scene_get_hierarchy', 'node_get_properties', 'logs_read'].includes(tool)) throw new Error('Unsupported gateway read.')
  const id = await verifySession(projectPath)
  return payload(await raw(tool, { ...args, session_id: id }))
}
/** Wait only before binding a new contract. Never rebase a prepared ChangeSet. */
export async function stableEditorSnapshot(projectPath: string, signal?: AbortSignal): Promise<ProjectSnapshot> {
  let previous: ProjectSnapshot | null = null
  let stableSince = 0
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const state = await gatewayRead(projectPath, 'editor_state')
    const current = await snapshotProject(projectPath, { signal })
    if (state.solar_filesystem_scanning === false && current.complete && current.revision === previous?.revision) {
      if (Date.now() - stableSince >= 1000) return current
    } else stableSince = Date.now()
    previous = current
    await new Promise<void>(done => setTimeout(done, 250))
  }
  throw new Error('The editor is still importing or the saved project is changing. Wait before starting a story.')
}
export async function applyEditorChanges(projectPath: string, change: ChangeSet, signal: AbortSignal, journal: (step: { index: number; status: 'starting' | 'committed'; response?: unknown }) => Promise<void>): Promise<{ revision: string; results: unknown[]; parseFailure: boolean }> {
  const id = await verifySession(projectPath)
  const state = await gatewayRead(projectPath, 'editor_state')
  if (state.solar_compatibility !== 1 || !Array.isArray(state.solar_unsaved_scenes) || !Array.isArray(state.solar_unsaved_scripts)) throw new Error('The editor cannot prove unsaved scene/script safety. Prepare the Solar compatibility gateway.')
  if (state.solar_unsaved_scenes.length || state.solar_unsaved_scripts.length || state.is_playing) throw new Error('Save your unsaved scenes/scripts and stop the game before applying this story.')
  const before = await snapshotProject(projectPath, { signal })
  if (!before.complete || before.revision !== change.projectRevision) throw new Error('ChangeSet revision is stale; no editor operation was applied.')
  for (const file of change.files) if ((before.files.get(file.path)?.hash ?? null) !== file.expectedHash) throw new Error('ChangeSet file conflict: ' + file.path)
  const results: unknown[] = []
  let parseFailure = false
  const ownScenes = new Set<string>()
  let knownRevision = before.revision
  let knownSnapshot = before
  const permitted = new Set(change.files.map(f => f.path))
  const generated = (path: string): boolean => path.endsWith('.uid') && permitted.has(path.slice(0,-4)) || path.endsWith('.import') && permitted.has(path.slice(0,-7))
  const metadataOnly = (previous:ProjectSnapshot,next:ProjectSnapshot):boolean => {
    if(!next.complete || !next.revision)return false
    for(const path of previous.files.keys())if(!next.files.has(path))return false
    for(const [path,file] of next.files) {
      if(previous.files.get(path)?.hash===file.hash)continue
      if(!generated(path))return false
      const source=path.slice(0,path.endsWith('.uid')?-4:-7)
      if(!previous.files.has(source)||previous.files.get(source)?.hash!==next.files.get(source)?.hash)return false
      if(path.endsWith('.uid')?!/^uid:\/\/[a-z0-9]+\s*$/.test(file.text??''):!/^\[remap\]/.test(file.text??''))return false
    }
    return true
  }
  const assets = await prepareLibraryImports(change.assetImports ?? [])
  assertLibraryClasses(assets,before.files)
  const writes = assets.flatMap(file => {
    if (!change.files.some(precondition => precondition.path === file.path)) throw new Error('Asset dependency lacks its declared precondition.')
    const existing = before.files.get(file.path)
    if (existing && !file.engineMetadata && existing.hash !== file.sha256) throw new Error('Existing library asset was preserved: ' + file.path)
    return existing ? [] : libraryWriteCommands(file)
  })
  const commands = [...writes, ...(writes.length ? [{ tool: 'filesystem_manage', args: { op: 'scan' } }] : []), ...change.commands]
  for (const [index, command] of commands.entries()) {
    signal.throwIfAborted()
    if (await verifySession(projectPath) !== id) throw new Error('Editor session changed during application.')
    const current = await snapshotProject(projectPath, { signal })
    if (!current.complete || !current.revision || current.revision !== knownRevision && !metadataOnly(knownSnapshot,current)) throw new Error('The project changed during application. No further operation was applied.')
    knownRevision=current.revision;knownSnapshot=current
    const live = await gatewayRead(projectPath, 'editor_state')
    if (!Array.isArray(live.solar_unsaved_scripts) || live.solar_unsaved_scripts.length) throw new Error('An unsaved script appeared during application. No user script will be overwritten.')
    if (!Array.isArray(live.solar_unsaved_scenes) || live.solar_unsaved_scenes.some(path => typeof path !== 'string' || !ownScenes.has(path))) throw new Error('An unsaved scene appeared during application. No user scene will be saved.')
    const fileBound = ['node_create','node_set_property','node_manage','script_attach','scene_save','ui_manage','theme_manage','animation_create','resource_manage'].includes(command.tool)
    if (fileBound && typeof live.current_scene === 'string' && /^res:\/\/assets\/library\//i.test(live.current_scene)) throw new Error('Library scenes are immutable. Instantiate or adapt them in a declared product scene.')
    if (fileBound && (typeof live.current_scene !== 'string' || !change.files.some(file => 'res://' + file.path === live.current_scene))) throw new Error('Scene mutation lacks a precondition for the active scene.')
    if (fileBound && typeof live.current_scene === 'string') ownScenes.add(live.current_scene)
    // Commit an intent before any mutation. A disconnect after this point is
    // indeterminate and must never be retried as a transient provider error.
    await journal({ index, status: 'starting' })
    const result = payload(await raw(command.tool, { ...command.args, session_id: id }))
    results.push(result); await journal({ index, status: 'committed', response: result })
    let saved = await snapshotProject(projectPath, { signal })
    if(command.tool==='filesystem_manage'&&command.args.op==='scan') {
      const settled=await stableEditorSnapshot(projectPath,signal)
      if(settled.revision!==saved.revision&&!metadataOnly(saved,settled))throw new Error('Product files changed while Godot imported assets. Application stopped.')
      saved=settled
    }
    if (!saved.complete || !saved.revision) throw new Error('Application revision could not be reconciled.')
    knownRevision = saved.revision
    knownSnapshot = saved
    if (result.diagnostics_status === 'partial') throw new Error('Script validation evidence was truncated. Application stopped without acceptance.')
    if (Array.isArray(result.diagnostics) && result.diagnostics.some(d => object(d).level === 'error' || object(d).severity === 'error')) { parseFailure = true; break }
  }
  const after = await snapshotProject(projectPath, { signal })
  if (!after.complete || !after.revision) throw new Error('Cannot establish the applied project revision.')
  for (const [path, data] of after.files) if (before.files.get(path)?.hash !== data.hash && !permitted.has(path) && !generated(path)) throw new Error('The editor changed a file outside the declared ChangeSet: ' + path)
  for (const path of before.files.keys()) if (!after.files.has(path) && !permitted.has(path) && !generated(path)) throw new Error('A file outside the declared ChangeSet disappeared: ' + path)
  return { revision: after.revision, results, parseFailure }
}
export async function observeRuntime(projectPath: string, runId: string, scenario: EditorCommand[], signal: AbortSignal): Promise<{ runtime: unknown; interaction: unknown; image: Buffer; metadata: unknown; clean: boolean }> {
  const id = await verifySession(projectPath)
  const initial = await gatewayRead(projectPath, 'editor_state')
  if (cleanupUnconfirmed && !initial.is_playing) { runtimeOwner = null; cleanupUnconfirmed = false }
  if (runtimeOwner) throw new Error('Another production operation owns this Godot runtime. Confirm that it has stopped.')
  if (initial.is_playing) throw new Error('A user game is running. Stop it before workflow runtime verification.')
  runtimeOwner = runId; stopGame()
  try {
    const editorBefore = await gatewayRead(projectPath, 'logs_read', { source: 'editor', count: 500, include_details: true })
    const started = payload(await raw('project_run', { mode: 'main', autosave: false, session_id: id }))
    if (started.was_already_running) throw new Error('The runtime was already owned by another operation.')
    let state: Record<string, unknown> = {}
    for (let poll = 0; poll < 40; poll++) {
      signal.throwIfAborted(); state = await gatewayRead(projectPath, 'editor_state')
      if (state.game_capture_ready === true) break
      await new Promise<void>(done => setTimeout(done, 250))
    }
    if (state.game_capture_ready !== true) throw new Error('The runtime never supplied a live framebuffer capture channel.')
    const before = payload(await raw('game_manage', { op: 'get_scene_tree', params: { depth: 8 }, session_id: id }))
    const inputs: unknown[] = []
    if (!scenario.length || scenario.length > 12) throw new Error('No bounded gameplay interaction scenario was supplied.')
    for (const command of scenario) {
      signal.throwIfAborted()
      if (command.tool !== 'game_manage' || !['input_sequence', 'input_key', 'input_action', 'input_mouse', 'input_state', 'get_node_info'].includes(String(command.args.op))) throw new Error('Unsupported runtime evidence operation.')
      inputs.push(payload(await raw(command.tool, { ...command.args, session_id: id })))
    }
    if (!scenario.some(command => String(command.args.op).startsWith('input_') && command.args.op !== 'input_state')) throw new Error('The scenario did not send real game input.')
    const after = payload(await raw('game_manage', { op: 'get_scene_tree', params: { depth: 8 }, session_id: id }))
    const shot = await raw('editor_screenshot', { source: 'game', max_resolution: 1920, include_image: true, session_id: id })
    const metadata = payload(shot), image = shot.content?.find(c => c.type === 'image')
    if (!image?.data || image.mimeType !== 'image/png' || metadata.stale_frame || metadata.vision_description || metadata.routed_via) throw new Error('The gateway did not produce an original current framebuffer.')
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid framebuffer encoding.')
    const gameLogs = await gatewayRead(projectPath, 'logs_read', { source: 'game', count: 500, include_details: true })
    const editorLogs = await gatewayRead(projectPath, 'logs_read', { source: 'editor', count: 500, include_details: true, ...(typeof editorBefore.next_cursor === 'number' ? { since_cursor: editorBefore.next_cursor } : {}) })
    const text = JSON.stringify({ gameLogs, editorLogs })
    const clean = !gameLogs.truncated && !gameLogs.has_more && !gameLogs.stale_run_id && !editorLogs.truncated && !editorLogs.has_more && !gameLogs.editor_errors_count && !/"(?:level|severity)":"error"|SCRIPT ERROR|Parse Error|No loader found|CRASH|FATAL/i.test(text) && typeof gameLogs.run_id === 'string' && gameLogs.run_id === gameLogs.current_run_id
    return { runtime: { started, state, before, after, gameLogs, editorLogs, session: id }, interaction: { scenario, inputs, before, after }, image: bytes, metadata, clean }
  } finally {
    // Cleanup uses the pinned session, never the currently active editor hint.
    try {
      if (!transport) throw new Error('The runtime connection was lost before cleanup.')
      payload(await transport.call<McpResult>('tools/call', { name: 'project_manage', arguments: { op: 'stop', session_id: id } }))
      const stopped = await gatewayRead(projectPath, 'editor_state')
      if (stopped.is_playing) throw new Error('The verified runtime could not be stopped.')
      runtimeOwner = null
    } catch { cleanupUnconfirmed = true; throw new Error('Runtime cleanup is unconfirmed. Stop the game in the editor before starting another workflow.') }
  }
}
export function productionOwnsRuntime(): boolean { return runtimeOwner !== null }
export async function startGodotGateway(): Promise<void> { await connect() }
export function closeGodotGateway(): void { transport?.close(); transport = null; session = null }
