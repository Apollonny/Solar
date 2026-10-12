import { useRef, useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import logo from '../assets/solar-mark.png'
import { AdvancedToggle } from './AdvancedToggle'
import { BrandWordmark } from './BrandWordmark'
import { DiscordButton } from './DiscordButton'
import { ExternalIcon, FolderIcon, GearIcon, PlusIcon } from './Icons'

interface Props {
  recents: ProjectInfo[]
  onProjectOpened: (project: ProjectInfo) => void
  onOpenSettings: () => void
  advancedMode: boolean
  onToggleAdvancedMode: (value: boolean) => void
}

/**
 * First screen: create a new game (name + storage location) or open an
 * existing Godot project. This is where the user picks where their game's
 * source code lives on disk.
 */
export function Welcome({
  recents,
  onProjectOpened,
  onOpenSettings,
  advancedMode,
  onToggleAdvancedMode
}: Props): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('My First Game')
  const [parentDir, setParentDir] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const browse = async (): Promise<void> => {
    const result = await window.api.chooseDirectory()
    if (result.ok && result.data) setParentDir(result.data)
  }

  const open = async (action: () => Promise<{ ok: true; data: ProjectInfo | null } | { ok: false; error: string }>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (result.ok && result.data) onProjectOpened(result.data)
      else if (!result.ok) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || !parentDir) return
    await open(() => window.api.createProject(parentDir, name))
  }

  const openDialog = async (): Promise<void> => {
    await open(() => window.api.openProjectDialog())
  }

  const openRecent = async (path: string): Promise<void> => {
    await open(() => window.api.openProject(path))
  }

  const folderSlug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_ ]/g, '')
      .replace(/\s+/g, '-') || 'my-game'

  return (
    <div className={creating ? 'welcome is-creating' : 'welcome'}>
      <div className="welcome-ambient" aria-hidden="true" />
      <div className="welcome-shell">
        <div className="welcome-head">
          <span className="welcome-brand">
            <img src={logo} alt="" className="brand-mark-img" />
            <BrandWordmark />
          </span>
          <div className="welcome-head-actions">
            <AdvancedToggle value={advancedMode} onChange={onToggleAdvancedMode} />
            <button className="icon-btn" title="AI settings" aria-label="AI settings" onClick={onOpenSettings}>
              <GearIcon size={17} />
            </button>
            <DiscordButton />
          </div>
        </div>
        <div className="welcome-main">
          <main className="welcome-card">
            <div className="welcome-symbol" aria-hidden="true">
              <img src={logo} alt="" />
            </div>
            <h1 className="welcome-title">
              Create worlds<br />with AI.
            </h1>
            <p className="tagline">
              From first idea to playable game. Create with an AI assistant, shape it in Godot, and see every change come to life.
            </p>

            {!creating ? (
              <div className="welcome-actions">
                <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => setCreating(true)}>
                  <PlusIcon /> Create a game
                </button>
                <button className="btn btn-ghost btn-lg" disabled={busy} onClick={openDialog}>
                  <FolderIcon /> Open a project
                </button>
              </div>
            ) : (
              <div className="new-form">
                <label className="form-row">
                  <span className="label">Game name</span>
                  <input
                    className="text-input"
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && create()}
                  />
                </label>
                <label className="form-row">
                  <span className="label">Location</span>
                  <div className="path-row">
                    <input
                      className="text-input path-input"
                      value={parentDir}
                      placeholder="Choose where to store your game…"
                      onChange={(e) => setParentDir(e.target.value)}
                    />
                    <button className="btn btn-ghost" onClick={browse}>
                      Browse…
                    </button>
                  </div>
                </label>
                {parentDir && (
                  <p className="path-preview">
                    Will create <code>{parentDir}/{folderSlug}</code> with a starter Godot project and a git repository.
                  </p>
                )}
                <div className="welcome-actions">
                  <button
                    className="btn btn-primary btn-lg"
                    disabled={busy || !name.trim() || !parentDir}
                    onClick={create}
                  >
                    {busy ? 'Creating…' : 'Create Game'}
                  </button>
                  <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {error && <p className="welcome-error" role="alert">{error}</p>}
          </main>
          <aside className="welcome-side">
            <div className="welcome-side-head">
              <h2>Recent projects</h2>
              <span>
                {recents.length} {recents.length === 1 ? 'project' : 'projects'}
              </span>
            </div>
            {recents.length > 0 ? (
              <div className="recents">
                {recents.map((r) => (
                  <button key={r.path} className="recent-item" disabled={busy} onClick={() => openRecent(r.path)}>
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.path}</span>
                    <span className="recent-arrow" aria-hidden="true">
                      <ExternalIcon size={15} />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="welcome-empty">
                <span className="welcome-empty-orbit" aria-hidden="true" />
                <p>Your next world starts here.</p>
                <span>Created and opened projects will appear in this space.</span>
              </div>
            )}
            <p className="welcome-side-foot">Powered by Godot. Directed by you.</p>
          </aside>
        </div>
        <div className="welcome-foot">
          <span>Solar</span>
          <span>CREATE WORLDS WITH AI</span>
        </div>
      </div>
    </div>
  )
}
