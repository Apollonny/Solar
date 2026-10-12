/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. This file is the single source of truth for the IPC surface.
 */

/** Uniform envelope returned by every IPC call so the renderer can render errors inline. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export interface ProjectInfo {
  path: string
  name: string
}

export interface InitialState {
  project: ProjectInfo | null
  recentProjects: ProjectInfo[]
  /** Resolved path of the Godot binary, or null when it could not be found. */
  godotPath: string | null
  /** Resolved path of the OpenCode CLI, or null when it could not be found. */
  opencodePath: string | null
  /** Whether the ECS viewer, files/git sidebars and console output are shown. */
  advancedMode: boolean
  /** Whether the window is currently in native (macOS green-button) fullscreen. */
  isFullScreen: boolean
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitChange {
  /** Renames must update both paths when staging or unstaging. */
  originalPath?: string
  path: string
  /** Single-letter status code shown in the UI (M, A, D, R, ?, …). */
  status: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: GitChange[]
  unstaged: GitChange[]
  remotes: GitRemote[]
}

export interface GitCommit {
  hash: string
  subject: string
}

export interface ChatDonePayload {
  ok: boolean
  cancelled?: boolean
  error?: string
  recoverable?: boolean
  resumeRunId?: string
}

/**
 * A file the user attached to a chat message. Two flavors:
 *
 * - Inline (`dataUrl` set): images and small text files — ride the chat
 *   message itself as data-URL parts, never written into the game project.
 * - Asset upload (`path` set): .zip archives, whole folders, and binary asset
 *   files (3D models, audio, fonts) — too big/opaque to inline, so only the
 *   absolute disk path crosses to the main process, which copies the payload
 *   into the project's .solar/attachments/ when the message is sent and
 *   points the assistant at it there.
 */
export interface ChatAttachment {
  name: string
  mime: string
  dataUrl?: string
  path?: string
  /** True when `path` points at a folder. */
  dir?: boolean
}

/**
 * Persisted chat state for a project, loaded when it opens. `messages` is the
 * renderer's own transcript JSON — opaque to the main process; the renderer
 * validates the shape on restore.
 */
export interface SavedChatState {
  messages: unknown[]
  /** Everything the user ever sent, oldest first — for ↑/↓ recall. */
  inputHistory: string[]
  /** A question the assistant is still waiting on (survives window reloads). */
  pendingQuestion: ChatQuestionRequest | null
}

/** One choice offered by the assistant's interactive "question" tool. */
export interface ChatQuestionOption {
  label: string
  description: string
}

/** One question from the assistant's "question" tool (mirrors OpenCode's schema). */
export interface ChatQuestion {
  question: string
  /** Short chip/tag label, e.g. "Art style". */
  header: string
  options: ChatQuestionOption[]
  /** Allow selecting several options. */
  multiple?: boolean
  /** Allow a free-text answer. */
  custom?: boolean
}

/**
 * A pending "question" tool request. The turn blocks until every question is
 * answered (chatAnswerQuestion) or the request is dismissed
 * (chatRejectQuestion) — ignoring it would leave the tool spinning forever.
 */
export interface ChatQuestionRequest {
  id: string
  questions: ChatQuestion[]
}

/**
 * Whether the model should think before answering. Sent to the model as the
 * standard OpenAI-format `thinking: {"type": "enabled"|"disabled"}` request
 * field (see https://api-docs.deepseek.com/guides/thinking_mode/);
 * 'default' sends nothing and leaves the model on its own default.
 */
export type ThinkingMode = 'default' | 'enabled' | 'disabled'

/** Shared reasoning scale. The main process maps it to each provider's options; `default` sends no override. */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelSlotId = 'medium' | 'large' | 'image'

/** AI API family used by one model slot. `custom` is an OpenAI-compatible endpoint. */
export type ModelProviderId = 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'xai' | 'nvidia' | 'custom'

/** One model slot's stored connection settings, as shown in the setup panel. */
export interface ModelSlotStatus {
  /** API family selected for this slot. */
  provider: ModelProviderId
  /** Provider base URL, including a custom gateway when configured. */
  endpoint: string
  model: string
  /** A credential is locally available for this exact connection; generation access is not implied. */
  configured: boolean
  thinking: ThinkingMode
  effort: ReasoningEffort
  /** Model-specific choices when known; null means the provider did not publish them. */
  reasoningEfforts?: Exclude<ReasoningEffort, 'default'>[] | null
  /** Models with token-budget reasoning use this upper bound. */
  reasoningBudgetMax?: number | null
  /** Native Anthropic control selected from the model's published capabilities. */
  reasoningMode?: 'adaptive' | 'effort' | 'budget' | null
}

