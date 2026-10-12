import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioReadiness } from '../../shared/production'
import { getCurrentProject } from '../state'
import { digest, vendorDirectory } from './production-store'
import { getSetupStatus } from './opencode-setup'
import { inspectProductionModels } from './production-preflight'
import { inspectProductionAddons } from './production-addons'
import { getEmbeddedEditorIdentity, getSceneEditorState } from './scene-editor'
import { gatewayRead } from './godot-execution'

/** Explicit connection checks are read-only; initial UI loading makes no API call. */
export async function inspectStudio(projectPath: string, verifyConnections: boolean): Promise<StudioReadiness> {
  const setup = await getSetupStatus()
  const bundled = process.platform === 'win32' && process.arch === 'x64' && (await Promise.all(['orchestrator','execution'].map(name => lstat(join(vendorDirectory(name as 'orchestrator'|'execution'),'manifest.json')).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false)))).every(Boolean)
  const addons = bundled ? await inspectProductionAddons(projectPath) : { status: 'unavailable' as const, message: 'Game Studio runtime is unavailable in this installation.' }
  const identity = getEmbeddedEditorIdentity(), state = getSceneEditorState()
  const matches = identity && (await realpath(identity.projectPath)).toLowerCase() === (await realpath(projectPath)).toLowerCase()
  let editor: StudioReadiness['editor'] = { status: matches ? 'ready' : state.status === 'opening' ? 'opening' : state.status === 'error' ? 'error' : 'closed', verified: false, message: matches ? 'Editor is open. Check its connection before starting a story.' : state.status === 'opening' ? 'Godot is opening…' : state.status === 'error' ? state.message : 'Open the project’s 2D / 3D editor.' }
  const configured = setup.configured && setup.image.configured
  const models: StudioReadiness['models'] = { chat: setup.chat.model, vision: setup.image.model, configurationId: digest(JSON.stringify([setup.chat.provider,setup.chat.endpoint,setup.chat.model,setup.chat.configured,setup.image.provider,setup.image.endpoint,setup.image.model,setup.image.configured])), configured, verified: false, reasons: configured ? [] : ['Configure a chat model and an image-enabled review model in AI settings.'] }
  if (verifyConnections && bundled) {
    const checked = await inspectProductionModels(AbortSignal.timeout(25_000))
    models.verified = checked.ready; models.reasons = checked.reasons
    if (matches && addons.status === 'ready') {
      try {
        const observed = await gatewayRead(projectPath,'editor_state')
        if (observed.solar_compatibility !== 1 || !Array.isArray(observed.solar_unsaved_scenes) || !Array.isArray(observed.solar_unsaved_scripts)) throw new Error('The editor cannot confirm safe scene operations. Prepare the project gateway.')
        if (observed.solar_unsaved_scenes.length || observed.solar_unsaved_scripts.length) throw new Error('Save your unsaved scenes and scripts before starting a story.')
        if (observed.is_playing || observed.solar_filesystem_scanning !== false) throw new Error('Stop the game and wait for asset imports to finish before starting a story.')
        editor = { status: 'ready', verified: true, message: 'Connected to this project’s embedded editor.' }
      } catch (error) { editor = { status: 'error', verified: false, message: (error as Error).message.slice(0,600) } }
    }
  }
  if (getCurrentProject()?.path !== projectPath) throw new Error('The active project changed during the Studio check.')
  const current = await getSetupStatus()
  if (models.configurationId !== digest(JSON.stringify([current.chat.provider,current.chat.endpoint,current.chat.model,current.chat.configured,current.image.provider,current.image.endpoint,current.image.model,current.image.configured]))) throw new Error('AI settings changed during the Studio check. Check connections again.')
  return { projectPath, checkedAt: new Date().toISOString(), bundled, addons, editor, models, ready: bundled && addons.status === 'ready' && editor.verified && models.verified }
}
