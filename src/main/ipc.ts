import { dialog, ipcMain } from 'electron'
import { inspectStudio } from './services/studio-readiness'
import { listAssetLibrary, queryAssetLibrary, installAssetPack } from './services/asset-library'
import { installLibraryAddon } from './services/asset-library-addons'
import type { AssetQuery } from '../shared/asset-library'
import type { ChatAttachment, GameInputEvent, GitChange, InitialState, ModelCatalogRequest, ProjectInfo, ReasoningEffort, Result, SceneEditorAction, SetupRequest, StageRect } from '../shared/types'
import { normalizeGodotPath, resolveGodot, resolveOpencode, validateGodotBinary } from './services/binaries'
import { scanEcs } from './services/ecs'
import * as files from './services/files'
import { handleGameInput, openGodotEditor, playGame, setGameLayerVisible, setStageRect, setTestMonitorRect, stopGame } from './services/game'
import { closeSceneEditor, getSceneEditorState, openSceneEditor, sceneEditorAction, setSceneEditorBounds, setSceneEditorVisible } from './services/scene-editor'
import { cancelProjectValidations, suspendProjectValidations } from './services/project-validation'
import * as git from './services/git'
import {
  appendInputHistory,
  clearChatHistory,
  loadChatState,
  saveChatHistory,
  saveChatHistoryPreservingSession
} from './services/chat-history'
import {
  answerQuestion,
  cancelChat,
  getSessionID,
  newChatSession,
  pendingQuestion,
  redoChat,
  rejectQuestion,
  resumeSession,
  sendChatMessage,
  shutdownChat,
  undoChat
} from './services/opencode'
import {
  getSetupStatus,
  listModelIds,
  migrateLegacyOpenCodeCredentials,
  restoreLegacyOpenCodeAuthBackup,
  saveSetup,
  setChatReasoningEffort
} from './services/opencode-setup'
import { cancelExport, revealExport, runExport } from './services/export'
import type { ExportPlatform } from '../shared/types'
import { createProject, openProject, projectInfoFor } from './services/projects'
import {
  addRecentProject,
  getAdvancedMode,
  getCurrentProject,
  getRecentProjectPaths,
  requireProject,
  setAdvancedMode,
  setCurrentProject,
  setGodotPath
} from './state'
import { getMainWindow } from './window'
import { approveProduction, cancelProduction, configureProduction, getProductionSettings, productionState, resumeProduction, revealProductionEvidence, sendProductionMessage } from './services/production-workflow'
import { prepareProductionProject } from './services/production-addons'
import { productionOwnsRuntime, startGodotGateway } from './services/godot-execution'
import { getProductionEnabled } from './state'