/** A legacy OpenCode API key currently stored in the shared auth.json file. */
export interface LegacyOpenCodeCredential {
  providerId: string
  slotLabels: string[]
}

/** Encrypted snapshot of auth.json made before a legacy credential migration. */
export interface OpenCodeAuthBackupStatus {
  id: string
  /** True only while auth.json still exactly matches the migrated snapshot. */
  restorable: boolean
}

/** State of the AI provider setup (API keys / endpoints / models). */
export interface SetupStatus {
  /** The chat connection has a locally available credential; generation access is not implied. */
  configured: boolean
  /** The model used for every assistant conversation. */
  chat: ModelSlotStatus
  /** Image-enabled model that powers the image-reader and game-tester subagents. */
  image: ModelSlotStatus
  /** True when Tencent HY 3D credentials are stored (enables 3D asset generation). */
  hy3dConfigured: boolean
  /** True when an OpenAI key is stored (enables 2D image asset generation). */
  gptImageConfigured: boolean
  /** Eligible API keys in OpenCode's shared plaintext auth file. */
  legacyOpenCodeCredentials: LegacyOpenCodeCredential[]
  /** Most recent encrypted auth.json backup, when one exists. */
  latestOpenCodeAuthBackup: OpenCodeAuthBackupStatus | null
  /** Read errors from OS-encrypted credential stores; settings remain available for recovery. */
  credentialStoreError?: string
}

/** One model slot's settings as submitted by the setup panel. */
export interface ModelSlotRequest {
  provider: ModelProviderId
  endpoint: string
  model: string
  /** Blank = keep the stored key for this provider and endpoint. */
  apiKey: string
  thinking: ThinkingMode
  effort: ReasoningEffort
  /** Catalog-confirmed effort choices, or null when the provider has no exact metadata. */
  reasoningEfforts?: Exclude<ReasoningEffort, 'default'>[] | null
  /** Catalog-confirmed upper bound for token-budget reasoning. */
  reasoningBudgetMax?: number | null
  reasoningMode?: 'adaptive' | 'effort' | 'budget' | null
}

/** Request to fetch a provider's available language model IDs for one slot. */
export interface ModelCatalogRequest {
  slot: ModelSlotId
  provider: ModelProviderId
  endpoint: string
  /** Blank asks the main process to use the slot's encrypted or saved key. */
  apiKey: string
}

/** Provider catalog entry with image-input capability when the provider reports it. */
export interface ModelCatalogItem {
  id: string
  /** null means this provider did not publish image-input support for the model. */
  supportsImageInput: boolean | null
  /** Exact model-specific values when published by the provider. */
  reasoningEfforts?: Exclude<ReasoningEffort, 'default'>[] | null
  /** Upper bound when reasoning is controlled by a token budget instead of an effort enum. */
  reasoningBudgetMax?: number | null
  reasoningMode?: 'adaptive' | 'effort' | 'budget' | null
  /** Whether reasoning controls are advertised when exact values are not published. */
  supportsReasoning?: boolean | null
}

/**
 * Everything the AI settings panel saves in one go. Blank credential fields
 * mean "leave the stored key unchanged"; blank endpoints/models fall back to
 * the defaults.
 */
export interface SetupRequest {
  chat: ModelSlotRequest
  image: ModelSlotRequest
  /** Optional asset-generation credentials (blank = unchanged). */
  tencentSecretId?: string
  tencentSecretKey?: string
  openaiApiKey?: string
}

/** A generated asset preview pushed into the chat so the user can react to it. */
export interface AssetPreview {
  /** data: URL of the preview image (PNG for 2D art, GIF turntable for 3D). */
  dataUrl: string
  /** Asset name the AI chose, e.g. "rocket". */
  label: string
  /** Project-relative folder the files were written to. */
  path: string
  kind: '2d' | '3d'
}

/** Live status of a tool invocation the AI is running. */
export type ChatToolStatus = 'pending' | 'running' | 'completed' | 'error'

/**
 * Incremental update for one part of a streaming assistant message.
 * Text/reasoning parts carry the full accumulated text (idempotent upsert);
 * tool parts carry their latest state.
 */
