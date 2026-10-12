export type AssetDimension = '2d' | '3d' | 'any'
export interface AssetPack {
  id: string; title: string; author: string; url: string; kind: string
  dimension: AssetDimension; style: string; tags: string[]; formats: string[]
  license: string; notes: string; acquisition: 'itch' | 'github' | 'reference'; repository?: string
}
export interface LibraryFile { path: string; sha256: string; bytes: number; importable: boolean; purpose?:'runtime'|'palette'|'reference'; image?:{width:number;height:number} }
export interface InstalledPack {
  schemaVersion: 1; id: string; status: 'ready' | 'reference' | 'unavailable'; installedAt: string
  sourceRevision?: string; archives: { name: string; sha256: string; bytes: number }[]
  storageKey?: string
  files: LibraryFile[]; message?: string
}
export interface LibraryEntry extends AssetPack {
  status: 'available' | 'downloading' | 'ready' | 'reference' | 'unavailable'
  fileCount: number; bytes: number; message?: string
}
export type AssetMechanic = 'movement'|'combat'|'pickup'|'environment'|'weather'|'ambience'|'ui'|'custom'
export interface AssetPreset {
  kind:'sprite2d'|'model3d'|'effect3d'|'animation-library'|'audio'|'shader-material'
  frameWidth?:number; frameHeight?:number
  animations?:{name:string;start:number;count:number;fps:number;loop:boolean}[]
  targetHeight?:number; collision?:'none'|'static'|'pickup'; volumeDb?:number; loop?:boolean
}
export interface AssetQuery { query: string; dimension?: AssetDimension; kind?: string; style?: string; mechanic?:AssetMechanic; limit?: number; packId?: string; path?:string; preset?:AssetPreset; offset?: number }
export interface AssetImport { packId: string; files: { path: string; sha256: string; preset?:AssetPreset }[] }
export interface AssetRecommendation {
  sourcePath:string;sha256:string;solarPath:string;preset:AssetPreset
  readiness:'ready'|'needs-adaptation';notes:string[];score:number
  facts:{width?:number;height?:number;animationNames?:string[];skinCount?:number;bounds?:{min:number[];max:number[]}}
}
export interface AssetMatch { pack: LibraryEntry; score: number; reasons: string[]; files: LibraryFile[]; recommendations?:AssetRecommendation[] }
export const ASSET_BYTE_PREFIX = 'SOLAR_ASSET_BYTES_V1:'
export const IMPORTABLE_ASSET = /\.(png|jpe?g|webp|svg|hdr|exr|ogg|wav|mp3|glb|gltf|bin|fbx|obj|mtl|gd|gdshader|gdshaderinc|tscn|tres|ttf|otf)$/i
export function assetFilePurpose(path:string):'runtime'|'palette'|'reference' {
  if(/(?:^|\/)(?:guides?|previews?|documentation|timing samples?)(?:\/|\b)|(?:setup|preview|thumbnail|logo|instructions)\.[^.]+$/i.test(path))return 'reference'
  if(/(?:palette|colou?r[ _-]?(?:ramps?|maps?))/i.test(path))return 'palette'
  return 'runtime'
}
/** Windows and POSIX paths share one portable archive/import contract. */
export function safeLibraryPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    !/[\\:\x00-\x1f<>"|?*]/.test(value) && !value.startsWith('/') &&
    !value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}
