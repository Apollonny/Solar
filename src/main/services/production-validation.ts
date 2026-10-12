import type { TaskContract } from '../../shared/production'
import { gatewayRead } from './godot-execution'
import { lockedProductionAddons } from './production-addons'
import { digest } from './production-store'
import { validateProject } from './project-validation'

/** Product checks keep the full import/revision; only verified bundled sources
 * are excluded from the per-file budget. User addons retain ordinary checks. */
export async function validateProductionProject(task: TaskContract, signal: AbortSignal) {
  const state = await gatewayRead(task.projectPath, 'editor_state')
  if (state.solar_compatibility !== 1 || !Array.isArray(state.solar_unsaved_scenes) || !Array.isArray(state.solar_unsaved_scripts) || state.solar_unsaved_scenes.length || state.solar_unsaved_scripts.length || state.is_playing) throw new Error('The gateway cannot attest a saved, idle editor for validation.')
  const groups = await lockedProductionAddons()
  const result = await validateProject(task.projectPath, {
    runId: task.runId, taskRevision: task.taskRevision, signal,
    dependencies: groups.map(group => ({ directory: 'addons/' + group.name, files: Object.fromEntries(group.files.map(file => ['addons/' + group.name + '/' + file.path, digest(file.data)])) })),
    // A successful authenticated editor_state from the exact embedded PID proves
    // this plugin is active. Other user plugins are never implicitly attested.
    verifiedEditorPlugins: ['res://addons/godot_ai/plugin.cfg']
  })
  if (result.projectRevision !== task.projectRevision) result.status = 'stale'
  return result
}
