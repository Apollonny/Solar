import { useCallback, useEffect, useRef, useState } from 'react'
import type { SceneEditorAction, SceneEditorState } from '../../../shared/types'

export function SceneView({ active, openRequest = 0 }: { active: boolean; openRequest?: number }): React.JSX.Element {
  const stage = useRef<HTMLDivElement>(null)
  const attempted = useRef(false)
  const lastOpenRequest = useRef(openRequest)
  const [state, setState] = useState<SceneEditorState>({ status: 'idle' })
  const [actionError, setActionError] = useState<string | null>(null)

  const openEditor = useCallback((): void => {
    const rect = stage.current?.getBoundingClientRect()
    if (rect && rect.width >= 2 && rect.height >= 2) {
      window.api.setSceneEditorBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    setActionError(null)
    void window.api.openSceneEditor().then((result) => {
      if (!result.ok) setState({ status: 'error', message: result.error })
    }).catch((error) => {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }, [])

  const runAction = (action: SceneEditorAction): void => {
    setActionError(null)
    void window.api.sceneEditorAction(action).then((result) => {
      if (!result.ok) setActionError(result.error)
    })
  }

  useEffect(() => {
    const off = window.api.onSceneEditorState(setState)
    void window.api.getSceneEditorState().then((result) => {
      if (result.ok) setState(result.data)
    })
    return off
  }, [])

  useEffect(() => {
    window.api.setSceneEditorVisible(active)
    const requested = openRequest !== lastOpenRequest.current
    if (active && (state.status === 'idle' && !attempted.current || requested && !['ready','opening'].includes(state.status))) {
      attempted.current = true
      openEditor()
    }
    if (active) lastOpenRequest.current = openRequest
  }, [active, state.status, openEditor, openRequest])

  useEffect(() => {
    if (!active) return
    const element = stage.current
    if (!element) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      window.api.setSceneEditorBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active])

  return (
    <section className="scene-area">
      <div className="stage-toolbar">
        <div className="scene-toolbar-main">
          <span className="stage-toolbar-title">Scene editor</span>
          <div className="scene-toolbar-controls" role="group" aria-label="Godot scene tools">
            <button className="btn btn-sm btn-ghost" disabled={state.status !== 'ready'} title="Open Godot's 2D workspace" onClick={() => runAction('2d')}>2D</button>
            <button className="btn btn-sm btn-ghost" disabled={state.status !== 'ready'} title="Open Godot's 3D workspace" onClick={() => runAction('3d')}>3D</button>
            <button className="btn btn-sm btn-ghost" disabled={state.status !== 'ready'} title="Toggle Godot's distraction-free mode" onClick={() => runAction('focus')}>Focus mode</button>
          </div>
        </div>
        <span className={`preview-state ${actionError ? 'error' : state.status === 'ready' ? 'running' : state.status === 'opening' ? 'starting' : ''}`} role="status" title={actionError ?? (state.status === 'ready' && state.backend === 'libgodot'
          ? 'Experimental: Godot runs inside Solar. A native Godot crash will close Solar.'
          : state.status === 'ready' && state.mode === 'owned'
            ? 'Native child embedding is unavailable on this display; Solar is using window compatibility mode.'
            : undefined)}>
          <span className="preview-state-dot" />
          {actionError ?? (state.status === 'ready'
            ? state.backend === 'libgodot' ? 'In-process Godot' : state.mode === 'child' ? 'Embedded' : 'Compatibility mode'
            : state.status === 'opening' ? 'Opening Godot' : 'Godot')}
        </span>
      </div>
      <div className="scene-stage" ref={stage}>
        {state.status !== 'ready' && (
          <div className="scene-placeholder">
            {state.status === 'opening' && <div className="spinner big" />}
            <h2>{state.status === 'error' ? 'Scene editor could not open' : 'Godot scene editor'}</h2>
            <p className="muted">
              {state.status === 'error'
                ? state.message
                : state.status === 'opening'
                  ? 'Loading your project and its 2D and 3D editing tools…'
                  : 'Edit scenes visually with Godot’s native 2D and 3D tools.'}
            </p>
            {(state.status === 'error' || (state.status === 'idle' && attempted.current)) && (
              <div className="scene-actions">
                <button className="btn btn-primary" onClick={openEditor}>
                  {state.status === 'error' ? 'Try again' : 'Open scene editor'}
                </button>
                <button className="btn btn-ghost" onClick={() => {
                  void window.api.openInGodotEditor(false).then((result) => {
                    if (!result.ok) setState({ status: 'error', message: result.error })
                  })
                }}>
                  Open separately
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