export function assetTarget(packId: string, path: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packId) || !safeLibraryPath(path)) throw new Error('Invalid library asset identity.')
  return `assets/library/${packId}/${path}`
}
const aliases: Record<string,string> = { orman:'forest', agac:'tree', ağaç:'tree', doga:'nature', doğa:'nature', karakter:'character', animasyon:'animation', patlama:'explosion', silah:'weapon', ses:'sound', muzik:'music', müzik:'music', hava:'weather', yagmur:'rain', yağmur:'rain', sağlık:'health', medikal:'medical', piksel:'pixel', shaderlar:'shader', kapma:'grab', toplama:'pickup' }
export function assetWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(word => word.length > 1).flatMap(word => [word, aliases[word] ?? word]))]
}
const mechanicKinds:Record<AssetMechanic,string[]>={movement:['character','animation'],combat:['prop','vfx','animation','audio','reference'],pickup:['prop','system','audio'],environment:['environment','addon'],weather:['vfx','shader','audio'],ambience:['audio'],ui:['audio','shader'],custom:[]}
export function inferAssetMechanic(query:string):AssetMechanic {
  const words=assetWords(query)
  if(words.some(word=>['weapon','combat','shooting','attack','sword','explosion','fps'].includes(word)))return 'combat'
  if(words.some(word=>['pickup','grab','medkit','health','medical'].includes(word)))return 'pickup'
  if(words.some(word=>['rain','snow','fog','weather'].includes(word)))return 'weather'
  if(words.some(word=>['walk','run','movement','locomotion','character','platformer','animation'].includes(word)))return 'movement'
  if(words.some(word=>['forest','tree','environment','nature','rock'].includes(word)))return 'environment'
  if(words.some(word=>['ambience','music','soundtrack'].includes(word)))return 'ambience'
  return 'custom'
}
export function validateAssetPreset(value:unknown):AssetPreset {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('A Solar asset preset must be an object.')
  const preset=value as AssetPreset
  if(!['sprite2d','model3d','effect3d','animation-library','audio','shader-material'].includes(preset.kind))throw new Error('Unsupported Solar asset preset.')
  const keys:Record<AssetPreset['kind'],string[]>={sprite2d:['frameWidth','frameHeight','animations'],model3d:['targetHeight','collision'],effect3d:[], 'animation-library':[],audio:['volumeDb','loop'],'shader-material':[]}
  if(Object.keys(preset).some(key=>key!=='kind'&&!keys[preset.kind].includes(key)))throw new Error('A preset option does not belong to this asset type.')
  if(preset.frameWidth!==undefined||preset.frameHeight!==undefined)for(const dimension of [preset.frameWidth,preset.frameHeight])if(typeof dimension!=='number'||!Number.isInteger(dimension)||dimension<1||dimension>4096)throw new Error('Sprite frame dimensions must be 1–4096 pixels.')
  if(preset.animations!==undefined) {
    if(!Array.isArray(preset.animations)||!preset.animations.length||preset.animations.length>8||preset.frameWidth===undefined)throw new Error('Animation clips need a bounded, explicit sprite grid.')
    const names=new Set<string>();let frames=0
    for(const clip of preset.animations) {
      if(!clip||Object.keys(clip).some(key=>!['name','start','count','fps','loop'].includes(key))||typeof clip.name!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(clip.name)||names.has(clip.name)||!Number.isInteger(clip.start)||clip.start<0||!Number.isInteger(clip.count)||clip.count<1||clip.count>60||!Number.isFinite(clip.fps)||clip.fps<1||clip.fps>60||typeof clip.loop!=='boolean')throw new Error('Invalid sprite animation clip.')
      names.add(clip.name);frames+=clip.count
    }
    if(frames>120)throw new Error('Select at most 120 sprite frames per preset.')
  }
  if(preset.targetHeight!==undefined&&(!Number.isFinite(preset.targetHeight)||preset.targetHeight<0.01||preset.targetHeight>1000))throw new Error('Model height must be 0.01–1000 Godot units.')
  if(preset.collision!==undefined&&!['none','static','pickup'].includes(preset.collision))throw new Error('Invalid Solar collision preset.')
  if(preset.volumeDb!==undefined&&(!Number.isFinite(preset.volumeDb)||preset.volumeDb< -80||preset.volumeDb>0)||preset.loop!==undefined&&typeof preset.loop!=='boolean')throw new Error('Invalid audio preset.')
  return structuredClone(preset)
}
export function rankAssetPacks(entries: LibraryEntry[], query: AssetQuery): { pack: LibraryEntry; score: number; reasons: string[] }[] {
  const words = assetWords(query.query)
  const dimension = query.dimension ?? (words.some(w => w === '3d' || w === '3b') ? '3d' : words.some(w => w === '2d' || w === '2b') ? '2d' : 'any')
  const style = query.style ?? (words.includes('pixel') ? 'pixel' : undefined)
  const mechanic=query.mechanic??inferAssetMechanic(query.query),kinds=mechanicKinds[mechanic]
  return entries.filter(pack => (!query.packId || query.packId === pack.id) && (!query.kind || pack.kind === query.kind) && (dimension === 'any' || pack.dimension === 'any' || pack.dimension === dimension) && (!style || pack.style === 'any' || pack.style === style) && (query.packId||!kinds.length||kinds.includes(pack.kind))).map(pack => {
    const haystack = assetWords(`${pack.title} ${pack.kind} ${pack.tags.join(' ')}`)
    const matched = words.filter(word => haystack.some(tag => tag === word || tag.replace(/s$/, '') === word.replace(/s$/, '')))
    const reasons = matched.map(word => `Matches ${word}`)
    if(kinds.includes(pack.kind))reasons.push(`Supports ${mechanic}`)
    const score = matched.length * 8 + (pack.status === 'ready' ? 3 : 0) + (dimension !== 'any' && pack.dimension === dimension ? 2 : 0) + (kinds.includes(pack.kind)?4:0)
    return { pack, score, reasons }
  }).filter(match => words.length === 0 || match.reasons.length > 0 || query.packId).sort((a,b) => b.score-a.score || a.pack.title.localeCompare(b.pack.title)).slice(0, Math.min(8, Math.max(1, query.limit ?? 5)))
}
