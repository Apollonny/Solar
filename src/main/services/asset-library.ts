import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve } from 'node:path'
import type { AssetImport, AssetMatch, AssetPack, AssetQuery, InstalledPack, LibraryEntry, LibraryFile } from '../../shared/asset-library'
import { ASSET_BYTE_PREFIX, assetFilePurpose, assetTarget, assetWords, IMPORTABLE_ASSET, rankAssetPacks, safeLibraryPath, validateAssetPreset } from '../../shared/asset-library'
import { buildAssetPreset, defaultAssetPreset, solarPresetPath } from './asset-presets'
import { acquirePack } from './asset-download'
import { extractLibraryArchive } from './asset-archive'
import { writeAtomic } from './json-file'
import { sendToRenderer } from '../window'
import { ensureProjectDirectory, resolveProjectFile } from './asset-store'
import { getCurrentProject, getProductionEnabled } from '../state'
import { getGameState } from './game'
import { snapshotProject } from './project-snapshot'
import { adaptLibraryShader } from './asset-compatibility'
import {scopeAssetQuery,taskAssetAllowed,type TaskSelectionPolicy} from '../../shared/ai-task-selection'

const hash=(data:Buffer|string):string=>createHash('sha256').update(data).digest('hex')
const busy=new Map<string,Promise<LibraryEntry>>()
// One library per OS user; legacy and Solar profiles share the same cache.
const root=():string=>process.env.SOLAR_ASSET_LIBRARY_ROOT??join(app.getPath('appData'),'Solar','asset-library')
const resourceRoot=():string=>app.isPackaged?join(process.resourcesPath,'app.asar.unpacked/resources'):join(app.getAppPath(),'resources')
export async function assetCatalog():Promise<AssetPack[]> {
  const catalog=JSON.parse(await readFile(join(resourceRoot(),'asset-library/catalog.json'),'utf8')) as {schemaVersion:number;packs:AssetPack[]}
  if(catalog.schemaVersion!==1 || catalog.packs.length!==14 || new Set(catalog.packs.map(p=>p.id)).size!==catalog.packs.length)throw new Error('Solar asset catalog is incomplete.')
  return catalog.packs
}
async function installed(id:string):Promise<InstalledPack|null> {
  const path=join(root(),id,'index.json'),info=await lstat(path).catch(()=>null)
  if(!info)return null
  if(!info.isFile() || info.isSymbolicLink() || info.size>8*1024*1024)throw new Error('Invalid library inventory.')
  const state=JSON.parse(await readFile(path,'utf8')) as InstalledPack
  if(state.schemaVersion!==1 || state.id!==id || !Array.isArray(state.files) || state.files.length>30000 || state.storageKey&&!/^[a-f0-9]{64}$/.test(state.storageKey))throw new Error('Invalid library inventory identity.')
  // The cache hash remains immutable; format support can expand between releases.
  state.files=state.files.map(file=>({...file,importable:IMPORTABLE_ASSET.test(file.path),purpose:assetFilePurpose(file.path)}))
  return state
}
async function realLibraryRoot():Promise<string> {
  await mkdir(root(),{recursive:true});const info=await lstat(root())
  if(!info.isDirectory() || info.isSymbolicLink())throw new Error('The asset library must be a real directory.')
  return realpath(root())
}
function entry(pack:AssetPack,state:InstalledPack|null):LibraryEntry {
  return {...pack,status:busy.has(pack.id)?'downloading':state?.status??'available',fileCount:state?.files.filter(f=>f.importable).length??0,bytes:state?.files.reduce((sum,f)=>sum+f.bytes,0)??0,message:state?.message}
}
export async function listAssetLibrary():Promise<LibraryEntry[]> {
  return Promise.all((await assetCatalog()).map(async pack=>entry(pack,await installed(pack.id))))
}
async function indexFiles(directory:string):Promise<LibraryFile[]> {
  const files:LibraryFile[]=[]
  const walk=async(part:string):Promise<void>=>{
    for(const item of await readdir(join(directory,part),{withFileTypes:true})) {
      const path=part?part+'/'+item.name:item.name
      if(item.isSymbolicLink() || !safeLibraryPath(path))throw new Error('Unsupported asset inventory path.')
      if(item.isDirectory())await walk(path)
      else if(item.isFile()) { const bytes=await readFile(join(directory,path));files.push({path,bytes:bytes.length,sha256:hash(bytes),importable:IMPORTABLE_ASSET.test(path)}) }
      if(files.length>30000)throw new Error('Asset inventory exceeds its limit.')
    }
  }
  await walk('');return files.sort((a,b)=>a.path.localeCompare(b.path))
}
export async function installAssetPack(id:string,archive?:string):Promise<LibraryEntry> {
  const existing=busy.get(id);if(existing)return existing
  const pack=(await assetCatalog()).find(pack=>pack.id===id);if(!pack)throw new Error('Unknown Solar asset source.')
  const work=(async()=>{
    const previous=await installed(id);if(previous&&['ready','reference'].includes(previous.status)&&!archive)return entry(pack,previous)
    const base=await realLibraryRoot(),staging=join(base,'.install-'+randomUUID());await mkdir(staging)
    try {
      let acquisition:Pick<InstalledPack,'archives'|'sourceRevision'>
      if(archive) {
        const info=await lstat(archive);if(!info.isFile()||info.isSymbolicLink()||info.size>768*1024*1024)throw new Error('Choose a regular ZIP/RAR archive below 768 MB.')
        const bytes=await readFile(archive);await extractLibraryArchive(archive,join(staging,'files'))
        acquisition={archives:[{name:archive.split(/[\\/]/).at(-1)!,bytes:bytes.length,sha256:hash(bytes)}]}
      }else acquisition=await acquirePack(pack,staging)
      const files=await indexFiles(join(staging,'files'))
      if(pack.acquisition!=='reference' && !files.some(file=>file.importable))throw new Error('The archive contains no supported Godot assets.')
      const storageKey=hash(JSON.stringify(files)),state:InstalledPack={schemaVersion:1,id,status:pack.acquisition==='reference'?'reference':'ready',storageKey,installedAt:new Date().toISOString(),...acquisition,files}
      const packDirectory=join(base,id);await mkdir(packDirectory,{recursive:true})
      if((await lstat(packDirectory)).isSymbolicLink())throw new Error('Library pack directory cannot be a link.')
      const archiveDirectory=join(staging,'archives')
      if(await lstat(archiveDirectory).catch(()=>null))await rm(archiveDirectory,{recursive:true,force:true}) // newly created private staging only
      const target=join(packDirectory,storageKey)
      if(!await lstat(target).catch(()=>null))await rename(staging,target)
      const index=join(packDirectory,'index.json'),original=await readFile(index,'utf8').catch(()=>null)
      await writeAtomic(index,JSON.stringify(state,null,2),original)
      sendToRenderer('assets:changed');return {...entry(pack,state),status:state.status}
    } catch(error) {
      if(!previous || previous.status==='unavailable') {
        const state:InstalledPack={schemaVersion:1,id,status:'unavailable',installedAt:new Date().toISOString(),archives:[],files:[],message:(error as Error).message}
        await mkdir(join(base,id),{recursive:true});const path=join(base,id,'index.json'),old=await readFile(path,'utf8').catch(()=>null);await writeAtomic(path,JSON.stringify(state,null,2),old)
      }
      throw error
    } finally {
      if(dirname(resolve(staging))!==base || !relative(base,staging).startsWith('.install-'))throw new Error('Unsafe library staging cleanup.')
      await rm(staging,{recursive:true,force:true});busy.delete(id);sendToRenderer('assets:changed')
    }
  })()
  busy.set(id,work);return work.finally(()=>{busy.delete(id);sendToRenderer('assets:changed')})
}
async function sourceFile(id:string,path:string):Promise<{file:LibraryFile;bytes:Buffer;state:InstalledPack}> {
  if(!safeLibraryPath(path) || !(await assetCatalog()).some(pack=>pack.id===id))throw new Error('Invalid library source path.')
  const state=await installed(id),file=state?.files.find(file=>file.path===path)
  if(!state?.storageKey || !file || !['ready','reference'].includes(state.status))throw new Error('The selected asset is not installed.')
  const base=await realLibraryRoot(),target=join(base,id,state.storageKey,'files',path)
  let current=base
  for(const component of relative(base,target).split(/[\\/]/)) {current=join(current,component);if((await lstat(current)).isSymbolicLink())throw new Error('Library asset links are unsupported.')}
  const bytes=await readFile(target)
  if(bytes.length!==file.bytes || hash(bytes)!==file.sha256)throw new Error('Cached asset integrity changed. Re-import the authorized archive.')
  return {file,bytes,state}
}
export async function queryAssetLibrary(query:AssetQuery,selection?:TaskSelectionPolicy):Promise<AssetMatch[]> {
  if(!query||query.kind!==undefined&&(typeof query.kind!=='string'||query.kind.length>80)||query.style!==undefined&&(typeof query.style!=='string'||query.style.length>80))throw new Error('Invalid asset kind/style query.')
  if(selection)query=scopeAssetQuery(query,selection)
  if(query?.path!==undefined&&(!safeLibraryPath(query.path)||!query.packId))throw new Error('An exact asset path requires its pack identity.')
  if(!query||typeof query.query!=='string'||query.query.length>2000 || query.mechanic&&!['movement','combat','pickup','environment','weather','ambience','ui','custom'].includes(query.mechanic) || query.dimension&&!['2d','3d','any'].includes(query.dimension) || query.limit!==undefined&&(!Number.isInteger(query.limit)||query.limit<1||query.limit>8) || query.offset!==undefined&&(!Number.isInteger(query.offset)||query.offset<0||query.offset>30000) || query.packId!==undefined&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(query.packId))throw new Error('Invalid library query.')
  const words=assetWords(query.query),entries=(await listAssetLibrary()).filter(pack=>!selection||taskAssetAllowed(pack,selection,query)),matches=rankAssetPacks(entries,query)
  return Promise.all(matches.map(async match=>{
    const state=await installed(match.pack.id),files=(state?.files??[]).filter(file=>(file.importable||match.pack.kind==='reference')&&(!query.path||file.path===query.path)).sort((a,b)=>{
      const score=(file:LibraryFile):number=>words.filter(word=>file.path.toLowerCase().includes(word)).length*5+(/\.(glb|gltf|ogg)$/i.test(file.path)?8:0)+(/\.tscn$/i.test(file.path)?4:0)+(/(?:0bas|character[ _-]?base|body)/i.test(file.path)?4:0)-(/\b(Unity|Unreal|Demo|Example)\b/i.test(file.path)?3:0)-(file.purpose==='reference'?80:file.purpose==='palette'&&!words.includes('palette')?50:0)
      return score(b)-score(a)||a.bytes-b.bytes||a.path.localeCompare(b.path)
    }).slice(Math.max(0,query.offset??0),Math.max(0,query.offset??0)+(query.packId?40:6))
    const described:LibraryFile[]=[]
    for(const file of files) {
      if(!/\.png$/i.test(file.path)||file.bytes>32*1024*1024){described.push(file);continue}
      const {bytes}=await sourceFile(match.pack.id,file.path)
      described.push(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?{...file,image:{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}}:file)
    }
    return {...match,files:described}
  }))
}
/** Bounded, mechanism-specific choices with reproducible Godot recipes. No model calls or downloads. */
export async function recommendAssetLibrary(query:AssetQuery,selection?:TaskSelectionPolicy):Promise<AssetMatch[]> {
  const requested=query?.preset===undefined?undefined:validateAssetPreset(query.preset)
  const matches=await queryAssetLibrary({...query,limit:query.limit??3},selection)
  for(const match of matches) {
    match.recommendations=[]
    for(const file of match.files.filter(file=>file.purpose==='runtime'&&file.bytes<=64*1024*1024)) {
      const inferred=defaultAssetPreset(match.pack,file.path,file.sha256);if(!inferred||requested&&requested.kind!==inferred.kind)continue
      const preset=requested??inferred
      const {bytes}=await sourceFile(match.pack.id,file.path)
      let prepared: ReturnType<typeof buildAssetPreset>
      try {prepared=buildAssetPreset(match.pack,file.path,file.sha256,bytes,preset)}
      catch(error) {if(requested||query.path)throw error;continue} // one incompatible candidate cannot poison the whole task search
      match.recommendations.push({sourcePath:file.path,sha256:file.sha256,solarPath:solarPresetPath(match.pack.id,file.path,file.sha256,preset),preset,facts:prepared.facts,notes:prepared.notes,readiness:prepared.notes.length?'needs-adaptation':'ready',score:match.score})
      if(match.recommendations.length===3)break
    }
  }
  return matches
}
export async function readLibraryAsset(id:string,path:string):Promise<string> {
  const source=await sourceFile(id,path)
  if(!/\.(md|txt|gd|gdshader|gdshaderinc|tscn|tres|gltf|obj|mtl|json)$/i.test(path) || source.bytes.length>48*1024)throw new Error('Only bounded source text can be read. Use asset metadata for binary files.')
  return source.bytes.toString('utf8')
}
/** Only the pinned Poly Haven addon uses the separate editor installation path. */
export async function libraryAddonFiles(id:string):Promise<{name:string;revision:string;files:{path:string;bytes:Buffer}[]}> {
  const pack=(await assetCatalog()).find(pack=>pack.id===id),state=await installed(id)
  if(id!=='polyhaven-import'||pack?.acquisition!=='github'||state?.status!=='ready'||!state.sourceRevision)throw new Error('This editor addon is not installed in the library.')
  const plugin=state.files.find(file=>file.path.endsWith('/addons/PolyHavenImport/plugin.cfg'))
  if(!plugin)throw new Error('The pinned archive has no Poly Haven editor plugin.')
  const prefix=posix.dirname(plugin.path)+'/',files:{path:string;bytes:Buffer}[]=[]
  for(const file of state.files.filter(file=>file.path.startsWith(prefix))) {
    files.push({path:file.path.slice(prefix.length),bytes:(await sourceFile(id,file.path)).bytes})
  }
  for(const file of state.files.filter(file=>/\/(?:LICENSE|COPYING)(?:\.[^/]*)?$/i.test(file.path)&&!file.path.startsWith(prefix))) {
    files.push({path:'SOURCE-'+posix.basename(file.path),bytes:(await sourceFile(id,file.path)).bytes})
  }
  files.push({path:'solar-source.json',bytes:Buffer.from(JSON.stringify({source:pack.url,repository:pack.repository,revision:state.sourceRevision,license:pack.license},null,2))})
  return {name:'PolyHavenImport',revision:state.sourceRevision,files}
}
export interface PreparedLibraryFile { path:string; bytes:Buffer; sha256:string; packId:string; sourcePath:string; engineMetadata?:true }
export function assertLibraryClasses(files:PreparedLibraryFile[],existing:Map<string,{hash:string;text?:string}>):void {
  const names=new Map<string,string>(),replaced=new Set(files.map(file=>file.path))
  const check=(path:string,text?:string):void=>{
    if(!path.endsWith('.gd')||text===undefined)return
    const name=text.match(/^\s*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1]
    if(name) {if(names.has(name)&&names.get(name)!==path)throw new Error(`Godot class ${name} conflicts with ${names.get(name)}. Existing scripts were preserved.`);names.set(name,path)}
  }
  for(const [path,file] of existing)if(!replaced.has(path))check(path,file.text)
  for(const file of files)check(file.path,file.bytes.toString('utf8'))
}
/** Resolve exact dependencies and rebase literal resource paths, never entire packs. */
export async function prepareLibraryImports(imports:AssetImport[]):Promise<PreparedLibraryFile[]> {
  if(!Array.isArray(imports)||imports.length>4)throw new Error('Select at most four packs per ChangeSet.')
  if(new Set(imports.map(item=>item?.packId)).size!==imports.length)throw new Error('Select each asset pack once per ChangeSet.')
  const result:PreparedLibraryFile[]=[],seen=new Set<string>();let preparedBytes=0,preparedCount=0
  for(const selection of imports) {
    const pack=(await assetCatalog()).find(pack=>pack.id===selection.packId),state=await installed(selection.packId)
    if(!pack || pack.acquisition==='reference'||pack.acquisition==='github'||!state?.storageKey)throw new Error('References and editor addons cannot be imported as runtime asset packs.')
    if(!Array.isArray(selection.files)||!selection.files.length||selection.files.length>24)throw new Error('Select 1–24 exact files per pack; dependency files are resolved by Solar.')
    const selected:PreparedLibraryFile[]=[]
    const add=(file:PreparedLibraryFile):void=>{
      if(++preparedCount>120||(preparedBytes+=file.bytes.length)>128*1024*1024)throw new Error('Asset imports exceed the 120-file / 128 MB transaction limit.')
      selected.push(file)
    }
    // Exported asset-only packs may omit project.godot. Resolve a unique
    // resource suffix within the same upload, never across unrelated archives.
    const classes=new Map<string,string>()
    for(const file of state.files.filter(file=>/\.gd$/i.test(file.path)&&file.bytes<=512*1024)) {
      const text=(await sourceFile(pack.id,file.path)).bytes.toString('utf8'),name=text.match(/^\s*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1]
      if(name) {if(classes.has(name)&&classes.get(name)!==file.path)throw new Error('The pack contains duplicate Godot script classes. Select a compatible edition.');classes.set(name,file.path)}
    }
    const visit=async(path:string,expected?:string):Promise<void>=>{
      const target=assetTarget(pack.id,path)
      // Verify every explicit request, even when a dependency was visited first.
      if(expected&&state.files.find(file=>file.path===path)?.sha256!==expected)throw new Error('The selected asset version changed.')
      if(seen.has(target))return
      const source=await sourceFile(pack.id,path)
      if(expected&&expected!==source.file.sha256)throw new Error('The selected asset version changed.')
      if(!source.file.importable)throw new Error('This source file is not an importable Godot asset.')
      if(source.bytes.length>64*1024*1024 || result.length+selected.length>=120)throw new Error('Selected asset dependencies exceed this ChangeSet limit.')
      seen.add(target);let bytes=source.bytes
      const projectRoots=state.files.filter(file=>file.path.endsWith('/project.godot')||file.path==='project.godot').map(file=>posix.dirname(file.path)).filter(root=>root==='.'||path.startsWith(root+'/')).sort((a,b)=>b.length-a.length)
      const projectRoot=projectRoots[0]??'.'
      const resolveDependency=(reference:string):string=>{
        if(/^https?:|^user:|^uid:/.test(reference))throw new Error('The asset has unresolved external/UID dependencies.')
        let dependency=posix.normalize(reference.startsWith('res://')?posix.join(projectRoot,reference.slice(6)):posix.join(posix.dirname(path),decodeURIComponent(reference)))
        if(reference.startsWith('res://')&&!projectRoots.length&&!state.files.some(file=>file.path===dependency)) {
          const suffix='/'+reference.slice(6),upload=path.split('/')[0]+'/'
          const candidates=state.files.filter(file=>file.path.startsWith(upload)&&file.path.endsWith(suffix))
          if(candidates.length===1)dependency=candidates[0].path
        }
        if(!safeLibraryPath(dependency)||!state.files.some(file=>file.path===dependency))throw new Error('Missing asset dependency: '+reference)
        return dependency
      }
      if(/\.(tscn|tres|gd|gdshader|gdshaderinc|obj|mtl)$/i.test(path)) {
        let text=bytes.toString('utf8')
        if(/\.(tscn|tres)$/i.test(path))text=text.replace(/\suid="uid:\/\/[^"\n]+"/g,'').replace(/^metadata\/_custom_type_script\s*=\s*"uid:\/\/[^"\n]+"\r?\n/gm,'') // editor-only source cache metadata
        const references=[...text.matchAll(/(?:res:\/\/[^"'\s)]+|(?:#include\s+|(?:preload|load)\s*\(\s*)["']([^"']+)["'])/g)]
        for(const match of references) {const reference=match[1]??match[0],dependency=resolveDependency(reference);await visit(dependency);text=text.split(reference).join('res://'+assetTarget(pack.id,dependency))}
        if(/\.gd$/i.test(path))for(const [name,dependency] of classes)if(dependency!==path&&new RegExp('\\b'+name+'\\b').test(text)&&dependency.split('/')[0]===path.split('/')[0])await visit(dependency)
        if(/uid:\/\//.test(text))throw new Error('The asset has unresolved source-project UID references.')
        text=adaptLibraryShader(pack.id,path,text)
        if(/\.obj$/i.test(path))for(const match of text.matchAll(/^mtllib\s+(.+)$/gm))await visit(resolveDependency(match[1].trim()))
        if(/\.mtl$/i.test(path))for(const match of text.matchAll(/^map_\w+\s+(.+)$/gm))await visit(resolveDependency(match[1].trim()))
        if(/\.(gd|gdshader|gdshaderinc)$/i.test(path)&&!/^\s*(?:#|\/\/)=== solar ===/m.test(text)) {
          const comment=/\.gd$/i.test(path)?'#':'//'
          const name=posix.basename(path).replace(/\.[^.]+$/,'')
          text=[`${comment}=== solar ===`,`${comment} kind: ${/\.gd$/i.test(path)?'util':'shader'}`,`${comment} name: ${name}`,`${comment} summary: Library source from ${pack.author}; see Solar provenance.`,`${comment} uses: none`,`${comment}=== /solar ===`,'',text].join('\n')
        }
        bytes=Buffer.from(text)
      } else if(/\.gltf$/i.test(path)) {
        const document=JSON.parse(bytes.toString('utf8')) as {buffers?:{uri?:string}[];images?:{uri?:string}[]}
        for(const item of [...(document.buffers??[]),...(document.images??[])])if(item.uri&&!item.uri.startsWith('data:'))await visit(resolveDependency(item.uri))
      }
      if(pack.dimension==='3d'&&/\.(png|jpe?g|webp)$/i.test(path)) {
        // Godot merges missing options from its defaults and fills remap/cache
        // paths on first import. Seed 3D texture options before exposing the
        // image to avoid a nested detect-3D reimport during scene import.
        const settings=Buffer.from(`[remap]\nimporter="texture"\ntype="CompressedTexture2D"\n[deps]\nsource_file=${JSON.stringify('res://'+target)}\n[params]\ncompress/mode=2\ncompress/normal_map=${/normal/i.test(posix.basename(path))?1:0}\nmipmaps/generate=true\ndetect_3d/compress_to=0\n`)
        add({path:target+'.import',bytes:settings,sha256:hash(settings),packId:pack.id,sourcePath:'Godot 3D texture import options',engineMetadata:true})
      }
      add({path:target,bytes,sha256:hash(bytes),packId:pack.id,sourcePath:path})
    }
    for(const file of selection.files) {
      if(!file||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Asset imports require exact source SHA-256.')
      await visit(file.path,file.sha256)
      if(file.preset) {
        const preset=validateAssetPreset(file.preset),source=await sourceFile(pack.id,file.path)
        const prepared=buildAssetPreset(pack,file.path,file.sha256,source.bytes,preset)
        for(const generated of prepared.files) {
          const existing=selected.find(item=>item.path===generated.path)
          if(existing) {if(existing.sha256!==hash(generated.bytes))throw new Error('Conflicting asset preset recipes.');continue}
          if(seen.has(generated.path))continue
          seen.add(generated.path);add({...generated,sha256:hash(generated.bytes),packId:pack.id,sourcePath:'Solar preset: '+file.path})
        }
      }
    }
    const provenance=Buffer.from(JSON.stringify({schemaVersion:1,packId:pack.id,title:pack.title,author:pack.author,source:pack.url,license:pack.license,notes:pack.notes,storageKey:state.storageKey,files:selected.filter(file=>!file.engineMetadata).map(file=>({path:file.path,sourcePath:file.sourcePath,sha256:file.sha256}))},null,2))
    add({path:assetTarget(pack.id,'solar-source-'+hash(provenance).slice(0,12)+'.json'),bytes:provenance,sha256:hash(provenance),packId:pack.id,sourcePath:'provenance'})
    result.push(...selected)
    if(result.length>120||result.reduce((sum,file)=>sum+file.bytes.length,0)>128*1024*1024)throw new Error('Asset imports exceed the 120-file / 128 MB transaction limit.')
  }
  return result
}
/** Host-generated chunks; controlled model ChangeSets cannot construct this envelope. */
export function libraryWriteCommands(file:PreparedLibraryFile):{tool:string;args:Record<string,unknown>}[] {
  const commands=[]
  for(let offset=0;offset<file.bytes.length||offset===0;offset+=384*1024) {
    const chunk=file.bytes.subarray(offset,offset+384*1024)
    commands.push({tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://'+file.path,content:ASSET_BYTE_PREFIX+JSON.stringify({sha256:file.sha256,total:file.bytes.length,offset,data:chunk.toString('base64'),finish:offset+chunk.length===file.bytes.length})}}})
  }
  return commands
}
/** Legacy executor compatibility. New files only; Microsoft uses its gateway. */
export async function importLegacyLibraryAssets(projectPath:string,imports:AssetImport[],signal:AbortSignal):Promise<string[]> {
  if(getProductionEnabled())throw new Error('Microsoft owns project writes. Submit ChangeSet.assetImports instead.')
  if(getGameState().status!=='stopped')throw new Error('Stop the running game before importing library assets.')
  const files=await prepareLibraryImports(imports),paths:string[]=[]
  const snapshot=await snapshotProject(projectPath,{signal})
  if(!snapshot.complete)throw new Error('Asset import requires a complete project snapshot.')
  assertLibraryClasses(files,snapshot.files)
  // Check every existing file before the first mutation; a conflict preserves the project.
  for(const file of files) {
    signal.throwIfAborted()
    if(getCurrentProject()?.path!==projectPath)throw new Error('The active project changed during asset import.')
    if(await lstat(join(projectPath,file.path)).catch(()=>null)) {
      const previous=await resolveProjectFile(projectPath,file.path)
      if(!file.engineMetadata&&hash(await readFile(previous))!==file.sha256)throw new Error('Existing asset was preserved: '+file.path)
    }
  }
  for(const file of files) {
    signal.throwIfAborted()
    if(getCurrentProject()?.path!==projectPath)throw new Error('The active project changed during asset import.')
    const target=join(projectPath,file.path),exists=await lstat(target).catch(()=>null)
    if(exists) {
      const previous=await resolveProjectFile(projectPath,file.path)
      if(!file.engineMetadata&&hash(await readFile(previous))!==file.sha256)throw new Error('Existing asset was preserved: '+file.path)
    } else {
      await ensureProjectDirectory(projectPath,dirname(target))
      await writeFile(target,file.bytes,{flag:'wx'})
      if(hash(await readFile(target))!==file.sha256)throw new Error('Asset import integrity failed.')
    }
    paths.push(file.path)
  }
  sendToRenderer('chat:files-changed');return paths
}