export interface ChatPartUpdate {
  messageID: string
  partID: string
  kind: 'text' | 'reasoning' | 'tool'
  text?: string
  tool?: {
    name: string
    status: ChatToolStatus
    title?: string
    /** Failure reason when status is 'error' — tooltip on the chip. */
    error?: string
    /** Set when a subagent (game-tester, image-reader) ran this tool — the chip is labelled with it. */
    agent?: string
  }
}

/**
 * How a running game is displayed.
 *  - 'embedded': rendered inside the stage as a native layer (macOS
 *    --embedded); the renderer's transparent overlay captures and forwards
 *    input.
 *  - 'embedded-window': the game's own borderless window is kept glued over
 *    the stage (Windows --wid embedding); the OS routes input to it directly,
 *    so no overlay is mounted.
 *  - 'external': free-floating OS window — the fallback wherever embedding is
 *    unavailable (Linux, failed addon builds, embedding errors).
 */
export type GamePresentation = 'embedded' | 'embedded-window' | 'external'

/** How the game is currently being presented. */
export interface GameState {
  status: 'stopped' | 'starting' | 'running'
  /** 'native' = embedded in the game view; 'test' = AI running it off-screen. */
  mode?: 'native' | 'test'
  /** Where the running game lives. Unset for test runs on macOS (the game is
   *  fully off-screen — nothing is presented). */
  view?: GamePresentation
  /** Test runs: true when the off-screen game can be mirrored live into the
   *  test monitor (layerhost addon available — macOS). */
  liveView?: boolean
  /** Test runs: the size the off-screen game renders at, so the live monitor
   *  box can reserve a matching shape. */
  testGameSize?: { width: number; height: number }
}

/** Viewport-relative rect of the game stage area, reported by the renderer. */
export interface StageRect {
  x: number
  y: number
  width: number
  height: number
}

/** Aspect-ratio presets for the game preview area (UI-side letterboxing). */
export type AspectMode = 'any' | 'desktop' | 'mobile-portrait' | 'mobile-landscape'

/** Platforms Godot can export a project to. */
export type ExportPlatform = 'windows' | 'macos' | 'linux' | 'web' | 'android' | 'ios'

/** Progress updates streamed while an export runs. */
export type ExportProgress =
  | { phase: 'templates'; message: string; percent: number }
  | { phase: 'platform'; platform: ExportPlatform; status: 'exporting' | 'success' | 'error'; message?: string }
  | { phase: 'done'; message?: string }

/**
 * A code file with a parsed `#=== solar ===` header block (the format the
 * injected agent instructions mandate for every file the AI writes — see
 * resources/agent-instructions.md). Backs the ECS viewer in the center pane.
 */
export interface EcsNode {
  /** Project-relative path, e.g. "components/c_health.gd". */
  path: string
  /** File basename without extension — the node id edges refer to, e.g. "c_health". */
  id: string
  /** entity | component | system | autoload | ui | util | shader | other */
  kind: string
  name: string
  summary: string
  /** Component ids (c_*) this file composes (entities) or processes (systems). */
  uses: string[]
  /** Free-form header lines beyond the standard keys, shown verbatim in the detail card. */
  extra: string[]
}

/** Modifier keys held during an input event. */
export interface GameInputModifiers {
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
}

/**
 * Input captured by the renderer over the embedded native game view,
 * forwarded to the game process. Coordinates are CSS px relative to the view.
 */
export type GameInputEvent =
  | (GameInputModifiers & {
      type: 'key'
      key: string
      code: string
      pressed: boolean
      echo: boolean
      location: number
    })
  | (GameInputModifiers & {
      type: 'mousebutton'
      button: number // DOM button index
      buttons: number // DOM buttons bitmask
      pressed: boolean
      doubleClick: boolean
      x: number
      y: number
    })
  | (GameInputModifiers & {
      type: 'mousemotion'
      x: number
      y: number
      relX: number
      relY: number
      buttons: number
    })
  | (GameInputModifiers & { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number })
  | { type: 'enter' }
  | { type: 'leave' }
  | { type: 'focus' }
  | { type: 'blur' }

export type SceneEditorState =
  | { status: 'idle' | 'opening' }
  | { status: 'ready'; mode: 'child' | 'owned'; backend?: 'libgodot' | 'executable' }
  | { status: 'error'; message: string }

