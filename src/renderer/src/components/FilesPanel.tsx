import { useCallback, useEffect, useState } from 'react'
import type { FileEntry, ProjectInfo } from '../../../shared/types'
import { AssetLibrary } from './AssetLibrary'
import {
  ChevronIcon,
  CollapseAllIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GodotLogoIcon,
  RefreshIcon,
  VSCodeLogoIcon
} from './Icons'

interface Props {
  project: ProjectInfo
  refreshToken: number
  onLocateGodot: () => Promise<void>
  onUseAsset: (request: string) => void
}

/**
 * Explorer-style lazy file tree (modeled on VS Code): compact rows, indent
 * guides, folder twisties, header icon actions. Directory listings are cached
 * by absolute path; refresh re-lists every open directory in place so the
 * tree does not collapse when the AI changes files.
 */
export function FilesPanel({ project, refreshToken, onLocateGodot, onUseAsset }: Props): React.JSX.Element {
  const [view, setView] = useState<'project'|'library'>('project')
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({})
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openingGodot, setOpeningGodot] = useState(false)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)

  useEffect(() => window.api.onGodotEditorFailure((failure) => {
    if (failure.projectPath.toLowerCase() !== project.path.toLowerCase()) return
    setNotice(null)
    setError(failure.message)
    setRecoveryAvailable(!failure.recoveryMode)
  }), [project.path])

  const load = useCallback(async (path: string): Promise<void> => {
    const result = await window.api.listDir(path)
    if (result.ok) {
      setDirs((prev) => ({ ...prev, [path]: result.data }))
    } else {
      // Directory vanished (deleted/renamed) — drop it from the cache.
      setDirs((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      setOpenDirs((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [])

  useEffect(() => {
    void load(project.path)
  }, [project.path, load])

  const refreshAll = useCallback((): void => {
    void load(project.path)
    openDirs.forEach((dir) => void load(dir))
  }, [load, openDirs, project.path])

  useEffect(() => {
    if (refreshToken === 0) return
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  const toggle = (path: string): void => {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!dirs[path]) void load(path)
      }
      return next
    })
  }

  const openExternal = async (kind: 'vscode' | 'godot', target?: string, recoveryMode = false): Promise<void> => {
    setError(null)
    setNotice(null)
    setRecoveryAvailable(false)
    if (kind === 'godot') setOpeningGodot(true)
    try {
      const result =
        kind === 'vscode' ? await window.api.openInVSCode(target) : await window.api.openInGodotEditor(recoveryMode)
      if (!result.ok) {
        setError(result.error)
        setRecoveryAvailable(kind === 'godot' && !recoveryMode && result.error.startsWith('Godot Editor closed'))
      } else if (kind === 'godot') {
        setNotice(
          result.data
            ? recoveryMode ? 'Godot Editor started in recovery mode.' : 'Godot Editor started for this project.'
            : 'Godot Editor is already open or handed off to another window.'
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (kind === 'godot') setOpeningGodot(false)
    }
  }

  const renderEntries = (parent: string, depth: number): React.JSX.Element[] => {
    const entries = dirs[parent] ?? []
    return entries.flatMap((entry) => {
      const isOpen = entry.isDirectory && openDirs.has(entry.path)
      const row = (
        <div
          key={entry.path}
          role="button"
          tabIndex={0}
          className={selected === entry.path ? 'tree-row selected' : 'tree-row'}
          onClick={() => {
            setSelected(entry.path)
            if (entry.isDirectory) toggle(entry.path)
          }}
          onDoubleClick={() => {
            if (!entry.isDirectory) void openExternal('vscode', entry.path)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setSelected(entry.path)
              if (entry.isDirectory) toggle(entry.path)
              else void openExternal('vscode', entry.path)
            }
          }}
          title={entry.isDirectory ? entry.name : `${entry.name} — double-click to open in VS Code`}
        >
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="indent-guide" />
          ))}
          <span className={isOpen ? 'tree-twist open' : 'tree-twist'}>
            {entry.isDirectory && <ChevronIcon size={10} />}
          </span>
          <span className="tree-icon">
            {entry.isDirectory ? (isOpen ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />) : <FileIcon size={14} />}
          </span>
          <span className="tree-name">{entry.name}</span>
        </div>
      )
      return isOpen ? [row, ...renderEntries(entry.path, depth + 1)] : [row]
    })
  }

  return (
    <div className="files-panel">
      <div className="asset-library-nav" role="group" aria-label="File tools"><button className={view==='project'?'active':''} aria-pressed={view==='project'} onClick={()=>setView('project')}>Project files</button><button className={view==='library'?'active':''} aria-pressed={view==='library'} onClick={()=>setView('library')}>Asset library</button></div>
    {view==='library'?<AssetLibrary projectPath={project.path} onUseAsset={onUseAsset}/>:<>
      <div className="panel-header">
        <span className="panel-title-caps" title={project.path}>
          {project.name}
        </span>
        <span className="header-actions push-right">
          <button className="icon-btn sm" title="Collapse all" onClick={() => setOpenDirs(new Set())}>
            <CollapseAllIcon size={14} />
          </button>
          <button className="icon-btn sm" title="Refresh" onClick={refreshAll}>
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      <div className="open-btns">
        <button className="open-btn" onClick={() => void openExternal('vscode')}>
          <VSCodeLogoIcon size={14} /> VS Code
        </button>
        <button className="open-btn" disabled={openingGodot} title="Open Godot Editor (stops a running game preview)" onClick={() => void openExternal('godot')}>
          <GodotLogoIcon size={14} /> {openingGodot ? 'Opening Godot…' : 'Godot Editor'}
        </button>
      </div>

      {error && (
        <div className="error-banner small">
          {error}
          {recoveryAvailable && (
            <button className="btn btn-sm btn-ghost" disabled={openingGodot}
              title="Starts Godot without editor plugins and tool scripts"
              onClick={() => void openExternal('godot', undefined, true)}>
              Open in recovery mode
            </button>
          )}
          {(error.toLowerCase().includes('bundled godot engine is missing') ||
            error.toLowerCase().includes('could not start godot editor')) && (
            <button className="btn btn-sm btn-ghost" onClick={() => void onLocateGodot()}>
              Locate Godot…
            </button>
          )}
        </div>
      )}
      {notice && <div className="setup-hint">{notice}</div>}

      <div className="tree">{renderEntries(project.path, 0)}</div>
      </>}
    </div>
  )
}
