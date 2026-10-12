import type { ChangeSet, EditorCommand } from './production'
import { validProjectPath } from './production-gate'
import { ASSET_BYTE_PREFIX, safeLibraryPath, validateAssetPreset } from './asset-library'

const operations: Record<string, string[] | null> = {
  scene_open: null, scene_save: null, script_create: null, script_patch: null, script_attach: null,
  node_create: null, node_set_property: null,
  scene_manage: ['create', 'save_as'],
  node_manage: ['delete', 'duplicate', 'rename', 'move', 'reparent', 'add_to_group', 'remove_from_group'],
  filesystem_manage: ['write_text', 'scan', 'reimport'],
  project_manage: ['set_main_scene'],
  input_map_manage: ['add_action', 'ensure_action', 'bind_event'],
  resource_manage: ['create', 'assign', 'environment_create', 'curve_set_points', 'gradient_texture_create', 'noise_texture_create', 'physics_shape_autofit', 'physics_shape_generate'],
  animation_create: null, theme_manage: ['create', 'set_color', 'set_constant', 'set_font_size', 'apply'],
  ui_manage: ['set_anchor_preset', 'set_text', 'set_richtext', 'build_layout']
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.')
  return value as Record<string, unknown>
}
export function validateChangeSet(value: unknown, revision: string, identity: Pick<ChangeSet, 'runId'|'storyId'|'taskRevision'|'stageId'|'eventSeq'>): ChangeSet {
  const data = object(value)
  if (data.schemaVersion !== 1 || data.projectRevision !== revision || typeof data.summary !== 'string' || data.summary.length > 2000 || !Array.isArray(data.commands) || !data.commands.length || data.commands.length > 100 || !Array.isArray(data.files) || !data.files.length || data.files.length > 128 || JSON.stringify(data).length > 1024 * 1024) throw new Error('Invalid ChangeSet identity or bounds.')
  const seen = new Set<string>()
  if (data.assetImports !== undefined) {
    if (!Array.isArray(data.assetImports) || data.assetImports.length > 4) throw new Error('Invalid asset import scope.')
    for (const raw of data.assetImports) {
      const pack = object(raw)
      if (typeof pack.packId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack.packId) || !Array.isArray(pack.files) || !pack.files.length || pack.files.length > 24) throw new Error('Invalid asset source selection.')
      for (const file of pack.files) {
        const source = object(file)
        if (!safeLibraryPath(source.path) || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Asset selections require exact installed file hashes.')
        if(source.preset!==undefined)validateAssetPreset(source.preset)
      }
    }
  }
  for (const raw of data.files) {
    const file = object(raw)
    if(typeof file.path==='string'&&/^assets\/library\//i.test(file.path))throw new Error('Library file preconditions and immutable sources belong to Solar. Declare exact assetImports; put custom adaptations outside assets/library/.')
    if (!validProjectPath(file.path) || file.path.startsWith('addons/') || file.path === 'project.godot' && !data.commands.some(c => ['project_manage','input_map_manage'].includes(String(object(c).tool))) || !(file.expectedHash === null || typeof file.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(file.expectedHash)) || seen.has(file.path.toLowerCase())) throw new Error('Invalid ChangeSet file precondition.')
    seen.add(file.path.toLowerCase())
  }
  for (const raw of data.commands) {
    const command = object(raw), args = object(command.args)
    if (typeof command.tool !== 'string' || !(command.tool in operations) || 'session_id' in args || 'force_reload' in args) throw new Error('This editor operation is outside the developer capability.')
    const ops = operations[command.tool]
    if (ops && !ops.includes(String(args.op))) throw new Error('This editor operation is outside the developer capability.')
    // Resource paths, including nested references, must remain inside the game.
    const walk = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('res://')) {
        const path = value.slice(6)
        if (!validProjectPath(path) || path.startsWith('addons/')) throw new Error('Unsafe resource path.')
      } else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        if (['file', 'file_path', 'script_path', 'resource_path', 'scene', 'path'].includes(key) && typeof item === 'string' && item && !item.startsWith('/') && !item.startsWith('res://')) throw new Error('Resource paths must use res://.')
        walk(item)
      }
    }
    walk(args)
    if (['script_create','script_patch','scene_open'].includes(command.tool) && (typeof args.path !== 'string' || !args.path.startsWith('res://'))) throw new Error('File operations must use a project resource path.')
    if (command.tool === 'filesystem_manage' && args.op === 'reimport') {
      const params = object(args.params)
      if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 128 || params.paths.some(path => typeof path !== 'string' || !path.startsWith('res://') || !seen.has(path.slice(6).toLowerCase()))) throw new Error('Reimport paths must have declared resource preconditions.')
    }
    if (['filesystem_manage','scene_manage'].includes(command.tool) && !['scan','reimport'].includes(String(args.op))) {
      const params = object(args.params)
      if (typeof params.path !== 'string' || !params.path.startsWith('res://')) throw new Error('File operations must use a project resource path.')
    }
    if (['script_create','script_patch'].includes(command.tool)) {
      if (typeof args.path !== 'string' || !args.path.endsWith('.gd') || !seen.has(args.path.replace(/^res:\/\//, '').toLowerCase())) throw new Error('Script write lacks a GDScript file precondition.')
    }
    if (command.tool === 'scene_save' && args.path !== undefined && (typeof args.path !== 'string' || !args.path.startsWith('res://') || !seen.has(args.path.slice(6).toLowerCase()))) throw new Error('An explicit scene save needs a declared product file precondition.')
    if (['scene_manage'].includes(command.tool)) {
      const params = object(args.params)
      if (typeof params.path !== 'string' || !params.path.endsWith('.tscn') || !seen.has(params.path.replace(/^res:\/\//, '').toLowerCase())) throw new Error('Scene write lacks a file precondition.')
    }
    if (['project_manage','input_map_manage'].includes(command.tool) && !seen.has('project.godot')) throw new Error('Project setting change lacks its project.godot precondition.')
    if (command.tool === 'resource_manage') {
      const params = object(args.params)
      if (typeof params.resource_path === 'string' && params.resource_path && !seen.has(params.resource_path.replace(/^res:\/\//, '').toLowerCase())) throw new Error('Resource write lacks its file precondition.')
    }
    if (command.tool === 'filesystem_manage' && args.op === 'write_text') {
      const params = object(args.params)
      if (typeof params.content === 'string' && params.content.startsWith(ASSET_BYTE_PREFIX)) throw new Error('Binary asset envelopes are reserved for the host asset adapter.')
      if (typeof params.path !== 'string' || !seen.has(params.path.replace(/^res:\/\//, '').toLowerCase())) throw new Error('File write lacks a precondition.')
      if (!/\.(gd|tscn|tres|gdshader|gdshaderinc|json|csv|txt)$/.test(params.path)) throw new Error('This file type requires a dedicated asset adapter.')
    }
  }
  // The host binds the proposal to its current contract; model-supplied run IDs
  // cannot route or authorize an operation for another story/session.
  return { ...data, ...identity } as unknown as ChangeSet
}
export function criticalChange(change: ChangeSet): boolean { return change.commands.some((command: EditorCommand) => command.tool === 'node_manage' && command.args.op === 'delete' || command.tool === 'project_manage') }
export const developerTools = Object.keys(operations)
