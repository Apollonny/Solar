/** Actual installed sources and authenticated editor byte import; no model calls. */
import { app, BrowserWindow } from 'electron'
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setMainWindow } from '../src/main/window'
import { setCurrentProject } from '../src/main/state'
import { assetCatalog, libraryAddonFiles, listAssetLibrary, prepareLibraryImports, queryAssetLibrary, recommendAssetLibrary, readLibraryAsset } from '../src/main/services/asset-library'
import { installLibraryAddon } from '../src/main/services/asset-library-addons'
import { assetTarget, rankAssetPacks, safeLibraryPath } from '../src/shared/asset-library'
import { solarPresetPath } from '../src/main/services/asset-presets'
import { prepareProductionProject, lockedProductionAddons } from '../src/main/services/production-addons'
import { closeSceneEditor, getSceneEditorState, openSceneEditor, setSceneEditorBounds, setSceneEditorVisible } from '../src/main/services/scene-editor'
import { applyEditorChanges, closeGodotGateway, gatewayRead, observeRuntime, stableEditorSnapshot, startGodotGateway } from '../src/main/services/godot-execution'
import { validateChangeSet } from '../src/shared/production-changes'
import { validateProductionProject } from '../src/main/services/production-validation'
import { snapshotProject } from '../src/main/services/project-snapshot'
import { validateProject } from '../src/main/services/project-validation'
import type { AssetImport, LibraryFile } from '../src/shared/asset-library'
import type { TaskContract } from '../src/shared/production'