/**
 * Every handler is wrapped in a Result envelope so expected failures (godot
 * missing, git errors, invalid folders…) flow to the UI as messages instead
 * of opaque "Error invoking remote method" exceptions.
 */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<unknown>> => {
    try {
      return { ok: true, data: (await fn(...(args as never[]))) ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Opening/closing a project tears down anything bound to the previous one. */
let projectTransition: Promise<void> = Promise.resolve()
function activateProject(project: ProjectInfo | null): Promise<void> {
  const transition = projectTransition.then(async () => {
    const resumeValidation = suspendProjectValidations()
    try {
      await cancelProduction()
      shutdownChat()
      await cancelProjectValidations()
      await closeSceneEditor()
      stopGame()
      // A persistence failure must not leave a different project active than the UI received.
      if (project) addRecentProject(project.path)
      setCurrentProject(project)
    } finally { resumeValidation() }
  })
  projectTransition = transition.catch(() => {})
  return transition
}

export function registerIpcHandlers(): void {
  // ---- App / project lifecycle -------------------------------------------
  handle('app:getInitialState', async (): Promise<InitialState> => {
    const recents = await Promise.all(getRecentProjectPaths().map(projectInfoFor))
    return {
      project: getCurrentProject(),
      recentProjects: recents,
      godotPath: await resolveGodot(),
      opencodePath: await resolveOpencode(),
      advancedMode: getAdvancedMode(),
      isFullScreen: getMainWindow()?.isFullScreen() ?? false
    }
  })

  handle('app:setAdvancedMode', (value: boolean) => setAdvancedMode(Boolean(value)))

  handle('dialog:chooseDirectory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('project:create', async (parentDir: string, name: string): Promise<ProjectInfo> => {
    const project = await createProject(parentDir, name)
    await activateProject(project)
    return project
  })

  handle('project:open', async (path: string): Promise<ProjectInfo> => {
    const project = await openProject(path)
    await activateProject(project)
    return project
  })

  handle('project:openDialog', async (): Promise<ProjectInfo | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Open a Godot project',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const project = await openProject(result.filePaths[0])
    await activateProject(project)
    return project
  })

  handle('project:close', () => activateProject(null))

  // ---- Game ----------------------------------------------------------------
  handle('game:play', () => { if (productionOwnsRuntime()) throw new Error('The production workflow owns the game runtime. Stop the workflow first.'); return playGame(requireProject().path) })
  handle('game:stop', () => stopGame())
  // High-frequency fire-and-forget channels — plain listeners, no Result envelope.
  ipcMain.on('game:stageBounds', (_event, rect: StageRect) => setStageRect(rect))
  ipcMain.on('game:testMonitorBounds', (_event, rect: StageRect) => setTestMonitorRect(rect))
  ipcMain.on('game:input', (_event, input: GameInputEvent) => handleGameInput(input))
  ipcMain.on('game:layerVisible', (_event, visible: boolean) => setGameLayerVisible(Boolean(visible)))
  handle('game:locateGodot', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Locate the Godot application or binary',
      ...(process.platform === 'darwin' ? { defaultPath: '/Applications' } : {}),
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = normalizeGodotPath(result.filePaths[0])
    await validateGodotBinary(path)
    setGodotPath(path)
    return path
  })

  // ---- Godot scene workspace ----------------------------------------------
  handle('scene:open', async () => { if (getProductionEnabled()) await startGodotGateway(); return openSceneEditor(requireProject().path) })
  handle('scene:close', () => closeSceneEditor())
  handle('scene:state', () => getSceneEditorState())
  handle('scene:action', (action: SceneEditorAction) => sceneEditorAction(action))
  ipcMain.on('scene:bounds', (_event, rect: StageRect) => setSceneEditorBounds(rect))
  ipcMain.on('scene:visible', (_event, visible: boolean) => setSceneEditorVisible(Boolean(visible)))

  // ---- AI chat ---------------------------------------------------------------
  handle('chat:send', (message: string, attachments?: ChatAttachment[]) =>
    getProductionEnabled() ? sendProductionMessage(message, requireProject().path, attachments ?? []) : sendChatMessage(message, requireProject().path, attachments ?? [])
  )
  handle('chat:cancel', async () => { await cancelProduction(); cancelChat() })
  handle('production:settings', () => getProductionSettings())
  handle('production:configure', (enabled: boolean) => configureProduction(enabled === true))
  handle('production:state', () => productionState())
  handle('production:prepareProject', () => prepareProductionProject(requireProject().path))
  handle('production:studioReadiness', (verify: unknown) => inspectStudio(requireProject().path, verify === true))
  handle('production:resume', (runId: string) => resumeProduction(runId))
  handle('production:approve', (runId: string, operationId: string, approved: boolean) => approveProduction(runId, operationId, approved === true))
  handle('production:revealEvidence', (runId: string, evidenceId: string) => revealProductionEvidence(runId, evidenceId))
  // /undo & /redo: OpenCode's native session revert (conversation AND files).
  handle('chat:undo', () => undoChat(requireProject().path))
  handle('chat:redo', () => redoChat(requireProject().path))
  // /clear: fresh conversation and the saved transcript is forgotten (the
  // ↑/↓ input history intentionally survives — see chat-history.ts).
  handle('chat:new', async () => {
    newChatSession()
    await clearChatHistory(requireProject().path)
  })
  // Chat persistence takes explicit project paths (not requireProject): a
  // debounced save can still fire from the previous project's ChatPanel just
  // after the current project changed, and must land in its own folder.
  handle('chat:loadState', async (projectPath: string) => {
    const state = await loadChatState(projectPath)
    // Continue the saved conversation only when this is (still) the active
    // project — the AI then keeps its context, not just the visible log.
    if (getCurrentProject()?.path === projectPath) resumeSession(state.sessionID)
    return {
      messages: state.messages,
      inputHistory: state.inputHistory,
      // A window reload mid-turn must re-surface the question the assistant
      // is blocked on, or the turn would hang with no buttons anywhere.
      pendingQuestion: getCurrentProject()?.path === projectPath ? await pendingQuestion() : null
    }
  })
  // A save from a no-longer-active project (debounced saves race project
  // switches) can't vouch for the session id — preserve the file's own rather
  // than stamping null and severing the transcript from its conversation.
  handle('chat:saveHistory', (projectPath: string, messages: unknown[]) =>
    getCurrentProject()?.path === projectPath
      ? saveChatHistory(projectPath, messages, getSessionID())
      : saveChatHistoryPreservingSession(projectPath, messages)
  )
  handle('chat:appendInput', (projectPath: string, entry: string) => appendInputHistory(projectPath, entry))
  handle('chat:answerQuestion', (requestID: string, answers: string[][]) => answerQuestion(requestID, answers))
  handle('chat:rejectQuestion', (requestID: string) => rejectQuestion(requestID))
  handle('chat:setupStatus', () => getSetupStatus())
  handle('chat:setReasoningEffort', async (effort: ReasoningEffort) => {
    await setChatReasoningEffort(effort)
    return getSetupStatus()
  })
  handle('chat:saveSetup', async (request: SetupRequest) => {
    await saveSetup(request)
    return getSetupStatus()
  })
  handle('chat:listModelIds', (request: ModelCatalogRequest) => listModelIds(request))
  handle('chat:migrateLegacyOpenCodeCredentials', async (providerIds: string[]) => {
    await migrateLegacyOpenCodeCredentials(providerIds)
    return getSetupStatus()
  })
  handle('chat:restoreLegacyOpenCodeAuthBackup', async (backupId: string) => {
    await restoreLegacyOpenCodeAuthBackup(backupId)
    return getSetupStatus()
  })

  // ---- Export ----------------------------------------------------------------
  handle('export:run', (name: string, platforms: ExportPlatform[]) =>
    runExport(requireProject().path, name, platforms)
  )
  handle('export:cancel', () => cancelExport())
  handle('export:reveal', (path: string) => revealExport(path))

  // ---- ECS viewer -------------------------------------------------------------
  handle('ecs:scan', () => scanEcs(requireProject().path))

  // ---- Files -----------------------------------------------------------------
  handle('assets:library', () => listAssetLibrary())
  handle('assets:search', (query: AssetQuery) => queryAssetLibrary(query))
  handle('assets:install', (id: string) => installAssetPack(id))
  handle('assets:installAddon', (id: string, projectPath: string) => installLibraryAddon(id, projectPath))
  handle('assets:importArchive', async (id: string) => {
    const result = await dialog.showOpenDialog({ title: 'Import partner asset archive', properties: ['openFile'], filters: [{ name: 'Asset archives', extensions: ['zip', 'rar'] }] })
    return result.canceled || !result.filePaths[0] ? null : installAssetPack(id, result.filePaths[0])
  })
  handle('files:list', (dir: string) => files.listDir(dir))
  handle('files:openVSCode', (target?: string) => files.openInVSCode(target ?? requireProject().path))
  handle('files:openGodotEditor', (recoveryMode?: boolean) => openGodotEditor(requireProject().path, recoveryMode === true))

  // ---- Git ---------------------------------------------------------------------
  handle('git:status', () => git.status(requireProject().path))
  handle('git:init', () => git.init(requireProject().path))
  handle('git:stage', (paths: string[]) => git.stage(requireProject().path, paths))
  handle('git:unstage', (paths: string[]) => git.unstage(requireProject().path, paths))
  handle('git:discard', (change: GitChange) => git.discard(requireProject().path, change))
  handle('git:commit', (message: string) => git.commit(requireProject().path, message))
  handle('git:push', () => git.push(requireProject().path))
  handle('git:pull', () => git.pull(requireProject().path))
  handle('git:addRemote', (url: string) => git.addRemote(requireProject().path, url))
  handle('git:log', () => git.log(requireProject().path))
}
