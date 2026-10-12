import type { AssetImport, AssetMatch, AssetMechanic, AssetPack, AssetPreset, AssetQuery,AssetRecommendation } from './asset-library'
import { assetWords, assetTarget, validateAssetPreset } from './asset-library'
import type { ChangeSet } from './production'
export class TaskSelectionError extends Error {readonly code='AI_SELECTION_REJECTED'}

export interface TaskSelectionPolicy {
  version: 1; dimension: '2d'|'3d'|'mixed'; dimensionSource: 'request'|'project'|'default'
  style?: string; assetMode: 'optional'|'none'|'existing-only'; terms: string[]; topics: string[]
}
export interface AssetSelectionReceipt {
  packId: string; path: string; sha256: string; preset: AssetPreset; solarPath: string
  readiness: 'ready'|'needs-adaptation'; notes: string[]
  facts?:AssetRecommendation['facts']
}
const aliases: Record<string,string[]> = {
  yilan:['snake','grid','input'], snake:['snake','grid','input'], platform:['platformer','physics','movement'], platformer:['platformer','physics','movement'],
  hareket:['movement','input'], yurume:['walk','movement'], karakter:['character','movement'], animasyon:['animation'],
  carpismasi:['collision','physics'], carpisma:['collision','physics'], fizik:['physics'], kamera:['camera'],
  hata:['debugging','bug'], bug:['debugging','bug'], cokuyor:['crash','debugging'], cokme:['crash','debugging'],
  arayuz:['ui'], menu:['ui'], menus:['ui'], buton:['ui','button'], puan:['score','ui'], skor:['score','ui'],
  orman:['forest','environment'], agac:['tree','environment'], doga:['nature','environment'], yagmur:['rain','weather'],
  patlama:['explosion','combat'], silah:['weapon','combat'], ates:['shooting','combat'], saglik:['health','pickup'],
  ses:['sound','audio'], muzik:['music','audio'], piksel:['pixel'], shader:['shader','material'],
  kaydet:['save','persistence'], envanter:['inventory'], test:['testing'], performans:['performance','profiling']
}
const generic = new Set(['a','an','and','the','to','for','of','in','with','from','this','that','me','my','new','add','make','create','build','please','want','game','games','godot','solar','solara','engine','project','skill','guide','2d','3d','2b','3b','bir','ve','ile','icin','oyun','oyunu','oyununa','yap','ekle','istiyorum','olsun','proje','create','implement','feature','development'])
const singulars: Record<string,string> = {animations:'animation',weapons:'weapon',characters:'character',trees:'tree',sounds:'sound',shaders:'shader',menus:'menu',sprites:'sprite',nodes:'node',scenes:'scene',tests:'test',enemies:'enemy',resources:'resource',materials:'material',particles:'particle',scores:'score',levels:'level',platformers:'platformer',forests:'forest',rocks:'rock',inputs:'input',systems:'system',effects:'effect',textures:'texture'}
const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replaceAll('ı','i')
export function selectionWords(text: string): string[] {
  return [...new Set(assetWords(fold(text).replaceAll('-',' ')).flatMap(word=>{const term=singulars[word]??word;return [term,...(aliases[term]??[])]}).filter(word=>!generic.has(word)))].slice(0,80)
}
const dimensional = (text: string, n: 2|3): boolean => new RegExp(`(?:^|[^a-z0-9])${n}[db](?:[^a-z0-9]|$)|${n===2?'iki':'uc'} boyut|${n===2?'two':'three'} dimensional|${n===2?'vector2|sprite2d|node2d|characterbody2d':'vector3|sprite3d|node3d|characterbody3d'}`,'i').test(fold(text))
export function deriveTaskSelection(request: string, sources: {path:string;text?:string}[], scope?: string): TaskSelectionPolicy {
  const normalized=fold(request),two=dimensional(request,2),three=dimensional(request,3)||!two&&(/first[ -]?person|birinci (?:sahis|kisi)|\bfps\s+(?:game\b|oyun)|(?:game\b|oyun\w*)\s+fps\b/.test(normalized))
  // Node types are project facts; UI Control/CanvasLayer does not turn a 3D
  // world into a 2D game. Do not use planner-generated keywords as authority.
  const sceneText=sources.filter(source=>source.path.endsWith('.tscn')).map(source=>source.text??'').join('\n')
  const scene2=/\[node\b[^\]\n]*type="[^"]*2D"/.test(sceneText),scene3=/\[node\b[^\]\n]*type="[^"]*3D"/.test(sceneText)
  const dimension=two&&three?'mixed':two?'2d':three?'3d':scene2&&scene3?'mixed':scene3?'3d':'2d'
  const style=/pixel|piksel/.test(normalized)?'pixel':/low[ -]?poly/.test(normalized)?'low-poly':/realistic|gercekci/.test(normalized)?'realistic':/stylized|stilize/.test(normalized)?'stylized':undefined
  const assetMode=/existing assets only|only existing assets|no new assets|without new assets|sadece mevcut asset|yalnizca mevcut asset/.test(normalized)?'existing-only':/no (?:library |external |ready[ -]made )?assets|without (?:library |external |ready[ -]made )?assets|(?:hazir|kutuphane) asset(?:leri?)? kullanma|asset kullanma|procedural only|yalnizca prosedurel/.test(normalized)?'none':'optional'
  const terms=selectionWords(request),topics=[...terms]
  if(scope==='bugfix'&&!topics.includes('debugging'))topics.push('debugging','bug')
  return {version:1,dimension,dimensionSource:two||three?'request':scene2||scene3?'project':'default',style,assetMode,terms,topics}
}
export function taskSkillScore(guide: {id:string;title:string;description:string;tags:string[]}, policy: TaskSelectionPolicy): number {
  if (/^studio-|(?:^|-)(?:master|router|orchestrator)(?:-|$)/.test(guide.id)) return -1
  const name=selectionWords(guide.id+' '+guide.title),tags=selectionWords(guide.tags.join(' ')),description=selectionWords(guide.description)
  const d2=/(?:^|-)2d(?:-|$)/.test(guide.id),d3=/(?:^|-)3d(?:-|$)/.test(guide.id)
  if(policy.dimension==='2d'&&d3||policy.dimension==='3d'&&d2)return -1
  let score=0
  for(const term of policy.topics)score+=(name.includes(term)?8:0)+(tags.includes(term)?4:0)+(description.includes(term)?1:0)
  // A dimension tag alone is never enough to choose an unrelated specialist.
  return score
}
export function developerTaskSkills(specialists: string[], policy: TaskSelectionPolicy): string[] {
  return [...specialists,'solar-ecs','solar-validation',...(policy.dimension==='mixed'?['solar-2d','solar-3d']:[`solar-${policy.dimension}`]),...(policy.assetMode==='optional'?['solar-assets']:[])]
}
const mechanicKinds: Record<AssetMechanic,string[]>={movement:['character','animation'],combat:['prop','vfx','animation','audio','reference'],pickup:['prop','system','audio'],environment:['environment','addon'],weather:['vfx','shader','audio'],ambience:['audio'],ui:['audio','shader'],custom:[]}
export function scopeAssetQuery(query: AssetQuery, policy: TaskSelectionPolicy): AssetQuery {
  if(policy.assetMode!=='optional')throw new TaskSelectionError('The user did not authorize new library assets for this task. Use the existing project or procedural content.')
  if(query.dimension&&query.dimension!=='any'&&policy.dimension!=='mixed'&&query.dimension!==policy.dimension)throw new TaskSelectionError('The asset query dimension conflicts with the saved task.')
  if(query.style&&policy.style&&query.style!==policy.style)throw new TaskSelectionError('The asset query style conflicts with the user request.')
  return {...query,dimension:policy.dimension==='mixed'?(query.dimension??'any'):policy.dimension,style:policy.style??query.style}
}
export function taskAssetAllowed(pack: AssetPack, policy: TaskSelectionPolicy, query?: AssetQuery): boolean {
  if(policy.assetMode!=='optional'||policy.dimension!=='mixed'&&pack.dimension!=='any'&&pack.dimension!==policy.dimension||policy.style&&pack.style!=='any'&&pack.style!==policy.style)return false
  const terms=selectionWords(`${pack.id} ${pack.title} ${pack.kind} ${pack.tags.join(' ')}`)
  const modifiers=new Set(['pixel','art','stylized','realistic','low','poly','asset','assets','pack','library'])
  if(!policy.terms.some(term=>!modifiers.has(term)&&terms.includes(term)))return false
  const kinds=query?.mechanic?mechanicKinds[query.mechanic]:[]
  return !kinds.length||kinds.includes(pack.kind)
}
export function assetReceiptKey(packId: string, path: string, sha256: string, preset: AssetPreset): string {
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonical(child)])):value
  return JSON.stringify({packId,path,sha256,preset:canonical(validateAssetPreset(preset))})
}
export function recommendationsToReceipts(matches: AssetMatch[]): AssetSelectionReceipt[] {
  return matches.flatMap(match=>(match.recommendations??[]).map(choice=>({packId:match.pack.id,path:choice.sourcePath,sha256:choice.sha256,preset:choice.preset,solarPath:choice.solarPath,readiness:choice.readiness,notes:choice.notes,facts:choice.facts})))
}
export function assertSelectedAssets(imports: AssetImport[], receipts: AssetSelectionReceipt[]): void {
  if(!Array.isArray(imports)||imports.length>4)throw new TaskSelectionError('Asset selections need at most four exact recommended packs.')
  const approved=new Set(receipts.map(receipt=>assetReceiptKey(receipt.packId,receipt.path,receipt.sha256,receipt.preset)))
  for(const selection of imports) {
    if(!selection||!Array.isArray(selection.files)||!selection.files.length||selection.files.length>24)throw new TaskSelectionError('Select bounded exact asset files.')
    for(const file of selection.files) {
    if(!file||typeof file.path!=='string'||typeof file.sha256!=='string')throw new TaskSelectionError('An asset needs its recommended source identity.')
    if(!file.preset||!approved.has(assetReceiptKey(selection.packId,file.path,file.sha256,file.preset)))throw new TaskSelectionError('The asset source/hash/preset was not recommended in this task attempt. Call asset_library recommend for the exact choice before importing it.')
  }
  }
}
/** Reject guessed library references and selections never used by the proposal. */
export function validateTaskAssetUse(change: ChangeSet, receipts: AssetSelectionReceipt[], available: Iterable<string>, policy?:TaskSelectionPolicy, catalog:AssetPack[]=[]): void {
  assertSelectedAssets(change.assetImports??[],receipts)
  const files=new Set(available),references=new Set<string>()
  const visit=(value:unknown):void=>{
    if(typeof value==='string') {
      const quoted=[...value.matchAll(/["']((?:res:\/\/)?assets\/library\/[^"'\r\n]+)["']/gi)]
      for(const match of quoted)references.add(match[1].replace(/^res:\/\//i,''))
      const rest=value.replace(/["'](?:res:\/\/)?assets\/library\/[^"'\r\n]+["']/gi,'')
      if(/^(?:res:\/\/)?assets\/library\/[^"'\r\n]+$/i.test(rest))references.add(rest.replace(/^res:\/\//i,''))
      else for(const match of rest.matchAll(/(?:res:\/\/)?assets\/library\/[^"'\s\)\],;]+/gi))references.add(match[0].replace(/^res:\/\//i,''))
    } else if(Array.isArray(value))for(const child of value)visit(child)
    else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child)
  }
  visit(change.commands)
  if(policy?.assetMode==='none'&&references.size)throw new TaskSelectionError('This task explicitly excludes library assets. Remove those resource references.')
  for(const path of references) {
    const pack=catalog.find(pack=>pack.id===path.split('/')[2])
    if(pack&&policy&&(policy.dimension!=='mixed'&&pack.dimension!=='any'&&pack.dimension!==policy.dimension||policy.style&&pack.style!=='any'&&pack.style!==policy.style))throw new TaskSelectionError('A referenced library pack conflicts with the task dimension/style: '+pack.id)
  }
  for(const path of references)if(!files.has(path))throw new TaskSelectionError('The proposal guessed an unavailable library resource: '+path+'. Use an existing path or an exact recommended import.')
  for(const selection of change.assetImports??[])for(const file of selection.files) {
    const receipt=receipts.find(receipt=>assetReceiptKey(receipt.packId,receipt.path,receipt.sha256,receipt.preset)===assetReceiptKey(selection.packId,file.path,file.sha256,file.preset!))!
    if(!references.has(receipt.solarPath.replace(/^res:\/\//,''))&&!references.has(assetTarget(selection.packId,file.path)))throw new TaskSelectionError('The selected asset is unused by the ChangeSet. Reference its exact source or Solar prefab, or omit the import.')
  }
}
