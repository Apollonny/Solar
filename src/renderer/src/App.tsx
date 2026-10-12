import { useCallback, useEffect, useRef, useState } from 'react'
import type { AspectMode, GameState, InitialState, ProjectInfo, SetupStatus } from '../../shared/types'
import { EcsPanel } from './components/EcsPanel'
import { ExportModal } from './components/ExportModal'
import { GameView } from './components/GameView'
import { SceneView } from './components/SceneView'
import { SetupOverlay } from './components/SetupOverlay'
import { TitleBar } from './components/TitleBar'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { readSolarStorage, writeSolarStorage } from './storage'

/** Which panel occupies the center pane. */
type CenterView = 'game' | 'scene' | 'ecs'

const SIDEBAR_WIDTH_KEY = 'sidebarWidth'
const ASPECT_KEY = 'aspect'
const ASPECT_MODES: AspectMode[] = ['any', 'desktop', 'mobile-portrait', 'mobile-landscape']
// Leave enough room for prompts, tool output, and file names without
// crowding the game preview at the app's minimum window width.
const SIDEBAR_DEFAULT = 360
const SIDEBAR_MIN = 260
const SIDEBAR_MAX = 560

export function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const [appError, setAppError] = useState<string | null>(null)
  const projectAction = useRef(false)
  const playPending = useRef(false)
  const activeProjectPath = useRef<string | null>(null)
  const [project, setProject] = useState<ProjectInfo | null>(null)
  activeProjectPath.current = project?.path ?? null
  const [recents, setRecents] = useState<ProjectInfo[]>([])
  const [godotPath, setGodotPath] = useState<string | null>(null)
  const [opencodePath, setOpencodePath] = useState<string | null>(null)

  const [gameState, setGameState] = useState<GameState>({ status: 'stopped' })
  const [gameError, setGameError] = useState<string | null>(null)
  const [aspect, setAspectState] = useState<AspectMode>(() => {
    const saved = readSolarStorage(ASPECT_KEY) as AspectMode | null
    return saved && ASPECT_MODES.includes(saved) ? saved : 'any'
  })

  const setAspect = useCallback((mode: AspectMode) => {
    writeSolarStorage(ASPECT_KEY, mode)
    setAspectState(mode)
  }, [])

  const [exportOpen, setExportOpen] = useState(false)
  const [centerView, setCenterView] = useState<CenterView>('game')
  const [sceneOpenRequest, setSceneOpenRequest] = useState(0)

  // Advanced mode gates the ECS viewer, files/git sidebars and console
  // output. Persisted in the main-process settings file (not localStorage)
  // since it applies on the home page too, before any project is open.
  const [advancedMode, setAdvancedModeState] = useState(false)
  // Drives whether `.titlebar` reserves room for the macOS traffic lights —
  // they disappear in native fullscreen, so the reserved gap should too.
  const [isFullScreen, setIsFullScreen] = useState(false)
  useEffect(() => window.api.onFullscreenChange(setIsFullScreen), [])
  const setAdvancedMode = useCallback((value: boolean) => {
    setAdvancedModeState(value)
    void window.api.setAdvancedMode(value)
  }, [])
  // Dropping out of advanced mode only closes the ECS view.
  useEffect(() => {
    if (!advancedMode) setCenterView((view) => view === 'ecs' ? 'game' : view)
  }, [advancedMode])

  // AI provider setup: fetched app-wide (not project-scoped) so the settings
  // gear works from both the title bar and the welcome screen. Re-checked on
  // window focus so running `opencode auth login` externally, or connecting
  // elsewhere, clears the overlay without a restart.
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    const check = (): void => {
      void window.api.getSetupStatus().then((r) => {
        if (r.ok) setSetup(r.data)
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  const opencodeAvailable = opencodePath !== null
  // The embedded game renders as a native layer the OS composites above the
  // web contents — DOM can't cover it, so hide it while the ECS tab is open
  // or while a modal (settings/export) is up; mirrors their render conditions.
  const modalOpen = (exportOpen && project !== null) || (settingsOpen && setup !== null)
  useEffect(() => {
    window.api.setGameLayerVisible(centerView === 'game' && !modalOpen)
    window.api.setSceneEditorVisible(centerView === 'scene' && !modalOpen)
  }, [centerView, modalOpen])

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(readSolarStorage(SIDEBAR_WIDTH_KEY))
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT
  })

  useEffect(() => {
    window.api.getInitialState().then((result) => {
      if (result.ok) {
        const state: InitialState = result.data
        setProject(state.project)
        setRecents(state.recentProjects)
        setGodotPath(state.godotPath)
        setOpencodePath(state.opencodePath)
        setAdvancedModeState(state.advancedMode)
        setIsFullScreen(state.isFullScreen)
      } else setAppError(result.error)
      setBooted(true)
    }).catch((err) => {
      setAppError(err instanceof Error ? err.message : String(err))
      setBooted(true)
    })
  }, [])

  useEffect(() => window.api.onGameState(setGameState), [])

  const handleProjectOpened = useCallback((opened: ProjectInfo) => {
    setProject(opened)
    setGameError(null)
    setGameState({ status: 'stopped' })
    setCenterView('game')
    setAppError(null)
    setExportOpen(false)
  }, [])

  const goHome = useCallback(async () => {
    if (projectAction.current) return
    projectAction.current = true
    try {
      const closed = await window.api.closeProject()
      if (!closed.ok) { setAppError(closed.error); return }
      setProject(null)
      setGameState({ status: 'stopped' })
      setGameError(null)
      setCenterView('game')
      setExportOpen(false)
      setAppError(null)
      const result = await window.api.getInitialState()
      if (result.ok) setRecents(result.data.recentProjects)
      else setAppError(result.error)
    } catch (err) {
      setAppError(err instanceof Error ? err.message : String(err))
    } finally {
      projectAction.current = false
    }
  }, [])

  const play = useCallback(async () => {
    if (playPending.current) return
    playPending.current = true
    const path = activeProjectPath.current
    setGameError(null)
    // Always show the game the user just started.
    setCenterView('game')
    try {
      const result = await window.api.playGame()
      if (!result.ok && activeProjectPath.current === path) setGameError(result.error)
    } catch (err) {
      if (activeProjectPath.current === path) setGameError(err instanceof Error ? err.message : String(err))
    } finally {
      playPending.current = false
    }
  }, [])

  const stop = useCallback(() => {
    void window.api.stopGame()
  }, [])

  const locateGodot = useCallback(async () => {
    const result = await window.api.locateGodot()
    if (result.ok && result.data) {
      setGodotPath(result.data)
      setGameError(null)
    } else if (!result.ok) {
      setGameError(result.error)
    }
  }, [])

  // Sidebar drag-resize: track the pointer on the whole window while dragging.
  const dragging = useRef(false)
  const onDividerMouseDown = useCallback(() => {
    dragging.current = true
    document.body.classList.add('resizing')
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth - e.clientX))
      setSidebarWidth(width)
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSidebarWidth((w) => {
        writeSolarStorage(SIDEBAR_WIDTH_KEY, String(w))
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const platformClass =
    window.api.platform === 'darwin' ? `app mac${isFullScreen ? ' fullscreen' : ''}` : 'app'

  if (!booted) return <div className={platformClass} />

  return (
    <div className={platformClass}>
      {appError && <div className="error-banner" role="alert">{appError}</div>}
      {project && <TitleBar
        project={project}
        gameState={gameState}
        aspect={aspect}
        onSetAspect={setAspect}
        onPlay={play}
        onStop={stop}
        onHome={goHome}
        onExport={() => setExportOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        advancedMode={advancedMode}
        onToggleAdvancedMode={setAdvancedMode}
      />}
      {exportOpen && project && <ExportModal projectName={project.name} onClose={() => setExportOpen(false)} />}
      {settingsOpen && setup && (
        <SetupOverlay
          status={setup}
          onConfigured={setSetup}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {project ? (
        <div className="content-row">
          <div className="center-pane">
            <div className="center-tabs">
              <button
                className={centerView === 'game' ? 'center-tab active' : 'center-tab'}
                onClick={() => setCenterView('game')}
              >
                Game
              </button>
              {window.api.platform === 'win32' && (
                <button
                  className={centerView === 'scene' ? 'center-tab active' : 'center-tab'}
                  onClick={() => setCenterView('scene')}
                >
                  2D / 3D
                </button>
              )}
              {advancedMode && (
                <button
                  className={centerView === 'ecs' ? 'center-tab active' : 'center-tab'}
                  onClick={() => setCenterView('ecs')}
                >
                  ECS
                </button>
              )}
            </div>
            {/* GameView stays mounted while hidden so the run, its console
                output and the input overlay survive tab switches. */}
            <div className="center-body" style={{ display: centerView === 'game' ? undefined : 'none' }}>
              <GameView
                key={project.path}
                state={gameState}
                error={gameError}
                godotPath={godotPath}
                aspect={aspect}
                onPlay={play}
                onStop={stop}
                onLocateGodot={locateGodot}
                onDismissError={() => setGameError(null)}
                advancedMode={advancedMode}
              />
            </div>
            {window.api.platform === 'win32' && (
              <div className="center-body" style={{ display: centerView === 'scene' ? undefined : 'none' }}>
                <SceneView key={project.path} active={centerView === 'scene' && !modalOpen} openRequest={sceneOpenRequest} />
              </div>
            )}
            {advancedMode && centerView === 'ecs' && <EcsPanel key={project.path} />}
          </div>
          <div
            className="divider"
            role="separator"
            aria-label="Resize assistant panel"
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            title="Drag or use arrow keys to resize the assistant panel"
            onMouseDown={onDividerMouseDown}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 40 : 20
              const next = event.key === 'ArrowLeft'
                ? sidebarWidth + step
                : event.key === 'ArrowRight'
                  ? sidebarWidth - step
                  : event.key === 'Home'
                    ? SIDEBAR_MIN
                    : event.key === 'End'
                      ? SIDEBAR_MAX
                      : null
              if (next === null) return
              event.preventDefault()
              const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next))
              setSidebarWidth(width)
              writeSolarStorage(SIDEBAR_WIDTH_KEY, String(width))
            }}
          />
          <Workspace
            key={project.path}
            project={project}
            width={sidebarWidth}
            opencodeAvailable={opencodeAvailable}
            setup={setup}
            onSetupUpdated={setSetup}
            advancedMode={advancedMode}
            onLocateGodot={locateGodot}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenScene={() => { setCenterView('scene'); setSceneOpenRequest(value => value + 1) }}
          />
        </div>
      ) : (
        <Welcome
          recents={recents}
          onProjectOpened={handleProjectOpened}
          onOpenSettings={() => setSettingsOpen(true)}
          advancedMode={advancedMode}
          onToggleAdvancedMode={setAdvancedMode}
        />
      )}
    </div>
  )
}