const root=process.env.SOLAR_ACCEPTANCE_ROOT!,fixture=process.env.SOLAR_ACCEPTANCE_DIR!
const backend=process.env.SOLAR_LIBGODOT==='1'?'libgodot':'executable'
const digest=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex')
let win:BrowserWindow|null=null
app.setName('Solar');app.getAppPath=()=>root;app.on('window-all-closed',()=>{})
void app.whenReady().then(async()=>{
  await mkdir(join(fixture,'profile'));app.setPath('userData',join(fixture,'profile'))
  const project=join(fixture,'project');await mkdir(project)
  const config='config_version=5\n[application]\nconfig/name="Solar asset acceptance"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'
  await writeFile(join(project,'project.godot'),config);await writeFile(join(project,'main.tscn'),'[gd_scene format=3]\n[node name="Main" type="Node2D"]\n')
  const catalog=await assetCatalog(),entries=await listAssetLibrary()
  assert.equal(catalog.length,14);assert.ok(entries.every(pack=>['ready','reference'].includes(pack.status)))
  assert.ok(!safeLibraryPath('../escape.png')&&!safeLibraryPath('CON.png')&&!safeLibraryPath('x\\bad.png'))
  assert.equal(rankAssetPacks(entries,{query:'orman ağacı 3d',kind:'environment'})[0].pack.id,'quaternius-nature')
  assert.ok(rankAssetPacks(entries,{query:'pixel character',dimension:'2d'}).every(match=>match.pack.dimension!=='3d'))
  await assert.rejects(queryAssetLibrary({query:'',offset:Number.NaN}),/Invalid library query/)
  const pick=async(id:string,query:string,predicate:(file:LibraryFile)=>boolean):Promise<LibraryFile>=>{
    const found=(await queryAssetLibrary({query,packId:id}))[0]?.files.find(predicate)
    assert.ok(found,'No concrete installed file matches '+id);return found
  }
  const sprite=await pick('mana-seed-character','character base',file=>/\.png$/i.test(file.path)&&file.purpose==='runtime'&&/0bas/.test(file.path))
  const mesh=await pick('quaternius-nature','rock',file=>/\.(glb|gltf)$/i.test(file.path))
  const effect=await pick('binbun-explosion-fx','ground',file=>/\.tscn$/i.test(file.path))
  const animation=await pick('quaternius-animation-1','animation',file=>/\.glb$/i.test(file.path))
  const imports:AssetImport[]=[{packId:'mana-seed-character',files:[{...sprite,preset:{kind:'sprite2d',frameWidth:64,frameHeight:64}}]},{packId:'quaternius-nature',files:[{...mesh,preset:{kind:'model3d',targetHeight:1.5,collision:'static'}}]},{packId:'binbun-explosion-fx',files:[{...effect,preset:{kind:'effect3d'}}]},{packId:'quaternius-animation-1',files:[{...animation,preset:{kind:'animation-library'}}]}]
  const recommendations=await recommendAssetLibrary({query:'forest rock',mechanic:'environment',dimension:'3d',style:'stylized'})
  assert.ok(recommendations.some(match=>match.pack.id==='quaternius-nature'&&match.recommendations?.some(file=>file.facts.bounds)))
  assert.ok(recommendations.every(match=>match.pack.dimension!=='2d'))
  await assert.rejects(prepareLibraryImports([{packId:'mana-seed-character',files:[sprite,{...sprite,sha256:'0'.repeat(64)}]}]),/version changed/)
  const prepared=await prepareLibraryImports(imports)
  assert.ok(prepared.some(file=>/\.gdshader$/.test(file.path))&&prepared.some(file=>/\.gd$/.test(file.path)),'Scene script/shader dependencies must be included.')
  assert.ok(prepared.filter(file=>/\.tscn$/.test(file.path)).every(file=>!file.bytes.toString().includes('uid="uid://')))
  assert.ok(prepared.filter(file=>/\.gd$/.test(file.path)).every(file=>file.bytes.toString().includes('#=== /solar ===')))
  assert.ok(prepared.length<40,'No full pack copies.')
  assert.ok((await readLibraryAsset('ludonauta-weapon-guide',(await queryAssetLibrary({query:'weapon',packId:'ludonauta-weapon-guide'}))[0].files[0].path)).includes('Weapon'))
  const addonProject=join(fixture,'addon-project');await mkdir(addonProject);await writeFile(join(addonProject,'project.godot'),config)
  setCurrentProject({name:'Addon fixture',path:addonProject})
  const addon=await libraryAddonFiles('polyhaven-import')
  await installLibraryAddon('polyhaven-import',addonProject);await installLibraryAddon('polyhaven-import',addonProject)
  const addonConfig=await readFile(join(addonProject,'project.godot'),'utf8')
  assert.equal(addonConfig.split('res://addons/PolyHavenImport/plugin.cfg').length,2)
  await writeFile(join(addonProject,'addons/PolyHavenImport/plugin.gd'),'# user edit\n')
  await assert.rejects(installLibraryAddon('polyhaven-import',addonProject),/preserved/)
  console.log('PASS: 14 sources, dimension filtering, exact hash checks, dependency rebasing and scoped addon preservation.')
  setCurrentProject({name:'Solar asset acceptance',path:project})
  await prepareProductionProject(project)
  if(process.env.SOLAR_ACCEPTANCE_LIBRARY_ONLY==='1') {
    const current=(await lockedProductionAddons()).find(group=>group.name==='godot_ai')!
    const prior=(await lockedProductionAddons(3)).find(group=>group.name==='godot_ai')!
    const changed=current.files.filter(file=>digest(file.data)!==digest(prior.files.find(old=>old.path===file.path)!.data))
    assert.ok(changed.length)
    for(const file of changed)await writeFile(join(project,'addons/godot_ai',file.path),prior.files.find(old=>old.path===file.path)!.data)
    await prepareProductionProject(project)
    for(const file of changed)assert.equal(digest(await readFile(join(project,'addons/godot_ai',file.path))),digest(file.data))
    const modified=join(project,'addons/godot_ai',changed[0].path);await writeFile(modified,'# user edit\n')
    await assert.rejects(prepareProductionProject(project),/changed/)
    assert.equal(await readFile(modified,'utf8'),'# user edit\n')
    await writeFile(modified,changed[0].data)
    const audio=await pick('ci-400-sounds','click',file=>/\.wav$/i.test(file.path))
    const shader=await pick('nojoule-pixel-shaders','pixel',file=>/\.gdshader$/i.test(file.path))
    const additional=await prepareLibraryImports([{packId:'ci-400-sounds',files:[{...audio,preset:{kind:'audio',volumeDb:-18,loop:false}}]},{packId:'nojoule-pixel-shaders',files:[{...shader,preset:{kind:'shader-material'}}]}])
    for(const file of [...prepared,...additional]){await mkdir(join(project,file.path,'..'),{recursive:true});await writeFile(join(project,file.path),file.bytes)}
    const revision=await snapshotProject(project)
    const task:TaskContract={schemaVersion:1,runId:randomUUID(),storyId:randomUUID(),taskRevision:1,projectRevision:revision.revision!,projectPath:project,request:'Audio, shader and owned overlay acceptance',scope:'feature',criteria:[],keywords:['assets'],tests:[],attachments:[],model:{providerID:'offline',modelID:'offline'}}
    const groups=await lockedProductionAddons()
    // No live editor is used by this fixture. Disable its owned gateway plugin
    // in the private project instead of falsely attesting runtime verification.
    await writeFile(join(project,'project.godot'),config)
    const validation=await validateProject(project,{runId:task.runId,taskRevision:1,dependencies:groups.map(group=>({directory:'addons/'+group.name,files:Object.fromEntries(group.files.map(file=>['addons/'+group.name+'/'+file.path,digest(file.data)]))}))})
    assert.equal(validation.status,'pass',JSON.stringify(validation).slice(-5000))
    console.log('PASS: exact earlier Solar overlay upgrades, user edits preserved, audio/shader/sprite/model/effect/animation presets parse in isolated Godot validation.')
    return
  }
  await startGodotGateway()
  win=new BrowserWindow({width:960,height:700,title:`Solar ${backend} asset acceptance`,backgroundColor:'#08090e',show:false});setMainWindow(win)
  await win.loadURL('data:text/html,<body style="background:%2308090e;color:white">Solar asset gateway acceptance</body>')
  win.show();setSceneEditorBounds({x:0,y:0,width:930,height:620});setSceneEditorVisible(true);await openSceneEditor(project)
  const state=getSceneEditorState();assert.equal(state.status,'ready');if(state.status==='ready')assert.equal(state.backend,backend)
  let available=false
  for(let attempts=0;attempts<80;attempts++) {
    try {const editor=await gatewayRead(project,'editor_state');assert.equal(editor.solar_compatibility,1);available=true;break}catch {await new Promise(done=>setTimeout(done,500))}
  }
  assert.ok(available,'The new gateway overlay must parse and connect.')
  const snapshot=await stableEditorSnapshot(project),signal=new AbortController().signal
  const spritePath=solarPresetPath('mana-seed-character',sprite.path,sprite.sha256,imports[0].files[0].preset!)
  const meshPath=solarPresetPath('quaternius-nature',mesh.path,mesh.sha256,imports[1].files[0].preset!)
  const effectPath=solarPresetPath('binbun-explosion-fx',effect.path,effect.sha256,imports[2].files[0].preset!)
  const scene2d=`[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://${spritePath}" id="1"]\n[node name="Main" type="Node2D"]\n[node name="Actor" parent="." instance=ExtResource("1")]\nposition=Vector2(400,260)\nscale=Vector2(4,4)\n`
  const scene3d=`[gd_scene load_steps=3 format=3]\n[ext_resource type="PackedScene" path="res://${meshPath}" id="1"]\n[ext_resource type="PackedScene" path="res://${effectPath}" id="2"]\n[node name="Main" type="Node3D"]\n[node name="Prop" parent="." instance=ExtResource("1")]\n[node name="Effect" parent="." instance=ExtResource("2")]\n[node name="Camera" type="Camera3D" parent="."]\nposition=Vector3(0,2,5)\nrotation=Vector3(-0.3,0,0)\ncurrent=true\n[node name="Light" type="DirectionalLight3D" parent="."]\nrotation=Vector3(-0.7,-0.5,0)\n`
  const change=validateChangeSet({schemaVersion:1,projectRevision:snapshot.revision,summary:'Actual partner 2D / 3D files and dependencies',assetImports:imports,files:[...prepared.map(file=>({path:file.path,expectedHash:null})),{path:'assets2d.tscn',expectedHash:null},{path:'assets3d.tscn',expectedHash:null}],commands:[{tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://assets2d.tscn',content:scene2d}}},{tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://assets3d.tscn',content:scene3d}}},{tool:'filesystem_manage',args:{op:'scan',params:{}}}]},snapshot.revision!,{runId:randomUUID(),storyId:randomUUID(),taskRevision:1,stageId:'0:applying',eventSeq:1})
  const applied=await applyEditorChanges(project,change,signal,async()=>{})
  assert.equal(applied.parseFailure,false)
  for(const file of prepared.filter(file=>!file.engineMetadata))assert.equal(digest(await readFile(join(project,file.path))),file.sha256,'Original binary or rebased dependency must remain intact.')
  const task:TaskContract={schemaVersion:1,runId:change.runId,storyId:change.storyId,taskRevision:1,projectRevision:applied.revision,projectPath:project,request:'Asset gateway acceptance',scope:'feature',criteria:[],keywords:['assets'],tests:[],attachments:[],model:{providerID:'offline',modelID:'offline'}}
  const validation=await validateProductionProject(task,signal)
  assert.equal(validation.status,'pass',JSON.stringify(validation).slice(-5000))
  const output=join(root,'.test-dist/acceptance');await mkdir(output,{recursive:true})
  const renders=[]
  for(const dimension of ['2d','3d']) {
    const current=await stableEditorSnapshot(project)
    const select=validateChangeSet({schemaVersion:1,projectRevision:current.revision,summary:'Select imported asset scene',files:[{path:'project.godot',expectedHash:current.files.get('project.godot')!.hash}],commands:[{tool:'project_manage',args:{op:'set_main_scene',params:{path:`res://assets${dimension}.tscn`}}}]},current.revision!,{runId:task.runId,storyId:task.storyId,taskRevision:1,stageId:'0:applying',eventSeq:1})
    await applyEditorChanges(project,select,signal,async()=>{})
    const observed=await observeRuntime(project,`library-${backend}-${dimension}`,[{tool:'game_manage',args:{op:'get_node_info',params:{path:dimension==='2d'?'/root/Main/Actor':'/root/Main/Prop'}}},{tool:'game_manage',args:{op:'input_sequence',params:{steps:[{at_frame:0,action:'ui_right',pressed:true},{at_frame:4,action:'ui_right',pressed:false}],settle_frames:2}}}],signal)
    assert.ok(observed.clean,JSON.stringify(observed.runtime).slice(-3000));assert.ok(observed.image.length>100)
    await writeFile(join(output,`asset-${backend}-${dimension}.png`),observed.image)
    renders.push({dimension,framebufferBytes:observed.image.length,clean:observed.clean})
  }
  const editorLog=await readFile(join(fixture,'profile/logs/godot-scene-editor.log'),'utf8')
  await writeFile(join(output,`asset-${backend}-editor.log`),editorLog)
  assert.ok(!/Unexpected window message|ERROR:|SCRIPT ERROR|Parse Error/.test(editorLog),'The complete editor log must remain clean, including startup and asset import.')
  await writeFile(join(output,`asset-${backend}.json`),JSON.stringify({backend,imports,recommendations,prepared:prepared.map(file=>({path:file.path,bytes:file.bytes.length,sha256:file.sha256,engineMetadata:file.engineMetadata??false})),validation:validation.status,renders,addonRevision:addon.revision},null,2))
  console.log(`PASS: ${backend} authenticated binary imports, whole-project validation and clean actual 2D / 3D framebuffers.`)
}).catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  try{await closeSceneEditor()}catch(error){console.error(error);process.exitCode=1}
  closeGodotGateway();win?.destroy();app.exit(Number(process.exitCode??0))
})
