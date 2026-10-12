import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { assetTarget, validateAssetPreset } from '../../shared/asset-library'
import type { AssetPack, AssetPreset, AssetRecommendation } from '../../shared/asset-library'

type Facts = AssetRecommendation['facts']
interface Document {
  animations?: {name?: string}[]; skins?: unknown[]
  accessors?: {min?: number[];max?: number[]}[]
  meshes?: {primitives?: {attributes?: {POSITION?: number}}[]}[]
  nodes?: {mesh?: number;skin?: number;children?: number[];matrix?: number[];translation?: number[];rotation?: number[];scale?: number[]}[]
  scene?: number; scenes?: {nodes?: number[]}[]
}
const digest = (value:string):string => createHash('sha256').update(value).digest('hex')
const vector = (value: number[]): string => `Vector3(${value.map(n=>Number(n.toFixed(6))).join(', ')})`
const quote = JSON.stringify
const identity = ():number[] => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
function multiply(a:number[],b:number[]):number[] {
  return Array.from({length:16},(_,i)=>Array.from({length:4},(_,k)=>a[k*4+i%4]*b[Math.floor(i/4)*4+k]).reduce((x,y)=>x+y,0))
}
function transform(node:NonNullable<Document['nodes']>[number]):number[] {
  if(node.matrix?.length===16&&node.matrix.every(Number.isFinite))return node.matrix
  const [x,y,z,w]=node.rotation??[0,0,0,1],s=node.scale??[1,1,1],t=node.translation??[0,0,0]
  return [(1-2*(y*y+z*z))*s[0],2*(x*y+z*w)*s[0],2*(x*z-y*w)*s[0],0,2*(x*y-z*w)*s[1],(1-2*(x*x+z*z))*s[1],2*(y*z+x*w)*s[1],0,2*(x*z+y*w)*s[2],2*(y*z-x*w)*s[2],(1-2*(x*x+y*y))*s[2],0,...t,1]
}
/** Read source facts, including node transforms. Skinned meshes have no static collision bounds. */
export function inspectAsset(path:string,bytes:Buffer):Facts {
  if(/\.png$/i.test(path)&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}
  let document:Document|undefined
  if(/\.gltf$/i.test(path))document=JSON.parse(bytes.toString())
  if(/\.glb$/i.test(path)) {
    if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a||bytes.readUInt32LE(12)>8*1024*1024||20+bytes.readUInt32LE(12)>bytes.length)throw new Error('Invalid or oversized GLB metadata.')
    document=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString().trim())
  }
  if(!document)return {}
  const facts:Facts={animationNames:(document.animations??[]).map((a,i)=>a.name??`Animation_${i}`).slice(0,100),skinCount:document.skins?.length??0}
  const nodes=document.nodes??[]
  if(nodes.length>5000||facts.skinCount||facts.animationNames!.length)return facts
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],active=new Set<number>()
  let visits=0,missing=false
  const walk=(index:number,parent:number[]):void=>{
    if(active.has(index)||++visits>10000)throw new Error('Invalid GLTF node hierarchy.')
    const node=nodes[index];if(!node)throw new Error('Invalid GLTF scene node.')
    active.add(index);const matrix=multiply(parent,transform(node))
    if(node.mesh!==undefined)for(const primitive of document!.meshes?.[node.mesh]?.primitives??[]) {
      const accessor=document!.accessors?.[primitive.attributes?.POSITION??-1]
      if(!accessor?.min||!accessor.max||accessor.min.length!==3||accessor.max.length!==3){missing=true;continue}
      for(let corner=0;corner<8;corner++) {
        const point=accessor.min.map((n,i)=>corner&(1<<i)?accessor.max![i]:n)
        for(let axis=0;axis<3;axis++){const n=matrix[axis]*point[0]+matrix[4+axis]*point[1]+matrix[8+axis]*point[2]+matrix[12+axis];min[axis]=Math.min(min[axis],n);max[axis]=Math.max(max[axis],n)}
      }
    }
    for(const child of node.children??[])walk(child,matrix)
    active.delete(index)
  }
  const roots=document.scenes?.[document.scene??0]?.nodes??nodes.map((_,i)=>i).filter(i=>!nodes.some(node=>node.children?.includes(i)))
  for(const node of roots)walk(node,identity())
  if(!missing&&[...min,...max].every(Number.isFinite)&&max[1]>min[1])facts.bounds={min,max}
  return facts
}
export function defaultAssetPreset(pack:AssetPack,path:string,sha256?:string):AssetPreset|undefined {
  if(pack.kind==='animation'&&/\.(glb|gltf|fbx)$/i.test(path))return {kind:'animation-library'}
  if(/\.(glb|gltf|fbx|obj)$/i.test(path))return {kind:'model3d',collision:'none'}
  if(pack.dimension==='3d'&&pack.kind==='vfx'&&/\.tscn$/i.test(path))return {kind:'effect3d'}
  if(pack.dimension==='2d'&&/\.png$/i.test(path)) {
    // This exact Mana Seed sheet was visually checked: 512x512, 8x8 cells.
    // Animation semantics are deliberately not inferred from pose order.
    if(pack.id==='mana-seed-character'&&sha256==='6aaa516679708670c1923aa0f913523669312d98db956a705c4e095212b06cce')return {kind:'sprite2d',frameWidth:64,frameHeight:64}
    return {kind:'sprite2d'}
  }
  if(/\.(wav|ogg|mp3)$/i.test(path))return {kind:'audio',volumeDb:-12,loop:pack.tags.includes('ambience')||pack.kind==='audio'&&/ambience|music/i.test(pack.title)}
  if(/\.gdshader$/i.test(path))return {kind:'shader-material'}
  return undefined
}
export function solarPresetPath(packId:string,path:string,sha256:string,preset:AssetPreset):string {
  const clean=validateAssetPreset(preset),stem=posix.basename(path).replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,50)||'asset'
  const recipe=Object.fromEntries(Object.entries(clean).sort(([a],[b])=>a.localeCompare(b)))
  return assetTarget(packId,`solar/${stem}-${digest(JSON.stringify({version:1,source:path,sha256,recipe})).slice(0,16)}.${preset.kind==='shader-material'?'tres':'tscn'}`)
}
export interface PresetFile {path:string;bytes:Buffer;engineMetadata?:true}
/** Generate immutable, namespaced wrappers. Original cache assets are never modified. */
export function buildAssetPreset(pack:AssetPack,path:string,sha256:string,bytes:Buffer,input:AssetPreset):{files:PresetFile[];facts:Facts;notes:string[]} {
  const preset=validateAssetPreset(input),target=solarPresetPath(pack.id,path,sha256,preset),resource=assetTarget(pack.id,path),facts=inspectAsset(path,bytes),notes:string[]=[],files:PresetFile[]=[]
  const expected=defaultAssetPreset(pack,path)
  if(!expected||expected.kind!==preset.kind)throw new Error('The preset is incompatible with this source file.')
  let text=''
  if(preset.kind==='sprite2d') {
    if(!facts.width||!facts.height)throw new Error('A sprite preset needs a valid PNG with measured dimensions.')
    const width=preset.frameWidth??facts.width,height=preset.frameHeight??facts.height
    if(facts.width%width||facts.height%height)throw new Error('Sprite grid does not fit the source dimensions.')
    const columns=facts.width/width,rows=facts.height/height
    if(!preset.frameWidth)notes.push('Whole source image; sprite-sheet frame layout is unspecified. Supply measured frame dimensions and clips before gameplay use.')
    else if(columns*rows>1&&!preset.animations)notes.push('Measured sprite grid; first frame selected. Add explicit verified clips for gameplay animation.')
    if(preset.animations) {
      const resources:string[]=[],clips:string[]=[];let index=0
      for(const clip of preset.animations) {
        if(clip.start+clip.count>columns*rows)throw new Error('Sprite animation references a frame outside the measured sheet.')
        const frames=[]
        for(let frame=clip.start;frame<clip.start+clip.count;frame++) {
          const id=`Frame_${index++}`
          resources.push(`[sub_resource type="AtlasTexture" id="${id}"]\natlas = ExtResource("1")\nregion = Rect2(${frame%columns*width}, ${Math.floor(frame/columns)*height}, ${width}, ${height})`)
          frames.push(`{"duration": 1.0, "texture": SubResource("${id}")}`)
        }
        clips.push(`{"frames": [${frames.join(', ')}], "loop": ${clip.loop}, "name": &${quote(clip.name)}, "speed": ${clip.fps}}`)
      }
      text=`[gd_scene load_steps=${index+3} format=3]\n[ext_resource type="Texture2D" path=${quote('res://'+resource)} id="1"]\n${resources.join('\n')}\n[sub_resource type="SpriteFrames" id="Frames"]\nanimations = [${clips.join(', ')}]\n[node name="SolarSprite" type="AnimatedSprite2D"]\ntexture_filter = ${pack.style==='pixel'?1:2}\nsprite_frames = SubResource("Frames")\nanimation = &${quote(preset.animations[0].name)}\n`
    }else text=`[gd_scene load_steps=2 format=3]\n[ext_resource type="Texture2D" path=${quote('res://'+resource)} id="1"]\n[node name="SolarSprite" type="Sprite2D"]\ntexture_filter = ${pack.style==='pixel'?1:2}\ntexture = ExtResource("1")\nhframes = ${columns}\nvframes = ${rows}\nframe = 0\n`
  } else if(['model3d','effect3d','animation-library'].includes(preset.kind)) {
    const obj=/\.obj$/i.test(path),collision=preset.kind==='model3d'&&preset.collision&&preset.collision!=='none'
    if((preset.targetHeight||collision)&&!facts.bounds)throw new Error('Scaling and collision require verified static GLTF bounds. Adapt this source in the editor first.')
    const size=facts.bounds?.max.map((n,i)=>n-facts.bounds!.min[i]),scale=preset.targetHeight?preset.targetHeight/size![1]:1
    const position=facts.bounds&&preset.targetHeight?[-(facts.bounds.min[0]+facts.bounds.max[0])/2*scale,-facts.bounds.min[1]*scale,-(facts.bounds.min[2]+facts.bounds.max[2])/2*scale]:[0,0,0]
    const normalizedSize=size?.map(n=>Math.max(n*scale,0.001)),center=facts.bounds?.min.map((n,i)=>(n+facts.bounds!.max[i])/2*scale+position[i])
    text=`[gd_scene load_steps=${collision?3:2} format=3]\n[ext_resource type="${obj?'Mesh':'PackedScene'}" path=${quote('res://'+resource)} id="1"]\n`
    if(collision)text+=`[sub_resource type="BoxShape3D" id="Collision"]\nsize = ${vector(normalizedSize!)}\n`
    text+='[node name="SolarAsset" type="Node3D"]\n'
    text+=obj?'[node name="Model" type="MeshInstance3D" parent="."]\nmesh = ExtResource("1")\n':'[node name="Model" parent="." instance=ExtResource("1")]\n'
    text+=`position = ${vector(position)}\nscale = ${vector([scale,scale,scale])}\n`
    if(collision)text+=`[node name="${preset.collision==='pickup'?'Pickup':'Body'}" type="${preset.collision==='pickup'?'Area3D':'StaticBody3D'}" parent="."]\n[node name="Shape" type="CollisionShape3D" parent="${preset.collision==='pickup'?'Pickup':'Body'}"]\nposition = ${vector(center!)}\nshape = SubResource("Collision")\n`
    if(preset.kind==='animation-library') {
      notes.push('Imported rig and animation names are preserved. Retarget to the target skeleton in the editor; compatibility is not assumed.')
      text=text.replace('[node name="SolarAsset" type="Node3D"]',`[node name="SolarAsset" type="Node3D"]\nmetadata/solar_animation_names = ${JSON.stringify(facts.animationNames??[])}\nmetadata/solar_requires_retarget = true`)
      files.push({path:resource+'.import',engineMetadata:true,bytes:Buffer.from(`[remap]\nimporter="scene"\ntype="PackedScene"\n[deps]\nsource_file=${quote('res://'+resource)}\n[params]\nanimation/import=true\nanimation/fps=30\nanimation/trimming=false\n`)})
    }
    if(preset.kind==='model3d'&&!facts.bounds)notes.push('Source units retained; static bounds unavailable. Inspect rig/scale before adding collision.')
  } else if(preset.kind==='audio') {
    const scriptPath=target.replace(/\.tscn$/,'.gd')
    const script=`#=== solar ===\n# kind: util\n# name: library_audio\n# summary: Configure a private audio stream without altering the source.\n# uses: none\n#=== /solar ===\nextends AudioStreamPlayer\nfunc _ready() -> void:\n\tstream = stream.duplicate()\n\tif stream is AudioStreamWAV:\n\t\tstream.set("loop_mode", AudioStreamWAV.LOOP_FORWARD if ${preset.loop??false} else AudioStreamWAV.LOOP_DISABLED)\n\telif stream is AudioStreamOggVorbis or stream is AudioStreamMP3:\n\t\tstream.set("loop", ${preset.loop??false})\n`
    files.push({path:scriptPath,bytes:Buffer.from(script)})
    text=`[gd_scene load_steps=3 format=3]\n[ext_resource type="AudioStream" path=${quote('res://'+resource)} id="1"]\n[ext_resource type="Script" path=${quote('res://'+scriptPath)} id="2"]\n[node name="SolarAudio" type="AudioStreamPlayer"]\nstream = ExtResource("1")\nvolume_db = ${preset.volumeDb??-12}\nautoplay = false\nscript = ExtResource("2")\n`
  } else {
    if(!/^\s*shader_type\s+(canvas_item|spatial|particles)\s*;/m.test(bytes.toString()))throw new Error('Shader type cannot be verified.')
    text=`[gd_resource type="ShaderMaterial" load_steps=2 format=3]\n[ext_resource type="Shader" path=${quote('res://'+resource)} id="1"]\n[resource]\nshader = ExtResource("1")\n`
    notes.push('Original shader uniforms preserved; validate renderer and required textures before use.')
  }
  files.push({path:target,bytes:Buffer.from(text)})
  files.push({path:target.replace(/\.(tscn|tres)$/,'.preset.json'),bytes:Buffer.from(JSON.stringify({schemaVersion:1,recipeVersion:1,sourcePath:path,sourceHash:sha256,preset,facts,notes},null,2))})
  return {files,facts,notes}
}