export type SceneEditorAction = '2d' | '3d' | 'focus'

/** The API the preload script exposes on `window.api`. */
export interface SolarApi {
  assetLibrary(): Promise<Result<import('./asset-library').LibraryEntry[]>>
  assetSearch(query: import('./asset-library').AssetQuery): Promise<Result<import('./asset-library').AssetMatch[]>>
  assetInstall(packId: string): Promise<Result<import('./asset-library').LibraryEntry>>
  assetImportArchive(packId: string): Promise<Result<import('./asset-library').LibraryEntry | null>>
  assetInstallAddon(packId: string, projectPath: string): Promise<Result<string>>
  onAssetLibraryChanged(cb: () => void): () => void
  productionSettings(): Promise<Result<import('./production').ProductionSettings>>
  productionConfigure(enabled: boolean): Promise<Result<import('./production').ProductionSettings>>
  productionState(): Promise<Result<import('./production').ProductionState | null>>
  productionPrepareProject(): Promise<Result<null>>
  studioReadiness(verifyConnections?: boolean): Promise<Result<import('./production').StudioReadiness>>
  productionResume(runId: string): Promise<Result<null>>
  productionApprove(runId: string, operationId: string, approved: boolean): Promise<Result<null>>
  productionRevealEvidence(runId: string, evidenceId: string): Promise<Result<null>>
  onProductionState(cb: (state: import('./production').ProductionState) => void): () => void
  platform: string

  // App / project lifecycle
  getInitialState(): Promise<Result<InitialState>>
  chooseDirectory(): Promise<Result<string | null>>
  createProject(parentDir: string, name: string): Promise<Result<ProjectInfo>>
  openProject(path: string): Promise<Result<ProjectInfo>>
  openProjectDialog(): Promise<Result<ProjectInfo | null>>
  closeProject(): Promise<Result<null>>
  /** Persists whether advanced panels (ECS viewer, files, git, console) are shown. */
  setAdvancedMode(value: boolean): Promise<Result<null>>
  /** Fires when the window enters/exits native (macOS green-button) fullscreen. */
  onFullscreenChange(cb: (isFullScreen: boolean) => void): () => void

  // Game (Godot)
  playGame(): Promise<Result<null>>
  stopGame(): Promise<Result<null>>
  locateGodot(): Promise<Result<string | null>>
  /** Fire-and-forget: keeps the main process aware of where the stage is. */
  setGameStageBounds(rect: StageRect): void
  /** Fire-and-forget: where the AI test run's live monitor box sits, so the
   *  off-screen game's layer can be composited (scaled down) into it. */
  setTestMonitorBounds(rect: StageRect): void
  /** Fire-and-forget: input captured over the embedded native game view. */
  sendGameInput(event: GameInputEvent): void
  /**
   * Fire-and-forget: hides/shows the embedded native game layer. The layer is
   * composited by the OS above the web contents, so CSS cannot cover it —
   * the renderer must hide it while another center tab is active.
   */
  setGameLayerVisible(visible: boolean): void
  onGameLog(cb: (line: string) => void): () => void
  onGameState(cb: (state: GameState) => void): () => void
  /** Godot CursorShape the game requested over its view (native mode). */
  onGameCursor(cb: (shape: number) => void): () => void
  /** PNG data URL each time the AI captures a screenshot during a test run. */
  onGameTestShot(cb: (dataUrl: string) => void): () => void
  /** Measured game frame rate, ~1 update/second while a game runs. */
  onGameFps(cb: (fps: number) => void): () => void

  // Native Godot scene workspace (Windows)
  openSceneEditor(): Promise<Result<null>>
  closeSceneEditor(): Promise<Result<null>>
  getSceneEditorState(): Promise<Result<SceneEditorState>>
  sceneEditorAction(action: SceneEditorAction): Promise<Result<null>>
  setSceneEditorBounds(rect: StageRect): void
  setSceneEditorVisible(visible: boolean): void
  onSceneEditorState(cb: (state: SceneEditorState) => void): () => void

