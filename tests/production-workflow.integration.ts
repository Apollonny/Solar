/** Real graph, executor, native skills, editor/runtime and tests; local model fixture.
 * This is adapter acceptance, never a claim about a live model's game quality. */
import { app, BrowserWindow } from 'electron'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { setChatModelRefs, setCurrentProject, setProductionEnabled } from '../src/main/state'
import { setMainWindow } from '../src/main/window'
import { startTestHarness, stopTestHarness } from '../src/main/services/test-harness'
import { closeSceneEditor, openSceneEditor, setSceneEditorBounds, setSceneEditorVisible } from '../src/main/services/scene-editor'
import { prepareProductionProject } from '../src/main/services/production-addons'
import { closeGodotGateway, gatewayRead, startGodotGateway } from '../src/main/services/godot-execution'
import { cancelProduction, productionState, sendProductionMessage } from '../src/main/services/production-workflow'
import { executeProductionAgent, shutdownChat } from '../src/main/services/opencode'
import { saveManagedProviderAuth } from '../src/main/services/opencode-credentials'
import { inspectProductionModels } from '../src/main/services/production-preflight'
import { productionGuidance } from '../src/main/services/production-guidance'
import { gameGuidance, selectProductionSkills } from '../src/main/services/game-guidance'
import { prepareNativeGameSkills } from '../src/main/services/opencode-skills'
import { recommendAssetLibrary, prepareLibraryImports } from '../src/main/services/asset-library'
import type { AssetRecommendation, AssetQuery } from '../src/shared/asset-library'
import type { ChangeSet, StageExecution } from '../src/shared/production'
import { evidenceIntegrity, readRun, runDirectory } from '../src/main/services/production-store'
import type { EvidenceArtifact } from '../src/shared/production'

const fixture = process.env.SOLAR_ACCEPTANCE_DIR!, root = process.env.SOLAR_ACCEPTANCE_ROOT!
const preflightOnly=process.env.SOLAR_ACCEPTANCE_PREFLIGHT_ONLY==='1'
const wireOnly=process.env.SOLAR_ACCEPTANCE_WIRE_ONLY==='1'
const nativeSkillsOnly=process.env.SOLAR_ACCEPTANCE_NATIVE_SKILLS_ONLY==='1'
const wireRole=nativeSkillsOnly?'developer':'planner'
const wireSkills=nativeSkillsOnly?['solar-godot-master','solar-ecs','solar-validation','solar-2d']:['solar-bmad-planning']
const wireGuidance=nativeSkillsOnly?'solar_game_guidance':'solar_production_guidance'
let nativeDocuments: string[] = []
const withAssets=process.env.SOLAR_ACCEPTANCE_ASSETS==='1'
const providerId=wireOnly?'solar-medium-nvidia':'fixture'
const modelId=wireOnly?'nvidia/nemotron-3.5-lightning-30b-a3b':'fixture'
let dimension = '2d', project = '', broken = false, win: BrowserWindow | null = null
const requests: { role: string; skill?: string }[] = [], summaries: unknown[] = []
let visionFaultInjected = false
let selectedAsset: (AssetRecommendation & {packId:string}) | null = null
// Pin the visually measured 512x512 Mana Seed sheet. This acceptance is for a
// single 64x64 pose, not inferred animation semantics or a whole-sheet sprite.
const spriteHash='6aaa516679708670c1923aa0f913523669312d98db956a705c4e095212b06cce'
const assetQuery=():AssetQuery=>dimension==='3d'?{query:'forest rock',packId:'quaternius-nature',mechanic:'environment',dimension:'3d',style:'stylized',limit:1,preset:{kind:'model3d',targetHeight:1.5,collision:'static'}}:{query:'character',packId:'mana-seed-character',path:'upload-14099815/char_a_p1/char_a_p1_0bas_humn_v00.png',mechanic:'movement',dimension:'2d',style:'pixel',limit:1}
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
app.getAppPath = () => root
app.setName('Solar')
mkdirSync(join(fixture,'profile'),{recursive:true})
app.setPath('userData',join(fixture,'profile'))
app.on('window-all-closed', () => {})

