/** Explicit live acceptance, one request on the user's selected provider. */
import { app, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { strict as assert } from 'node:assert'
import { loadSettings, setChatModelRefs, setCurrentProject, setProductionEnabled } from '../src/main/state'
import { executeProductionAgent, prepareProductionExecutor, productionExecutorCapabilities, shutdownChat } from '../src/main/services/opencode'
import { resolveChatModel } from '../src/main/services/opencode-setup'
import { startTestHarness, getHarnessEndpoint, stopTestHarness } from '../src/main/services/test-harness'
import { snapshotProject } from '../src/main/services/project-snapshot'
import { prepareProductionProject } from '../src/main/services/production-addons'
import { startGodotGateway, closeGodotGateway, gatewayRead } from '../src/main/services/godot-execution'
import { closeSceneEditor, openSceneEditor, setSceneEditorBounds, setSceneEditorVisible } from '../src/main/services/scene-editor'
import { sendProductionMessage, productionState, cancelProduction } from '../src/main/services/production-workflow'
import { setMainWindow } from '../src/main/window'
import { loadManagedProviderAuth, saveManagedProviderAuth } from '../src/main/services/opencode-credentials'
import { recommendAssetLibrary, prepareLibraryImports } from '../src/main/services/asset-library'
import { readRun, evidenceIntegrity } from '../src/main/services/production-store'
import type { ChangeSet, EvidenceArtifact, TestExecutionResult } from '../src/shared/production'
import { inspectProductionModels } from '../src/main/services/production-preflight'
import { productionOutputSchemas } from '../src/shared/production-output'

const source = process.env.SOLAR_ACCEPTANCE_PROFILE
if (!source) throw new Error('Provide SOLAR_ACCEPTANCE_PROFILE for an explicit live selected-provider acceptance.')
const scratch = process.env.SOLAR_ACCEPTANCE_DIR ?? mkdtempSync(join(tmpdir(), 'solar-model-check-'))
const profile = join(scratch, 'profile'), project = join(scratch, 'project')
mkdirSync(profile); mkdirSync(project)
for (const file of ['Local State', 'settings.json', 'opencode-credentials.json']) {
  if (existsSync(join(source, file))) copyFileSync(join(source, file), join(profile, file))
}
app.setName('Solar'); app.setPath('userData', profile)
app.getAppPath = () => process.env.SOLAR_ACCEPTANCE_ROOT!
app.on('window-all-closed', () => {})
let win: BrowserWindow | null = null
void app.whenReady().then(async () => {
  loadSettings(); setProductionEnabled(true)
  // This profile/config live in an isolated fixture; the saved Solar model is
  // never changed when an explicitly authorized acceptance override is used.
  if (process.env.SOLAR_ACCEPTANCE_MODEL) setChatModelRefs({ chat: process.env.SOLAR_ACCEPTANCE_MODEL })
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Solar model adapter acceptance"\n')
  setCurrentProject({ name: 'Solar model adapter acceptance', path: project })
  startTestHarness()
  for (let poll=0; !getHarnessEndpoint() && poll<100; poll++) await new Promise(done=>setTimeout(done,50))
  const model=await resolveChatModel(), snapshot=await snapshotProject(project)
  if (process.env.SOLAR_ACCEPTANCE_KEY_FILE) {
    if (!model.providerID.endsWith('-nvidia')) throw new Error('The file credential override is restricted to the selected NVIDIA provider.')
    const keys = [...new Set(readFileSync(process.env.SOLAR_ACCEPTANCE_KEY_FILE, 'utf8').match(/nvapi-[A-Za-z0-9_-]{16,}/g) ?? [])]
    if (keys.length !== 1) throw new Error('NVIDIA acceptance credential file is missing a unique key.')
    const auth = await loadManagedProviderAuth(); auth[model.providerID] = { type: 'api', key: keys[0] }
    await saveManagedProviderAuth(auth)
  }
  console.log('Selected provider/model:', model.providerID, model.modelID)
  if(process.env.SOLAR_ACCEPTANCE_VISION==='1') {
    const file=join(process.env.SOLAR_ACCEPTANCE_ROOT!,'.test-dist/acceptance/asset-libgodot-3d.png')
    const bytes=readFileSync(file)
    assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    const runId=randomUUID()
    const stage={runId,stageId:'0:runtime',eventSeq:0,phase:'runtime' as const,repair:0,projectRevision:snapshot.revision!,approved:false,artifacts:{},task:{schemaVersion:1 as const,runId,storyId:randomUUID(),taskRevision:1,projectRevision:snapshot.revision!,request:'Confirm selected vision provider can inspect an original Godot framebuffer.',scope:'question' as const,projectPath:project,criteria:[],keywords:[],tests:[],model,attachments:[]}}
    const result=await executeProductionAgent(stage,'vision-reviewer',[],'This is a provider capability check only. Inspect the attached original Godot framebuffer and describe the central visible prop in one sentence. Return ONLY {"imageReceived":boolean,"observations":string}. Do not claim feature acceptance or gameplay correctness.',AbortSignal.timeout(120_000),[{mime:'image/png',dataUrl:'data:image/png;base64,'+bytes.toString('base64'),name:'original-godot-framebuffer.png'}]) as {imageReceived:boolean;observations:string}
    assert.equal(result.imageReceived,true);assert.equal(typeof result.observations,'string')
    console.log('PASS: selected vision model accepted an original Godot framebuffer and completed structured inspection; not feature acceptance.')
    return
  }
  if(process.env.SOLAR_ACCEPTANCE_PREFLIGHT==='1') {
    const preflight=await inspectProductionModels()
    writeFileSync(join(scratch,'preflight.json'),JSON.stringify(preflight,null,2))
    console.log('Production model preflight:',JSON.stringify(preflight))
    assert.equal(preflight.ready,true,preflight.reasons.join(' '))
    await prepareProductionExecutor(project)
    const capabilities=await productionExecutorCapabilities(project)
    assert.equal(capabilities.solarStatus,'connected')
    console.log('PASS: credentials, selected catalogs, vision capability and managed MCP access; quota is reported separately and does not prove account balance. No model generation.')
    return
  }
  if (process.env.SOLAR_ACCEPTANCE_STARTUP_ONLY === '1') {
    await prepareProductionExecutor(project)
    const capabilities=await productionExecutorCapabilities(project)
    console.log('Native Solar capabilities:',JSON.stringify(capabilities))
    assert.equal(capabilities.solarStatus,'connected')
    assert.ok(capabilities.allowedSolarTools.planner.includes('solar_asset_library'))
    assert.ok(capabilities.allowedSolarTools.developer.includes('solar_asset_library'))
    for(const role of ['vision-reviewer','tea-strategy','tea-gate'] as const)assert.ok(!capabilities.allowedSolarTools[role].includes('solar_asset_library'))
    console.log('PASS: actual managed OpenCode startup, bounded role/compaction config and native skill discovery; no model generation.')
    return
  }
  if (process.env.SOLAR_ACCEPTANCE_WORKFLOW === '1') {
    const preflight=await inspectProductionModels()
    writeFileSync(join(scratch,'preflight.json'),JSON.stringify(preflight,null,2))
    assert.equal(preflight.ready,true,preflight.reasons.join(' '))
    writeFileSync(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Solar production acceptance"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    const is3d = process.env.SOLAR_ACCEPTANCE_3D === '1'
    writeFileSync(join(project,'main.tscn'),`[gd_scene format=3]\n[node name="Main" type="${is3d ? 'Node3D' : 'Node2D'}"]\n`)
    await prepareProductionProject(project);await startGodotGateway()
    win=new BrowserWindow({width:960,height:700,title:'Solar production acceptance',backgroundColor:'#08090e',show:false})
    setMainWindow(win);await win.loadURL('data:text/html,<body style="background:%2308090e;color:white">Solar production acceptance</body>');win.show()
    setSceneEditorBounds({x:0,y:0,width:930,height:620});setSceneEditorVisible(true);await openSceneEditor(project)
    // Wait for the authenticated gateway; the workflow then binds a stable revision.
    const editorDeadline=Date.now()+50_000
    while(true){try{await gatewayRead(project,'editor_state');break}catch(error){if(Date.now()>editorDeadline)throw error;await new Promise(done=>setTimeout(done,500))}}
    const assetFeature=process.env.SOLAR_ACCEPTANCE_ASSETS==='1'
    const feature = is3d ? '3D stylized forest scene with a clearly visible orange CharacterBody3D actor, current Camera3D and suitable light/background. The actor moves along positive X with ui_right, and stops when its collision hits a static obstacle. Choose a compatible installed library prop yourself for that obstacle; use its measured model3d collision preset and place it in the movement path' : '2D scene with a clearly visible moving character using a compatible installed library sprite that you choose yourself. With ui_right it moves along positive X and collects a simple procedural pickup in its path; the Actor exposes @export var collected_count: int for real get_node_info measurement. Use only verified sprite frame dimensions; no guessed animation names'
    const primitiveFeature=is3d?'3D feature with a visible orange cube that moves right with ui_right':'2D feature with a visible orange square that moves right with ui_right'
    await sendProductionMessage(`Implement one small playable ${assetFeature?feature:primitiveFeature}. Keep res://main.tscn as entry and do not change project.godot or addons. Name the movable runtime node Actor under Main. Follow Solar ECS guidance where applicable. Prepare one meaningful GdUnit4 suite tests/input_smoke.gd with ${assetFeature?'at least two test cases covering movement plus '+(is3d?'collision':'pickup'):'input'}; use non-render headless tests and literal res:// load/preload paths. Story must require validation, tests, runtime, screenshot and interaction. Include a real gameplay scenario with get_node_info(/root/Main/Actor), input_sequence ui_right pressed frame 0 and released frame ${assetFeature?150:20} with settle_frames 2, then get_node_info again. ${assetFeature?'This acceptance story specifically exercises automatic asset selection/import: choose a suitable real installed library file via solar_asset_library recommend, submit exact SHA-256/preset in assetImports, instance its returned solarPath in main.tscn, and make it visible. Do not ask the user to select a pack.':''} Use English technical keywords godot ${is3d?'3d environment collision':'2d sprite pickup'} input gdscript. This is a feature within an existing project, not a new game. No deletion or change to the main scene setting.`,project,[])
    let last='';const deadline=Date.now()+60*60_000
    while(Date.now()<deadline){
      const state=await productionState()
      if(state){
        const label=`${state.phase}:${state.status}:repair${state.repair}`
        if(label!==last){console.log('Workflow:',label,state.message??'');last=label}
        if(state.status==='complete'){
          assert.equal(state.gate?.status,'PASS')
          const record=await readRun(state.runId) as {development:{changeSet:ChangeSet};evidence:EvidenceArtifact[];tests:TestExecutionResult}
          assert.equal(await evidenceIntegrity(state.runId,record.evidence),true)
          assert.ok(record.tests.executed>= (assetFeature?2:1));assert.equal(record.tests.failed,0);assert.equal(record.tests.skipped,0)
          if(assetFeature) {
            const imports=record.development.changeSet.assetImports??[];assert.ok(imports.length>0,'AI must actually select installed assets for this acceptance story.')
            const generated=await prepareLibraryImports(imports)
            for(const file of generated.filter(item=>!item.engineMetadata))assert.equal(readFileSync(join(project,file.path)).equals(file.bytes),true)
            const main=readFileSync(join(project,'main.tscn'),'utf8')
            assert.ok(generated.some(file=>/\/solar\/.*\.tscn$/.test(file.path)&&main.includes('res://'+file.path)),'A generated prefab must be instanced by the real entry scene.')
            const input=JSON.parse(readFileSync(record.evidence.find(item=>item.kind==='interaction')!.file,'utf8'))
            const states=input.inputs.filter((item:{op?:string;name?:string;found?:boolean})=>item.op==='get_node_info'&&item.name==='Actor'&&item.found===true)
            assert.ok(states.length>=2,'Actor state must be observed before and after real input.')
            const beforeX=states[0].properties?.position?.x,afterX=states.at(-1).properties?.position?.x
            assert.ok(Number.isFinite(beforeX)&&Number.isFinite(afterX)&&afterX>beforeX,'Real ui_right input must increase Actor X, not merely change unrelated metadata.')
            if(!is3d)assert.ok(states.at(-1).properties?.collected_count>states[0].properties?.collected_count,'A pickup must actually change the measured Actor count.')
          }
          console.log('PASS: selected-provider Microsoft → BMAD → skills → Developer → embedded Godot → real input/framebuffer → GdUnit4 → TEA gate'+(assetFeature?' with AI-selected installed assets.':'.'));return
        }
        if(!['running'].includes(state.status)) throw new Error(`Live workflow stopped without acceptance: ${state.status}: ${state.message ?? state.gate?.reasons.join('; ')}`)
      }
      await new Promise(done=>setTimeout(done,500))
    }
    throw new Error('Live workflow acceptance exceeded its deadline.')
  }
  const runId=randomUUID()
  if(process.env.SOLAR_ACCEPTANCE_ASSETS==='1') {
    const stage={runId,stageId:'0:planning',eventSeq:0,phase:'planning' as const,repair:0,projectRevision:snapshot.revision!,approved:false,artifacts:{},task:{schemaVersion:1 as const,runId,storyId:randomUUID(),taskRevision:1,projectRevision:snapshot.revision!,request:'Choose a compatible 3D forest rock from installed assets.',scope:'question' as const,projectPath:project,criteria:[],keywords:['forest','rock','3d'],tests:[],model,attachments:[]}}
    const chosen=await executeProductionAgent(stage,'planner',[],'This is a read-only asset selection check, not a GDD or planning exercise. No skills are assigned. Call solar_asset_library once: {"action":"recommend","query":"forest rock","mechanic":"environment","dimension":"3d","style":"stylized","limit":1}. Choose the first recommendations item from the response. Return ONLY JSON {packId,sourcePath,sha256,solarPath,preset} copying its real values. Do not modify files, import, delegate or explain. If unavailable, return JSON {"error":"unavailable"}.',AbortSignal.timeout(240_000)) as {packId:string;sourcePath:string;sha256:string;solarPath:string;preset:import('../src/shared/asset-library').AssetPreset}
    const expected=await recommendAssetLibrary({query:'forest rock',packId:chosen.packId,path:chosen.sourcePath,preset:chosen.preset,dimension:'3d',style:'stylized',mechanic:'environment',limit:1})
    const match=expected[0]?.recommendations?.find(file=>file.sourcePath===chosen.sourcePath)
    assert.equal(chosen.packId,'quaternius-nature');assert.ok(match);assert.equal(match.sha256,chosen.sha256);assert.equal(match.solarPath,chosen.solarPath)
    const attempts=join(profile,'production/runs',runId,'attempts')
    assert.ok(readdirSync(attempts).some(file=>JSON.parse(readFileSync(join(attempts,file),'utf8')).toolsUsed?.includes('solar_asset_library')),'A real native asset tool call is required, not guessed metadata.')
    console.log('PASS: selected-provider model called the native mechanism recommendation tool and selected a real installed Godot preset with exact hashes; no project writes.')
    return
  }
  const result=await executeProductionAgent({runId,stageId:'0:planning',eventSeq:0,phase:'planning',repair:0,projectRevision:snapshot.revision!,approved:false,artifacts:{},task:{schemaVersion:1,runId,storyId:randomUUID(),taskRevision:1,projectRevision:snapshot.revision!,request:'Explain the role boundaries.',scope:'question',projectPath:project,criteria:[],keywords:[],tests:[],model,attachments:[]}}, 'planner', ['solar-bmad-planning'], 'This is a read-only adapter acceptance. After loading solar-bmad-planning, return exactly a JSON object with scope:"question" and answer containing one short English sentence describing BMAD planning. Do not implement or call another agent.', AbortSignal.timeout(300_000),[],[],{schema:productionOutputSchemas.planner})
  assert.equal((result as {scope:string}).scope,'question')
  assert.equal(typeof (result as {answer:string}).answer,'string')
  console.log('PASS: selected-provider OpenCode role execution, native BMAD skill load, bounded JSON response and encrypted credential compatibility.')
}).catch(error=>{console.error((error as Error).message);process.exitCode=1}).finally(async()=>{
  shutdownChat();await cancelProduction()
  await Promise.race([closeSceneEditor(),new Promise<void>(done=>setTimeout(done,20_000))])
  closeGodotGateway();win?.destroy();stopTestHarness()
  const target=resolve(scratch)
  if(dirname(target)!==resolve(tmpdir()) || !target.split(/[\\/]/).at(-1)?.startsWith('solar-model-check-')) throw new Error('Unsafe acceptance cleanup.')
  // Parent removes the encrypted profile copy after Chromium releases its locks.
  app.exit(Number(process.exitCode??0))
})