  // AI chat (OpenCode)
  chatSend(message: string, attachments?: ChatAttachment[]): Promise<Result<null>>
  /**
   * Absolute disk path of a picked/dropped File (Electron webUtils) — '' when
   * it has none (e.g. a File synthesized in the page). Synchronous.
   */
  pathForFile(file: File): string
  chatCancel(): Promise<Result<null>>
  /**
   * /undo: revert the conversation one user turn (OpenCode restores the files
   * that turn touched). `revertedTo` is the OpenCode id of the undone user
   * message — the renderer drops its transcript from the matching turn on.
   */
  chatUndo(): Promise<Result<{ revertedTo: string }>>
  /** /redo: step the revert point forward again (files and conversation). */
  chatRedo(): Promise<Result<null>>
  /** /clear: fresh conversation AND deletes the project's saved transcript. */
  chatNewSession(): Promise<Result<null>>
  /** Saved transcript + input history for a project; also resumes its AI session. */
  chatLoadState(projectPath: string): Promise<Result<SavedChatState>>
  /** Persist the transcript (called debounced whenever the chat settles). */
  chatSaveHistory(projectPath: string, messages: unknown[]): Promise<Result<null>>
  /** Record a sent message for ↑/↓ recall (kept even across /clear). */
  chatAppendInput(projectPath: string, entry: string): Promise<Result<null>>
  /** Answer a pending question — one array of selected labels per question, in order. */
  chatAnswerQuestion(requestID: string, answers: string[][]): Promise<Result<null>>
  /** Dismiss a pending question (the assistant is told and continues without answers). */
  chatRejectQuestion(requestID: string): Promise<Result<null>>
  getSetupStatus(): Promise<Result<SetupStatus>>
  /** Apply a reasoning level to the current chat model and reload OpenCode. */
  setChatReasoningEffort(effort: ReasoningEffort): Promise<Result<SetupStatus>>
  /** Credential fields left blank = leave that provider's setup unchanged. */
  saveSetup(request: SetupRequest): Promise<Result<SetupStatus>>
  /** Fetches model IDs for a provider without generating a model response. */
  listModelIds(request: ModelCatalogRequest): Promise<Result<ModelCatalogItem[]>>
  /** Copy selected legacy API entries into the encrypted vault and remove them from shared auth.json. */
  migrateLegacyOpenCodeCredentials(providerIds: string[]): Promise<Result<SetupStatus>>
  /** Restore the shared auth.json snapshot if it has not changed since migration. */
  restoreLegacyOpenCodeAuthBackup(backupId: string): Promise<Result<SetupStatus>>
  onChatPart(cb: (part: ChatPartUpdate) => void): () => void
  onChatDone(cb: (payload: ChatDonePayload) => void): () => void
  onChatConnection(cb: (state: import('./connection-recovery').ChatConnectionState) => void): () => void
  /** A generated 2D/3D asset preview to render in the chat (user can give feedback). */
  onAssetPreview(cb: (preview: AssetPreview) => void): () => void
  /** Fired (debounced) when the AI edits project files during a response. */
  onChatFilesChanged(cb: () => void): () => void
  /** The assistant asked interactive question(s) and is blocked on the reply. */
  onChatQuestion(cb: (request: ChatQuestionRequest) => void): () => void
  /** A pending question was resolved elsewhere (answered/rejected/expired). */
  onChatQuestionDone(cb: (requestID: string) => void): () => void

  // Export
  exportGame(name: string, platforms: ExportPlatform[]): Promise<Result<null>>
  cancelExport(): Promise<Result<null>>
  revealExport(path: string): Promise<Result<null>>
  onExportProgress(cb: (update: ExportProgress) => void): () => void

  // ECS viewer
  scanEcs(): Promise<Result<EcsNode[]>>

  // Files
  listDir(path: string): Promise<Result<FileEntry[]>>
  openInVSCode(target?: string): Promise<Result<null>>
  /** True when launched; false when already running for the current project. */
  openInGodotEditor(recoveryMode?: boolean): Promise<Result<boolean>>
  onGodotEditorFailure(cb: (failure: { projectPath: string; message: string; recoveryMode: boolean }) => void): () => void

  // Git
  gitStatus(): Promise<Result<GitStatus>>
  gitInit(): Promise<Result<null>>
  gitStage(paths: string[]): Promise<Result<null>>
  gitUnstage(paths: string[]): Promise<Result<null>>
  gitDiscard(change: GitChange): Promise<Result<null>>
  gitCommit(message: string): Promise<Result<string>>
  gitPush(): Promise<Result<string>>
  gitPull(): Promise<Result<string>>
  gitAddRemote(url: string): Promise<Result<null>>
  gitLog(): Promise<Result<GitCommit[]>>
}
