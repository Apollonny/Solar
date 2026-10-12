import { useCallback, useEffect, useState } from 'react'
import type { LibraryEntry, AssetMatch } from '../../../shared/asset-library'
import { rankAssetPacks } from '../../../shared/asset-library'
import { ChevronIcon, RefreshIcon } from './Icons'

const size = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
interface Props { projectPath: string; onUseAsset: (request: string) => void }
export function AssetLibrary({ projectPath, onUseAsset }: Props): React.JSX.Element {
  const [entries,setEntries] = useState<LibraryEntry[]>([])
  const [query,setQuery] = useState('')
  const [dimension,setDimension] = useState<'any'|'2d'|'3d'>('any')
  const [selected,setSelected] = useState<string|null>(null)
  const [detail,setDetail] = useState<AssetMatch|null>(null)
  const [busy,setBusy] = useState<string|null>(null)
  const [error,setError] = useState<string|null>(null)
  const [loading,setLoading] = useState(true)
  const [notice,setNotice] = useState<string|null>(null)
  const refresh = useCallback(async(): Promise<void> => {
    try {const result = await window.api.assetLibrary();if(result.ok)setEntries(result.data);else setError(result.error)}
    catch(error){setError(error instanceof Error?error.message:String(error))}
    finally{setLoading(false)}
  },[])
  useEffect(()=>{void refresh();return window.api.onAssetLibraryChanged(()=>void refresh())},[refresh])
  useEffect(()=>{
    if(!selected){setDetail(null);return}
    let current = true
    void window.api.assetSearch({query,dimension,packId:selected}).then(result=>{if(current){if(result.ok)setDetail(result.data[0]??null);else setError(result.error)}}).catch(error=>{if(current)setError(error instanceof Error?error.message:String(error))})
    return ()=>{current=false}
  },[selected,query,dimension,entries])
  const acquire = async(id: string,local: boolean): Promise<void> => {
    setBusy(id);setError(null)
    try {const result = await (local?window.api.assetImportArchive(id):window.api.assetInstall(id));if(!result.ok)setError(result.error);await refresh()}
    catch(error){setError(error instanceof Error?error.message:String(error))}
    finally{setBusy(null)}
  }
  const installAddon = async(id:string):Promise<void>=>{
    setBusy(id);setError(null);setNotice(null)
    try {const result=await window.api.assetInstallAddon(id,projectPath);if(result.ok)setNotice(result.data);else setError(result.error)}
    catch(error){setError(error instanceof Error?error.message:String(error))}
    finally{setBusy(null)}
  }
  const rows = rankAssetPacks(entries,{query,dimension,limit:8})
  const visible = query.trim() ? rows.map(row=>row.pack) : entries.filter(pack=>dimension==='any'||pack.dimension==='any'||pack.dimension===dimension)
  return <section className="asset-library" aria-label="Asset library">
    <div className="asset-library-intro"><div><h3>Assets for your world</h3><p>Your assistant can choose and add assets that fit your game.</p></div><button className="icon-btn sm" aria-label="Refresh asset library" onClick={()=>void refresh()}><RefreshIcon size={14}/></button></div>
    <div className="asset-library-filters"><input type="search" aria-label="Search asset library" placeholder="Characters, forests, sound…" value={query} onChange={event=>setQuery(event.target.value)}/><select aria-label="Asset dimension" value={dimension} onChange={event=>setDimension(event.target.value as typeof dimension)}><option value="any">All</option><option value="2d">2D</option><option value="3d">3D</option></select></div>
    {error&&<div className="error-banner small" role="alert">{error}<button className="btn btn-sm btn-ghost" onClick={()=>setError(null)}>Dismiss</button></div>}
    {notice&&<p className="asset-library-empty" role="status">{notice}</p>}
    <div className="asset-library-list" aria-busy={loading}>
      {loading&&<p className="asset-library-empty">Loading your library…</p>}
      {!loading&&!visible.length&&<p className="asset-library-empty">No matching sources. Try another search or choose All.</p>}
      {visible.map(pack=><article className="asset-library-source" key={pack.id}>
        <button className="asset-library-row" aria-expanded={selected===pack.id} onClick={()=>setSelected(selected===pack.id?null:pack.id)}><span><strong>{pack.title}</strong><small>{pack.author} · {pack.dimension==='any'?'2D / 3D':pack.dimension.toUpperCase()} · {pack.kind}</small></span><span className={`asset-library-status ${pack.status==='ready'?'ready':''}`}>{pack.status==='ready'?`${pack.fileCount} files`:pack.status==='available'?'Get assets':pack.status==='reference'?'Guide':pack.status==='downloading'?'Downloading…':'Needs archive'}</span><ChevronIcon size={12}/></button>
        {selected===pack.id&&<div className="asset-library-detail"><p>{pack.notes}</p><a href={pack.url} target="_blank" rel="noreferrer">View source</a><span className="asset-library-license">{pack.license}{pack.bytes>0?` · ${size(pack.bytes)}`:''}</span>
          {pack.message&&<p className="asset-library-empty">{pack.message}</p>}
          <div className="asset-library-actions">{pack.status!=='ready'&&pack.status!=='reference'&&<button className="btn btn-sm btn-primary" disabled={busy!==null||pack.status==='downloading'} onClick={()=>void acquire(pack.id,false)}>{busy===pack.id?'Downloading…':'Download'}</button>}{pack.acquisition!=='reference'&&<button className="btn btn-sm btn-ghost" disabled={busy!==null} onClick={()=>void acquire(pack.id,true)}>Import archive</button>}{pack.kind==='addon'&&pack.status==='ready'?<button className="btn btn-sm btn-primary" disabled={busy!==null} onClick={()=>void installAddon(pack.id)}>{busy===pack.id?'Installing…':'Install Godot addon'}</button>:['ready','reference'].includes(pack.status)&&<button className="btn btn-sm btn-primary" onClick={()=>onUseAsset(`Use the Solar asset library source "${pack.title}" (${pack.id}) for my game. Recommend files for the gameplay mechanic, dimension and style. If suitable, import their Solar presets and use them in scenes.  `)}>Use in chat</button>}</div>
          {detail?.pack.id===pack.id&&detail.files.length>0&&<ul className="asset-library-file-list">{detail.files.slice(0,8).map(file=><li key={file.path} title={file.path}><span>{file.path.split('/').at(-1)}</span><small>{file.purpose==='reference'?'Guide · ':file.purpose==='palette'?'Palette · ':file.image?`${file.image.width}×${file.image.height} · `:''}{size(file.bytes)}</small></li>)}</ul>}
        </div>}
      </article>)}
    </div>
  </section>
}
