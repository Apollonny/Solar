import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProductionSettings, ProductionState, StudioReadiness } from '../../../shared/production'
import type { SetupStatus } from '../../../shared/types'
import { DownArrowIcon } from './Icons'

const stages = ['Planning','Developing','Applying','Runtime','Tests','Quality review']
const stageIndex: Record<string,number> = { planning:0, prepare:0, skills:0, tea_strategy:0, developing:1, applying:2, validating:2, runtime:3, tests:4, quality_review:5 }
const labels: Record<string,string> = { planning:'Planning', prepare:'Preparing story', skills:'Selecting relevant skills', tea_strategy:'Defining test strategy', developing:'Developing', applying:'Applying changes', validating:'Validating project', runtime:'Verifying gameplay', tests:'Running tests', quality_review:'Reviewing evidence' }
const statusLabels: Record<ProductionState['status'],string> = { running:'In progress', reconnecting:'Reconnecting', approval_required:'Review needed', complete:'Complete', answered:'Answered', blocked:'Needs attention', fail:'Changes needed', stale:'Project changed', cancelled:'Stopped' }
const evidenceLabels: Record<string,string> = { validation:'Project validation',test:'Test report',runtime:'Runtime logs',screenshot:'Screenshot',interaction:'Input recording',vision:'Image review' }
function Check({ ready }: { ready: boolean }): React.JSX.Element {
  return <svg className={ready ? 'studio-check ready' : 'studio-check'} width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" />{ready && <path d="m6.5 10 2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}</svg>
}
function elapsed(start: string | undefined, now: number): string {
  const seconds = start ? Math.max(0, Math.floor((now - Date.parse(start)) / 1000)) : 0
  return Number.isFinite(seconds) ? seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` : '—'
}
export function ProductionPanel({ projectPath, setup, chatBusy, onOpenSettings, onOpenScene }: { projectPath: string; setup: SetupStatus | null; chatBusy: boolean; onOpenSettings: () => void; onOpenScene: () => void }): React.JSX.Element {
  const [settings, setSettings] = useState<ProductionSettings | null>(null)
  const [readiness, setReadiness] = useState<StudioReadiness | null>(null)
  const [state, setState] = useState<ProductionState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [checking, setChecking] = useState(false)
  const [now, setNow] = useState(Date.now())
  const generation = useRef(0), checkGeneration = useRef(0)
  const active = state?.status === 'running' || state?.status === 'reconnecting' || state?.status === 'approval_required'
  const refresh = useCallback(async (verify = false): Promise<void> => {
    const epoch = generation.current, check = ++checkGeneration.current
    setChecking(true)
    try {
      const result = await window.api.studioReadiness(verify)
      if (epoch !== generation.current || check !== checkGeneration.current) return
      if (result.ok && result.data.projectPath === projectPath) setReadiness(result.data)
      else if (!result.ok) setError(result.error)
    } catch { if (epoch === generation.current && check === checkGeneration.current) setError('Studio check could not connect. Try again.') }
    finally { if (epoch === generation.current && check === checkGeneration.current) setChecking(false) }
  }, [projectPath])
  const acceptState = useCallback((next: ProductionState | null) => {
    if (next && next.projectPath !== projectPath) return
    setState(previous => !next || previous && previous.runId === next.runId && previous.eventSeq > next.eventSeq ? previous : next)
  }, [projectPath])
  useEffect(() => {
    const epoch = ++generation.current
    setState(null); setReadiness(null); setError(''); setNotice('')
    void Promise.all([window.api.productionSettings(),window.api.productionState()]).then(([config,run]) => {
      if (epoch !== generation.current) return
      if (config.ok) setSettings(config.data); else setError(config.error)
      if (run.ok) acceptState(run.data); else setError(run.error)
    }).catch(() => { if (epoch === generation.current) setError('Game Studio could not load. Reopen this project to reconnect.') })
    const off = window.api.onProductionState(next => { if (epoch === generation.current) acceptState(next) })
    return () => { generation.current++; off() }
  }, [projectPath,acceptState])
  const setupId = JSON.stringify([setup?.chat.provider,setup?.chat.endpoint,setup?.chat.model,setup?.configured,setup?.image.provider,setup?.image.endpoint,setup?.image.model,setup?.image.configured])
  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.api.onSceneEditorState(() => { clearTimeout(timer); timer = setTimeout(() => void refresh(),350) })
    return () => { clearTimeout(timer); off() }
  }, [refresh,setupId])
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()),1000)
    return () => clearInterval(timer)
  }, [active])
  const action = async (request: () => Promise<{ ok: boolean; error?: string }>, success = ''): Promise<void> => {
    const epoch = generation.current
    setPending(true); setError(''); setNotice('')
    try {
      const result = await request()
      if (epoch !== generation.current) return
      if (!result.ok) setError(result.error ?? 'Operation could not complete. Try again.'); else { setNotice(success); await refresh() }
    } catch { if (epoch === generation.current) setError('Workflow connection is unavailable. Try again.') }
    finally { if (epoch === generation.current) setPending(false) }
  }
  const busy = pending || checking
  return <section className="production-panel" aria-label="Game Studio">
    <details open={settings?.enabled || active || undefined}>
      <summary className="studio-summary"><span>Game Studio <span className="production-badge">Preview</span></span><span className="studio-summary-end"><span className={`studio-summary-status ${state && ['blocked','fail','stale'].includes(state.status) ? 'attention' : ''}`}>{settings?.enabled && state ? statusLabels[state.status] : settings?.enabled ? 'Enabled' : 'Optional'}</span><DownArrowIcon /></span></summary>
      <p className="production-hint">Plan, build and verify a playable story in Godot.</p>
      <label className="production-switch"><input type="checkbox" checked={settings?.enabled ?? false} disabled={busy || active || chatBusy || !settings?.ready} onChange={event => {
        const enabled = event.target.checked
        void action(async () => { const result = await window.api.productionConfigure(enabled); if (result.ok) setSettings(result.data); return result },enabled ? 'Game Studio is enabled for new messages.' : 'Standard assistant is enabled for new messages.')
      }} /> Use Game Studio for new messages</label>
      {settings && !settings.ready && <p className="production-error">{settings.message}</p>}
      {settings?.enabled && <>
        {state && <div className={`studio-run ${state.status}`}>
          <div className="production-current" role="status"><strong>{state.status==='reconnecting'?'Reconnecting':active ? labels[state.phase] ?? state.phase : statusLabels[state.status]}</strong>{active && <span className="studio-elapsed">{elapsed(state.progress?.startedAt ?? state.startedAt,now)}</span>}</div>
          <ol className="studio-stages" aria-label="Workflow stages">{stages.map((name,index) => <li key={name} className={index === stageIndex[state.phase] ? 'current' : index < stageIndex[state.phase] || state.status === 'complete' ? 'visited' : ''} aria-current={index === stageIndex[state.phase] && active ? 'step' : undefined}>{name}</li>)}</ol>
          <div className="studio-actions">
            {!active && state.canResume && ['blocked','cancelled','fail'].includes(state.status) && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void action(() => window.api.productionResume(state.runId))}>Resume saved work</button>}
            {!active && ['blocked','fail'].includes(state.status) && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onOpenSettings}>AI settings</button>}
            {active && <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => void action(() => window.api.chatCancel())}>Stop workflow</button>}
          </div>
      
          {active && state.progress && <p className="production-hint">{state.progress.firstResponse ? 'Model is responding' : 'Waiting for the model’s first response'} · {state.progress.toolsStarted} tool calls{state.progress.toolsFailed > 0 ? ` · ${state.progress.toolsFailed} need attention` : ''}</p>}
          {state.recovery && <p className="production-hint" role="status">Attempt {state.recovery.attempt} of {state.recovery.maxAttempts}{state.recovery.nextAttemptAt ? ` · retrying in ${Math.max(0,Math.ceil((Date.parse(state.recovery.nextAttemptAt)-now)/1000))}s` : ' · reconnecting…'}</p>}
          {state.repair > 0 && <p className="production-hint">Fixing issues · attempt {state.repair} of 2</p>}
          {state.message && <p className="production-hint studio-message">{state.message}</p>}
          {state.status === 'approval_required' && state.approval && <div className="production-approval">
            <p>{state.approval.summary}</p>
            <details><summary>Review scope · {state.approval.files.length} files</summary><ul>{state.approval.files.map(path => <li key={path}><code>{path}</code></li>)}</ul><p className="production-hint">{state.approval.operations.join(', ')}</p><p className="production-hint">Revision {state.approval.projectRevision.slice(0,12)} · story revision {state.approval.taskRevision}</p></details>
            <div className="studio-actions"><button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void action(() => window.api.productionApprove(state.runId,state.approval!.operationId,true))}>Approve changes</button><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void action(() => window.api.productionApprove(state.runId,state.approval!.operationId,false))}>Decline</button></div>
          </div>}    {state.gate && <details className="production-gate"><summary>Quality review · {state.gate.status}</summary>
            {state.gate.reasons.map((reason,index) => <p key={index}>{reason}</p>)}
            {state.gate.checks.map(check => <div className="studio-criterion" key={check.criterionId}><Check ready={check.passed} /><div><strong>{state.criteria?.find(criterion=>criterion.id===check.criterionId)?.description ?? check.criterionId}</strong><span className="studio-check-label">{check.passed ? 'Accepted' : 'Not accepted'}</span><div className="production-evidence">{check.evidenceIds.map((id,index) => <button key={id} className="btn btn-sm btn-ghost" disabled={pending} onClick={() => void action(() => window.api.productionRevealEvidence(state.runId,id))}>{evidenceLabels[state.evidence?.find(artifact=>artifact.id===id)?.kind ?? ''] ?? `Evidence ${index + 1}`}</button>)}</div></div></div>)}
          </details>}
        </div>}
        {!active && <div className="studio-readiness" aria-busy={checking}>
          <h4>Project readiness</h4>
          <div className="studio-actions">
            {readiness && readiness.bundled && readiness.addons.status !== 'ready' && <button className="btn btn-sm btn-primary" disabled={busy || readiness.editor.status === 'ready' || readiness.editor.status === 'opening'} onClick={() => void action(() => window.api.productionPrepareProject(),'Project prepared. Open its editor, then check connections.')}>Prepare project</button>}
            {readiness && readiness.addons.status !== 'ready' && readiness.editor.status === 'ready' && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void action(() => window.api.closeSceneEditor(),'Editor closed. You can prepare this project now.')}>Close editor to prepare</button>}
            {readiness?.addons.status === 'ready' && readiness.editor.status === 'closed' && <button className="btn btn-sm btn-primary" disabled={busy} onClick={onOpenScene}>Open editor</button>}
            {readiness?.editor.status === 'error' && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onOpenScene}>Show editor</button>}
            {!readiness?.models.configured && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onOpenSettings}>AI settings</button>}
            <button className="btn btn-sm btn-ghost" disabled={busy || !settings.ready} onClick={() => { setError(''); setNotice(''); void refresh(true) }}>{checking ? 'Checking…' : 'Check connections'}</button>
          </div>
          {!readiness ? <p className="production-hint">{checking ? 'Checking this project…' : 'Check this project before starting a story.'}</p> : <ul>
            <li><Check ready={readiness.addons.status === 'ready'} /><div><strong>Project tools</strong><p>{readiness.addons.message}</p></div></li>
            <li><Check ready={readiness.editor.verified} /><div><strong>Godot editor</strong><p>{readiness.editor.message}</p></div></li>
            <li><Check ready={readiness.models.verified} /><div><strong>AI models</strong><p>{!readiness.models.configured ? 'Set up chat and image review models in AI settings.' : readiness.models.reasons.join(' ') || (readiness.models.verified ? 'Chat and image review connections checked.' : 'Models configured. Check their connections before starting a story.')}</p></div></li>
          </ul>}
          {readiness?.models.configured && <div className="studio-models"><span title={readiness.models.chat}>Chat · {readiness.models.chat}</span><span title={readiness.models.vision}>Review · {readiness.models.vision}</span></div>}
          <p className="production-hint">{readiness?.ready ? 'Ready for a story. Describe a small playable feature below.' : 'You can use the editor while setup is incomplete.'}</p>
          {readiness?.addons.status !== 'ready' && <details className="production-install"><summary>What project preparation changes</summary><p>With the editor closed, Solar installs its editor gateway and test runner in this project’s addons folder. Save your scenes first. Modified or independently installed addons are preserved.</p></details>}
        </div>}
      </>}
      {notice && <p className="production-hint" role="status">{notice}</p>}
      {error && <p className="production-error" role="alert">{error}</p>}
    </details>
  </section>
}