// Decode the genuine framebuffer, including all PNG row filters. A dummy image
// or blank process window cannot satisfy this fixture's vision response.
function orangePixels(data: Buffer): number {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let width = 0, height = 0, channels = 0, offset = 8
  const chunks: Buffer[] = []
  while (offset < data.length) {
    const length = data.readUInt32BE(offset), kind = data.toString('ascii', offset+4, offset+8), bytes = data.subarray(offset+8, offset+8+length)
    if (kind === 'IHDR') { width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4); assert.equal(bytes[8], 8); channels = bytes[9] === 6 ? 4 : bytes[9] === 2 ? 3 : 0; assert.equal(bytes[12], 0) }
    if (kind === 'IDAT') chunks.push(bytes)
    offset += length + 12
  }
  assert.ok(channels && width*height <= 4_000_000)
  const raw = inflateSync(Buffer.concat(chunks)), stride = width*channels
  let previous = Buffer.alloc(stride), count = 0
  const paeth = (a:number,b:number,c:number):number => { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c); return pa<=pb && pa<=pc ? a : pb<=pc ? b : c }
  for (let y=0; y<height; y++) {
    const filter = raw[y*(stride+1)], row = Buffer.from(raw.subarray(y*(stride+1)+1, (y+1)*(stride+1)))
    for (let x=0; x<stride; x++) {
      const a=x>=channels ? row[x-channels] : 0, b=previous[x], c=x>=channels ? previous[x-channels] : 0
      row[x] = (row[x] + ([0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter] ?? NaN)) & 255
    }
    for (let x=0; x<stride; x+=channels) if (row[x]>180 && row[x+1]>35 && row[x+1]<190 && row[x+2]<100) count++
    previous = row
  }
  return count
}
async function artifact(role: string): Promise<unknown> {
  if (role === 'planner') return { scope:'feature', story:'Offline fixture: visibly rendered actor responds to real right input.', criteria:[{id:'playable',description:'Actor is visible and moves with right input; clean validation and meaningful test.',evidence:['validation','test','runtime','screenshot','interaction']}], keywords:['godot',dimension,'input','gdscript'], tests:['tests/input_smoke.gd'] }
  if (role === 'tea-strategy') return { risks:['Input mapping or scene wiring may fail.'], tests:['tests/input_smoke.gd'], renderTests:false, evidencePlan:'Original framebuffer, actual before/after actor state, clean logs, current import validation and exact discovered/executed suite.' }
  const state = await productionState()
  assert.ok(state)
  const record = await readRun(state.runId) as { task:{projectRevision:string}; evidence:EvidenceArtifact[] }
  if (role === 'developer') {
    const is3d = dimension === '3d'
    const source = withAssets ? is3d
      ? 'extends CharacterBody3D\nfunc _physics_process(_delta: float) -> void:\n\tvelocity = Vector3(Input.get_action_strength("ui_right") * 2.0, 0.0, 0.0)\n\tmove_and_slide()\n'
      : 'extends Node2D\n@export var collected_count: int = 0\nfunc _process(delta: float) -> void:\n\tposition.x += Input.get_action_strength("ui_right") * 100.0 * delta\n\tif position.x >= 270.0 and collected_count == 0:\n\t\tcollected_count += 1\n\t\tget_parent().get_node("Pickup").queue_free()\n'
      : `extends Node${dimension.toUpperCase()}\nfunc _process(delta: float) -> void:\n\tposition.x += Input.get_action_strength("ui_right") * ${is3d ? '2.0' : '100.0'} * delta\n`
    let scene = is3d
      ? '[gd_scene load_steps=4 format=3]\n[ext_resource type="Script" path="res://move.gd" id="1"]\n[sub_resource type="StandardMaterial3D" id="Orange"]\nshading_mode=0\nalbedo_color=Color(1,0.35,0.05,1)\n[sub_resource type="BoxMesh" id="Box"]\nmaterial=SubResource("Orange")\n[node name="Main" type="Node3D"]\n[node name="Actor" type="MeshInstance3D" parent="."]\nmesh=SubResource("Box")\nscript=ExtResource("1")\n[node name="Camera" type="Camera3D" parent="."]\nposition=Vector3(0,0,4)\ncurrent=true\n'
      : '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://move.gd" id="1"]\n[node name="Main" type="Node2D"]\n[node name="Actor" type="Polygon2D" parent="."]\nposition=Vector2(220,220)\npolygon=PackedVector2Array(0,0,64,0,64,64,0,64)\ncolor=Color(1,0.35,0.05,1)\nscript=ExtResource("1")\n'
    let test = `extends GdUnitTestSuite\nfunc test_input_moves_actor() -> void:\n\tvar scene: PackedScene = load("res://main.tscn")\n\tvar game = auto_free(scene.instantiate())\n\tadd_child(game)\n\tvar actor = game.get_node("Actor")\n\tvar before: float = actor.position.x\n\tInput.action_press("ui_right")\n\tactor._process(0.1)\n\tInput.action_release("ui_right")\n\tassert_float(actor.position.x).${broken ? 'is_less' : 'is_greater'}(before)\n`
    if(withAssets) {
      assert.ok(selectedAsset)
      const resource=selectedAsset.solarPath
      scene=is3d
        ? `[gd_scene load_steps=6 format=3]\n[ext_resource type="Script" path="res://move.gd" id="1"]\n[ext_resource type="PackedScene" path="${resource}" id="Asset"]\n[sub_resource type="StandardMaterial3D" id="Orange"]\nshading_mode=0\nalbedo_color=Color(1,0.35,0.05,1)\n[sub_resource type="BoxMesh" id="Box"]\nsize=Vector3(0.6,1,0.6)\nmaterial=SubResource("Orange")\n[sub_resource type="BoxShape3D" id="Shape"]\nsize=Vector3(0.6,1,0.6)\n[node name="Main" type="Node3D"]\n[node name="Actor" type="CharacterBody3D" parent="."]\nposition=Vector3(-2,0.5,0)\nscript=ExtResource("1")\n[node name="Mesh" type="MeshInstance3D" parent="Actor"]\nmesh=SubResource("Box")\n[node name="Collision" type="CollisionShape3D" parent="Actor"]\nshape=SubResource("Shape")\n[node name="LibraryAsset" parent="." instance=ExtResource("Asset")]\n[node name="Camera" type="Camera3D" parent="."]\nposition=Vector3(0,3,6)\nrotation=Vector3(-0.4,0,0)\ncurrent=true\n[node name="Light" type="DirectionalLight3D" parent="."]\nrotation=Vector3(-0.8,-0.5,0)\n`
        : `[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://move.gd" id="1"]\n[ext_resource type="PackedScene" path="${resource}" id="Asset"]\n[node name="Main" type="Node2D"]\n[node name="Actor" type="Node2D" parent="."]\nposition=Vector2(220,220)\nscript=ExtResource("1")\n[node name="Marker" type="Polygon2D" parent="Actor"]\npolygon=PackedVector2Array(-74,-74,74,-74,74,74,-74,74)\ncolor=Color(1,0.35,0.05,1)\n[node name="LibraryAsset" parent="Actor" instance=ExtResource("Asset")]\nscale=Vector2(2,2)\n[node name="Pickup" type="Polygon2D" parent="."]\nposition=Vector2(270,220)\npolygon=PackedVector2Array(-6,-6,6,-6,6,6,-6,6)\ncolor=Color(0,1,0,1)\n`
      if(is3d) test='extends GdUnitTestSuite\nfunc test_input_moves_actor() -> void:\n\tvar game = auto_free(load("res://main.tscn").instantiate())\n\tadd_child(game)\n\tawait get_tree().physics_frame\n\tawait get_tree().physics_frame\n\tvar actor = game.get_node("Actor")\n\tvar before: float = actor.position.x\n\tInput.action_press("ui_right")\n\tfor frame in range(10):\n\t\tawait get_tree().physics_frame\n\tInput.action_release("ui_right")\n\tassert_float(actor.position.x).is_greater(before)\nfunc test_installed_obstacle_stops_actor() -> void:\n\tvar game = auto_free(load("res://main.tscn").instantiate())\n\tadd_child(game)\n\tawait get_tree().physics_frame\n\tawait get_tree().physics_frame\n\tvar actor = game.get_node("Actor")\n\tInput.action_press("ui_right")\n\tfor frame in range(180):\n\t\tawait get_tree().physics_frame\n\tvar stopped: float = actor.position.x\n\tfor frame in range(60):\n\t\tawait get_tree().physics_frame\n\tInput.action_release("ui_right")\n\tassert_float(stopped).is_greater(-2.0)\n\tassert_float(stopped).is_less(0.0)\n\tassert_float(abs(actor.position.x-stopped)).is_less(0.001)\n'
      else test+='\tvar sprite: Sprite2D = actor.get_node("LibraryAsset")\n\tassert_int(sprite.hframes).is_equal(8)\n\tassert_int(sprite.vframes).is_equal(8)\n\tassert_int(sprite.frame).is_equal(0)\n\tassert_int(sprite.texture.get_width() / sprite.hframes).is_equal(64)\n\tassert_int(sprite.texture.get_height() / sprite.vframes).is_equal(64)\nfunc test_pickup_changes_count() -> void:\n\tvar game = auto_free(load("res://main.tscn").instantiate())\n\tadd_child(game)\n\tvar actor = game.get_node("Actor")\n\tassert_int(actor.collected_count).is_equal(0)\n\tInput.action_press("ui_right")\n\tactor._process(1.0)\n\tInput.action_release("ui_right")\n\tassert_int(actor.collected_count).is_equal(1)\n'
    }
    const mainHash = createHash('sha256').update(await readFile(join(project,'main.tscn'))).digest('hex')
    const existingHash = async (path:string):Promise<string|null> => { const bytes = await readFile(join(project,path)).catch(()=>null); return bytes ? createHash('sha256').update(bytes).digest('hex') : null }
    const scriptHash = await existingHash('move.gd'), testHash = await existingHash('tests/input_smoke.gd')
    return { changeSet:{schemaVersion:1,projectRevision:record.task.projectRevision,summary:'Offline playable input fixture',...(withAssets?{assetImports:[{packId:selectedAsset!.packId,files:[{path:selectedAsset!.sourcePath,sha256:selectedAsset!.sha256,preset:selectedAsset!.preset}]}]}:{}),files:[{path:'move.gd',expectedHash:scriptHash},{path:'main.tscn',expectedHash:mainHash},{path:'tests/input_smoke.gd',expectedHash:testHash}],commands:[
      scriptHash ? {tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://move.gd',content:source}}} : {tool:'script_create',args:{path:'res://move.gd',content:source}},
      {tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://main.tscn',content:scene}}},
      {tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://tests/input_smoke.gd',content:test}}},
      {tool:'filesystem_manage',args:{op:'scan',params:{}}},
      {tool:'scene_open',args:{path:'res://main.tscn'}}
    ]}, scenario:[{tool:'game_manage',args:{op:'get_node_info',params:{path:'/root/Main/Actor'}}},{tool:'game_manage',args:{op:'input_sequence',params:{steps:[{at_frame:0,action:'ui_right',pressed:true},{at_frame:withAssets?150:20,action:'ui_right',pressed:false}],settle_frames:2}}},{tool:'game_manage',args:{op:'get_node_info',params:{path:'/root/Main/Actor'}}},...(withAssets&&!is3d?[{tool:'game_manage',args:{op:'get_node_info',params:{path:'/root/Main/Actor/LibraryAsset'}}}]:[])] }
  }
  assert.equal(await evidenceIntegrity(state.runId,record.evidence),true)
  if (role === 'vision-reviewer') {
    const shot = record.evidence.find(item=>item.kind==='screenshot')!, input = record.evidence.find(item=>item.kind==='interaction')!
    const pixels = orangePixels(await readFile(shot.file))
    assert.ok(pixels>100, `The actual framebuffer has only ${pixels} orange actor pixels.`)
    const interaction = JSON.parse(await readFile(input.file,'utf8'))
    assert.ok(interaction.inputs[2].properties.position.x>interaction.inputs[0].properties.position.x,'Real input must increase Actor X.')
    if(withAssets&&dimension==='2d') {
      assert.ok(interaction.inputs[2].properties.collected_count>interaction.inputs[0].properties.collected_count)
      const sprite=interaction.inputs[3]
      assert.equal(sprite.properties.hframes,8,'The real runtime must display one measured frame, not the whole sheet.')
      assert.equal(sprite.properties.vframes,8);assert.equal(sprite.properties.frame,0)
    }
    return {passed:true,observations:`Offline pixel/state oracle: ${pixels} orange pixels and actor state changed after actual ui_right input. This is a fixture review, not a live AI review.`,criterionIds:['playable']}
  }
  assert.equal(role,'tea-gate')
  const validation = JSON.parse(await readFile(record.evidence.find(item=>item.kind==='validation')!.file,'utf8'))
  const tests = JSON.parse(await readFile(record.evidence.find(item=>item.kind==='test')!.file,'utf8'))
  assert.equal(validation.status,'pass'); assert.equal(tests.junit.executed,withAssets?2:1); assert.equal(tests.junit.scopeMatched,true)
  assert.equal(tests.junit.failed,broken ? 1 : 0)
  if (!broken) assert.equal(tests.exitCode,0)
  return {schemaVersion:1,status:broken?'FAIL':'PASS',reasons:broken?['Original GdUnit4 report contains the intentional failed assertion.']:[],checks:[{criterionId:'playable',passed:!broken,evidenceIds:record.evidence.map(item=>item.id)}]}
}
const model = createServer(async (request,response) => {
  try {
    if(request.method==='GET'&&request.url==='/v1/models') {
      assert.equal(request.headers.authorization,'Bearer offline-fixture')
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({data:[{id:modelId,input_modalities:['text','image']}]}));return
    }
    const chunks: Buffer[]=[]
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if(wireOnly) {
      assert.equal(body.model,modelId);assert.equal(body.reasoning_budget,4096,'Selected NVIDIA reasoning must reach the actual HTTP body.')
      assert.equal(body.max_tokens,nativeSkillsOnly?24576:8192,'The role must retain room for the selected reasoning budget.')
      assert.deepEqual(body.tools.map((tool:{function:{name:string}})=>tool.function.name).sort(),['StructuredOutput','skill',wireGuidance].sort())
    }
    const user = body.messages.find((item:{role:string;content:unknown}) => item.role==='user')
    const content = typeof user.content==='string' ? user.content : user.content.filter((item:{type:string})=>item.type==='text').map((item:{text:string})=>item.text).join('\n')
    const match = content.match(/Microsoft stage: ([\w-]+)\. Assigned native skill references: ([^\n]+)/)
    assert.ok(match,'An unassigned automatic model call must not occur.')
    const role=match[1], skills=match[2].replace(/\.$/,'').split(', ').filter((name:string)=>name!=='none')
    if (role === 'vision-reviewer' && !visionFaultInjected) {
      visionFaultInjected = true
      requests.push({role:'vision-reviewer-transient-fixture'})
      response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Synthetic temporary vision-provider failure'}}));return
    }
    const loaded = new Set<string>()
    for (const message of body.messages) for (const tool of message.tool_calls??[]) if (tool.function.name==='skill' && body.messages.some((item:{role:string;tool_call_id:string})=>item.role==='tool' && item.tool_call_id===tool.id)) loaded.add(JSON.parse(tool.function.arguments).name)
    const next = wireOnly && !nativeSkillsOnly ? undefined : skills.find((name:string)=>!loaded.has(name)), id='chatcmpl-'+randomUUID()
    let requestMethodology = false
    if (wireOnly) {
      const sources = nativeSkillsOnly ? nativeDocuments : [await readFile(join(root, 'resources/production-guidance/skills/solar-bmad-planning/SKILL.md'), 'utf8')]
      assert.ok(sources.length && sources.every(source => content.includes(source)), 'The actual provider receives every byte of the selected skills, including their final instructions.')
      if (!nativeSkillsOnly) assert.equal(loaded.size, 0, 'Host context delivery must not be reported as a native skill call.')
      const calls=body.messages.flatMap((message:{tool_calls?:{id:string;function:{name:string}}[]})=>message.tool_calls??[]).filter((call:{function:{name:string}})=>call.function.name===wireGuidance)
      const supplied=body.messages.filter((message:{role:string;tool_call_id:string})=>message.role==='tool'&&calls.some((call:{id:string})=>call.id===message.tool_call_id))
      requestMethodology = supplied.length === 0
      if (!requestMethodology) {
        const output = JSON.stringify(supplied)
        if (nativeSkillsOnly) assert.ok(output.includes('solar-godot-master') && !output.includes('studio-router'), 'MCP search must return only assigned game guides.')
        else assert.ok(output.includes('solar-bmad-planning') && !output.includes('solar-tea-'), 'MCP search must use the dispatched role, not expose the full methodology catalog.')
      }
    }
    let requestAsset=false
    if(withAssets&&role==='developer'&&!next) {
      const calls=body.messages.flatMap((message:{tool_calls?:{id:string;function:{name:string}}[]})=>message.tool_calls??[]).filter((call:{function:{name:string}})=>call.function.name==='solar_asset_library')
      const supplied=body.messages.filter((message:{role:string;tool_call_id:string})=>message.role==='tool'&&calls.some((call:{id:string})=>call.id===message.tool_call_id))
      if(!supplied.length) {
        const match=(await recommendAssetLibrary(assetQuery()))[0]
        assert.ok(match?.recommendations?.length,'The real installed partner library must provide a compatible candidate.')
        selectedAsset={...match.recommendations[0],packId:match.pack.id};requestAsset=true
        if(dimension==='2d') {
          assert.equal(selectedAsset.sha256,spriteHash)
          assert.deepEqual(selectedAsset.facts,{width:512,height:512})
          assert.deepEqual(selectedAsset.preset,{kind:'sprite2d',frameWidth:64,frameHeight:64})
        }
      } else {
        assert.ok(selectedAsset)
        const text=JSON.stringify(supplied)
        assert.ok(text.includes(selectedAsset.sha256)&&text.includes(selectedAsset.solarPath),'The native asset response must contain the chosen real hash and generated prefab path.')
      }
    }
    let evidenceRead: string | undefined
    if (!next && role === 'tea-gate') {
      const state = await productionState(), record = await readRun(state!.runId) as {evidence:EvidenceArtifact[]}
      const read = new Set<string>()
      for (const message of body.messages) for (const tool of message.tool_calls??[]) if (tool.function.name==='read' && body.messages.some((item:{role:string;tool_call_id:string})=>item.role==='tool' && item.tool_call_id===tool.id)) read.add(JSON.parse(tool.function.arguments).filePath)
      evidenceRead = record.evidence.filter(item=>item.file.endsWith('.json')).find(item=>!read.has(item.file))?.file
    }
    requests.push({role,...(next?{skill:next}:{})})
    const structured = body.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === 'StructuredOutput')
    if (structured) assert.equal(body.tool_choice,'required')
    const delta = next || evidenceRead || requestAsset || requestMethodology || structured ? {tool_calls:[{index:0,id:'call_'+randomUUID(),type:'function',function:{name:next?'skill':requestMethodology?wireGuidance:requestAsset?'solar_asset_library':evidenceRead?'read':'StructuredOutput',arguments:JSON.stringify(next?{name:next}:requestMethodology?{action:'search',query:nativeSkillsOnly?'master':'story'}:requestAsset?{action:'recommend',...assetQuery()}:evidenceRead?{filePath:evidenceRead}:wireOnly?{ok:true}:await artifact(role))}}]} : {content:JSON.stringify(wireOnly?{ok:true}:await artifact(role))}
    response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
    const send = (choices:unknown[],usage?:unknown) => response.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices,...(usage?{usage}:{})})+'\n\n')
    send([{index:0,delta:{role:'assistant'},finish_reason:null}]); send([{index:0,delta,finish_reason:null}])
    send([{index:0,delta:{},finish_reason:next || evidenceRead || requestAsset || requestMethodology || structured ?'tool_calls':'stop'}],{prompt_tokens:10,completion_tokens:10,total_tokens:20})
    response.end('data: [DONE]\n\n')
  } catch(error) { console.error('Local fixture provider:',(error as Error).message); response.writeHead(500,{'content-type':'application/json'}); response.end(JSON.stringify({error:{message:(error as Error).message}})) }
})
void app.whenReady().then(async () => {
  setProductionEnabled(true)
  await new Promise<void>(done=>model.listen(0,'127.0.0.1',done))
  const port = (model.address() as {port:number}).port, ref=providerId+'/'+modelId
  await mkdir(join(homedir(),'.config/opencode'),{recursive:true})
  await writeFile(join(homedir(),'.config/opencode/opencode.json'),JSON.stringify({model:ref,provider:{[providerId]:{npm:'@ai-sdk/openai-compatible',name:'Local offline acceptance fixture',options:{baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'offline-fixture'},models:{[modelId]:{name:'Fixture',limit:{context:200000,output:32768},modalities:{input:['text','image'],output:['text']},...(wireOnly?{options:{reasoning_budget:4096}}:{})}}}},agent:{'image-reader':{model:ref},'game-tester':{model:ref}}}))
  await saveManagedProviderAuth({[providerId]:{type:'api',key:'offline-fixture'}})
  if(wireOnly) {
    setChatModelRefs({chat:ref});startTestHarness()
    project=join(fixture,'wire-project');await mkdir(project);await writeFile(join(project,'project.godot'),'config_version=5\n')
    setCurrentProject({name:'Offline provider wire acceptance',path:project})
    const runId=randomUUID(),revision='a'.repeat(64)
    const scope={role:'developer' as const,skills:['solar-godot-gdscript-mastery']}
    const guides=await gameGuidance({action:'search',query:'gdscript'},undefined,scope) as {totalGuides:number;matches:{skillName:string}[]}
    assert.equal(guides.totalGuides,1);assert.ok(guides.matches.every(guide=>scope.skills.includes(guide.skillName)))
    await gameGuidance({action:'read',id:scope.skills[0]},undefined,scope)
    await assert.rejects(gameGuidance({action:'read',id:scope.skills[0],file:'solar/ecs.md'},undefined,scope),/another guide/)
    await assert.rejects(gameGuidance({action:'read',id:scope.skills[0],file:'upstream/assets/godot-worldmap-builder/plugin.cfg'},undefined,scope))
    const planningScope={role:'planner' as const,skills:['solar-bmad-planning']}
    await assert.rejects(productionGuidance({action:'read',file:'tea/LICENSE'},planningScope),/another role/)
    const selected=await selectProductionSkills(['studio','router','gdscript'])
    assert.ok(selected.names.length>=1&&selected.names.length<=3&&selected.names.every(name=>!name.includes('studio-')))
    if (nativeSkillsOnly) {
      const bundle=await prepareNativeGameSkills()
      nativeDocuments=await Promise.all(wireSkills.map(name=>readFile(join(bundle.path,name,'SKILL.md'),'utf8')))
      assert.ok(nativeDocuments.some(body=>body.length>12000),'This regression must exercise a real guide longer than the former truncation limit.')
    }
    const stage:StageExecution={runId,stageId:'0:planning',eventSeq:0,phase:'planning',repair:0,projectRevision:revision,approved:false,artifacts:{},task:{schemaVersion:1,runId,storyId:randomUUID(),taskRevision:1,projectRevision:revision,request:'Offline provider wire check',projectPath:project,scope:'question',criteria:[],keywords:[],tests:[],model:{providerID:providerId,modelID:modelId},attachments:[]}}
    const result=await executeProductionAgent(stage,wireRole,wireSkills,'Return only {"ok":true}. This local fixture inspects the actual provider HTTP request without contacting NVIDIA.',AbortSignal.timeout(60_000),[],[],{schema:{type:'object',properties:{ok:{const:true}},required:['ok'],additionalProperties:false},toolAllowlist:['skill',wireGuidance,'StructuredOutput']})
    assert.deepEqual(result,{ok:true});assert.equal(requests.length,nativeSkillsOnly?wireSkills.length+2:2)
    assert.deepEqual(stage.loadedSkills?.sort(),nativeSkillsOnly?[...wireSkills].sort():[])
    assert.equal(stage.skillContext?.length,wireSkills.length);assert.ok(stage.skillContext?.every(receipt=>receipt.delivery==='host-context'))
    summaries.push({providerId,modelId,reasoningBudget:4096,maxOutputTokens:nativeSkillsOnly?24576:8192,skillContext:stage.skillContext,loadedSkills:stage.loadedSkills})
    console.log(`PASS: real managed OpenCode/AI SDK request carries complete verified skills, scoped MCP guidance and selected NVIDIA reasoning_budget=4096; ${nativeSkillsOnly?'actual native tool loads recorded separately':'no native skill call was invented'}. Local endpoint only, no paid request.`)
    return
  }
  if(preflightOnly) {
    const preflight=await inspectProductionModels()
    assert.equal(preflight.ready,true,preflight.reasons.join('; '));assert.equal(requests.length,0)
    summaries.push({preflight})
    console.log('PASS: isolated custom-provider catalogs, encrypted credentials and image capability preflight; no generation or Godot launch.')
    return
  }
  startTestHarness()
  win=new BrowserWindow({width:960,height:700,title:'Solar offline production workflow acceptance',backgroundColor:'#08090e',show:false}); setMainWindow(win)
  await win.loadURL('data:text/html,<body style="background:%2308090e;color:white">Offline production adapter acceptance</body>');win.show()
  for (const item of [{dimension:'2d',broken:false,name:'2d'},{dimension:'3d',broken:false,name:'3d'},{dimension:'2d',broken:true,name:'broken2d'}].filter(item=>(process.env.SOLAR_ACCEPTANCE_BROKEN_ONLY!=='1'||item.broken)&&(!withAssets||!item.broken)&&(process.env.SOLAR_ACCEPTANCE_2D_ONLY!=='1'||item.dimension==='2d'))) {
    dimension=item.dimension;broken=item.broken;selectedAsset=null
    project=join(fixture,item.name); await mkdir(project)
    await writeFile(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Solar offline workflow acceptance"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    await writeFile(join(project,'main.tscn'),`[gd_scene format=3]\n[node name="Main" type="Node${dimension.toUpperCase()}"]\n`)
    setCurrentProject({name:'Offline workflow acceptance',path:project});await prepareProductionProject(project);await startGodotGateway()
    setSceneEditorBounds({x:0,y:0,width:930,height:620});setSceneEditorVisible(true);await openSceneEditor(project)
    const editorDeadline=Date.now()+50_000
    while(true){try{await gatewayRead(project,'editor_state');break}catch(error){if(Date.now()>editorDeadline)throw error;await pause(250)}}
    await sendProductionMessage(`Offline ${dimension} adapter acceptance: add a visible orange actor controlled by ui_right.${withAssets?' Select an installed native library sprite for 2d, or a static collision rock for 3d. Observe pickup/collision and run two cases.':''} This request uses a deterministic local model fixture and cannot certify live AI quality.`,project,[])
    const deadline=Date.now()+4*60_000;let last=''
    while(true){
      const state=await productionState();assert.ok(state)
      const label=`${dimension}:${state.phase}:${state.status}`
      if(label!==last){console.log('Offline workflow:',label,state.message??'');last=label}
      if(state.status==='complete'){
        assert.equal(broken,false,'An intentional failing test must never Complete.')
        assert.equal(state.gate?.status,'PASS')
        const run=await readRun(state.runId) as {executions:Record<string,{loadedSkills:string[]}>;evidence:EvidenceArtifact[];checkpoint:unknown;development:{changeSet:ChangeSet}}
        assert.equal(Object.keys(run.executions).length,9);assert.ok(run.checkpoint);assert.equal(await evidenceIntegrity(state.runId,run.evidence),true)
        assert.equal(run.evidence.filter(item=>item.kind==='runtime').length,1,'A vision retry must reuse the original capture, not relaunch the game.')
        if (dimension==='2d') {
          const runtime=JSON.parse(await readFile(run.evidence.find(item=>item.kind==='runtime')!.file,'utf8'))
          assert.equal(runtime.gameLogs.run_id.endsWith('-1'),true,'Only the first runtime launch may occur after a transient vision failure.')
        }
        assert.ok(run.executions['0:developing'].loadedSkills.includes('solar-'+dimension))
        if(withAssets) {
          assert.ok(run.development.changeSet.assetImports?.length)
          for(const file of (await prepareLibraryImports(run.development.changeSet.assetImports)).filter(file=>!file.engineMetadata))assert.ok((await readFile(join(project,file.path))).equals(file.bytes))
          assert.ok((await readFile(join(project,'main.tscn'),'utf8')).includes(selectedAsset!.solarPath))
        }
        summaries.push({dimension,runId:state.runId,fixtureGate:state.gate,...(withAssets?{asset:selectedAsset}:{}),phases:Object.keys(run.executions),evidence:run.evidence.map(item=>({kind:item.kind,sha256:item.sha256}))})
        console.log(`PASS: offline ${dimension} actual Microsoft → OpenCode/native skills${withAssets?' → native asset recommendation/import':''} → embedded Godot → input/framebuffer pixel oracle → GdUnit4 → constrained fixture gate.`);break
      }
      if (broken && state.status==='fail') {
        assert.equal(state.gate?.status,'FAIL');assert.equal(state.repair,2)
        const run=await readRun(state.runId) as {tests:{failed:number};evidence:EvidenceArtifact[]}
        assert.equal(run.tests.failed,1);assert.equal(await evidenceIntegrity(state.runId,run.evidence),true)
        summaries.push({dimension,broken:true,runId:state.runId,fixtureGate:state.gate,repairs:state.repair})
        console.log('PASS: intentionally broken fixture stays FAIL after exactly two Microsoft repair rounds; never Complete.');break
      }
      if(state.status!=='running')throw new Error(`Offline workflow blocked: ${state.message??state.gate?.reasons.join('; ')}`)
      if(Date.now()>deadline)throw new Error('Offline workflow deadline exceeded.')
      await pause(150)
    }
    await cancelProduction();shutdownChat();await closeSceneEditor();closeGodotGateway()
  }
}).catch(error=>{console.error((error as Error).stack);process.exitCode=1}).finally(async()=>{
  await cancelProduction();shutdownChat();await closeSceneEditor().catch(()=>{});closeGodotGateway();win?.destroy();stopTestHarness()
  model.closeAllConnections();model.close()
  await writeFile(join(fixture,'summary.json'),JSON.stringify({type:wireOnly?'offline-provider-wire':preflightOnly?'offline-model-preflight':'offline-adapter-acceptance',liveModelAcceptance:false,passed:!process.exitCode,summaries,requests},null,2))
  app.exit(Number(process.exitCode??0))
})
