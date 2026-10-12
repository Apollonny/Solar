import test from 'node:test'
import { strict as assert } from 'node:assert'
import { buildAssetPreset, inspectAsset, solarPresetPath } from '../src/main/services/asset-presets'
import { validateAssetPreset, rankAssetPacks } from '../src/shared/asset-library'
import type { AssetPack, LibraryEntry } from '../src/shared/asset-library'
import { adaptLibraryShader } from '../src/main/services/asset-compatibility'
const pack:AssetPack={id:'fixture',title:'Fixture',author:'Partner',url:'https://example.com',kind:'environment',dimension:'3d',style:'stylized',tags:[],formats:[],license:'Partner',notes:'',acquisition:'itch'}
const sha='a'.repeat(64)
const model=Buffer.from(JSON.stringify({accessors:[{min:[-1,0,-1],max:[1,2,1]}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],nodes:[{mesh:0,translation:[2,1,0],scale:[2,2,2]}],scenes:[{nodes:[0]}]}))
function png():Buffer {const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(512,16);bytes.writeUInt32BE(512,20);return bytes}
test('Godot wrappers use transformed measured bounds and deterministic recipes',()=>{
  assert.deepEqual(inspectAsset('model.gltf',model).bounds,{min:[0,1,-2],max:[4,5,2]})
  const preset={kind:'model3d' as const,targetHeight:2,collision:'pickup' as const}
  const built=buildAssetPreset(pack,'model.gltf',sha,model,preset)
  const scene=built.files.find(file=>file.path.endsWith('.tscn'))!.bytes.toString()
  assert.match(scene,/type="Area3D"/);assert.match(scene,/size = Vector3\(2, 2, 2\)/);assert.match(scene,/position = Vector3\(-1, -0.5, 0\)/)
  assert.equal(solarPresetPath(pack.id,'model.gltf',sha,preset),solarPresetPath(pack.id,'model.gltf',sha,{collision:'pickup',targetHeight:2,kind:'model3d'}))
  assert.notEqual(solarPresetPath(pack.id,'model.gltf',sha,preset),solarPresetPath(pack.id,'model.gltf',sha,{...preset,targetHeight:3}))
  assert.throws(()=>buildAssetPreset(pack,'model.fbx',sha,Buffer.alloc(4),preset),/verified static/)
  assert.equal(inspectAsset('rig.gltf',Buffer.from(JSON.stringify({skins:[{}],animations:[{name:'Walk'}]}))).bounds,undefined)
})
test('sprite frames are bounded by actual sheet dimensions; no animation names are guessed',()=>{
  const spritePack={...pack,dimension:'2d' as const,kind:'character',style:'pixel'}
  const built=buildAssetPreset(spritePack,'actor.png',sha,png(),{kind:'sprite2d',frameWidth:64,frameHeight:64,animations:[{name:'preview',start:0,count:8,fps:8,loop:true}]})
  assert.match(built.files[0].bytes.toString(),/region = Rect2\(448, 0, 64, 64\)/);assert.match(built.files[0].bytes.toString(),/texture_filter = 1/)
  assert.throws(()=>buildAssetPreset(spritePack,'actor.png',sha,png(),{kind:'sprite2d',frameWidth:64,frameHeight:64,animations:[{name:'bad',start:63,count:2,fps:8,loop:true}]}),/outside/)
  assert.throws(()=>buildAssetPreset(spritePack,'actor.png',sha,png(),{kind:'sprite2d',frameWidth:63,frameHeight:64}),/grid/)
  assert.throws(()=>validateAssetPreset({kind:'effect3d',targetHeight:2}),/option/)
  assert.throws(()=>validateAssetPreset({kind:'audio',volumeDb:10}),/audio/)
})
test('mechanism selection excludes incompatible kinds, dimensions and styles',()=>{
  const entry={...pack,status:'ready',fileCount:1,bytes:1} as LibraryEntry
  const entries=[entry,{...entry,id:'sound',kind:'audio',dimension:'any' as const,tags:['pickup']},{...entry,id:'medkit',kind:'prop',tags:['health']}]
  assert.deepEqual(rankAssetPacks(entries,{query:'health',mechanic:'pickup',dimension:'3d'}).map(match=>match.pack.id),['medkit','sound'])
  assert.throws(()=>validateAssetPreset({kind:'sprite2d',frameWidth:64,frameHeight:64,animations:[{name:'clip',start:0,count:2,fps:8,loop:true,script:'inject'}]}),/clip/)
})
test('Nojoule compatibility preserves every 5x5 sample and leaves unrelated shaders unchanged',()=>{
  const source='sample_5x5_grid(TEXTURE, center_coords, offset_pixels, pixel_orig);'
  const adapted=adaptLibraryShader('nojoule-pixel-shaders','outline_shared.gdshaderinc',source)
  assert.equal(adapted.match(/texelFetch\(/g)?.length,25)
  assert.match(adapted,/pixel_orig\[0\].*offset_pixels.x \* -2.0, offset_pixels.y \* -2.0/)
  assert.match(adapted,/pixel_orig\[24\].*offset_pixels.x \* 2.0, offset_pixels.y \* 2.0/)
  assert.equal(adaptLibraryShader('another-pack','outline_shared.gdshaderinc',source),source)
})
