/** Real embedded-editor acceptance; no API calls and no user project edits. */
import { app, BrowserWindow } from 'electron'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setMainWindow } from '../src/main/window'
import { setCurrentProject } from '../src/main/state'
import { prepareProductionProject } from '../src/main/services/production-addons'
import { closeSceneEditor, getSceneEditorState, openSceneEditor, setSceneEditorBounds, setSceneEditorVisible } from '../src/main/services/scene-editor'
import { applyEditorChanges, closeGodotGateway, gatewayRead, gatewayTools, observeRuntime, stableEditorSnapshot, startGodotGateway } from '../src/main/services/godot-execution'
import { validateChangeSet } from '../src/shared/production-changes'
import { validateProductionProject } from '../src/main/services/production-validation'
import { runProductionTests } from '../src/main/services/production-tests'
import { evidenceIntegrity } from '../src/main/services/production-store'
import type { TaskContract } from '../src/shared/production'

const root = process.env.SOLAR_ACCEPTANCE_ROOT!
const expected = process.env.SOLAR_LIBGODOT === '1' ? 'libgodot' : 'executable'
let fixture = '', win: BrowserWindow | null = null
// Only the test harness supplies app paths. Actual embedding, addon, transport,
// session/PID verification and engine services are the production modules.
app.getAppPath = () => root
app.on('window-all-closed', () => {})
void app.whenReady().then(async () => {
  fixture = process.env.SOLAR_ACCEPTANCE_DIR ?? await mkdtemp(join(tmpdir(), 'solar-embedded-check-'))
  const profile = join(fixture, 'profile'), project = join(fixture, 'project')
  await mkdir(profile); await mkdir(project)
  app.setPath('userData', profile)
  await writeFile(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Solar gateway acceptance"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
  await writeFile(join(project, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n')
  setCurrentProject({ name: 'Solar gateway acceptance', path: project })
  await prepareProductionProject(project)
  await startGodotGateway()
  win = new BrowserWindow({ width: 960, height: 700, title: `Solar ${expected} gateway acceptance`, backgroundColor: '#08090e', show: false })
  setMainWindow(win)
  await win.loadURL('data:text/html,<body style="background:%2308090e;color:white;font:16px sans-serif">Solar editor gateway acceptance</body>')
  win.show(); setSceneEditorBounds({ x: 0, y: 0, width: 930, height: 620 }); setSceneEditorVisible(true)
  await openSceneEditor(project)
  const state = getSceneEditorState()
  assert.equal(state.status, 'ready')
  if (state.status === 'ready') assert.equal(state.backend, expected, 'A fallback backend cannot satisfy this acceptance.')
  let live: Record<string, unknown> | null = null
  const deadline = Date.now() + 50_000
  while (Date.now() < deadline) {
    try { live = await gatewayRead(project, 'editor_state'); break } catch { await new Promise(done => setTimeout(done, 500)) }
  }
  assert.ok(live, 'Embedded Godot AI session did not become available.')
  assert.equal(live.solar_compatibility, 1)
  assert.deepEqual(live.solar_unsaved_scenes, [])
  assert.deepEqual(live.solar_unsaved_scripts, [])
  const tools = await gatewayTools(project)
  assert.ok(tools.length > 5)
  console.log(`PASS: ${expected} child-window editor, authenticated exact project/PID session and unsaved-scene overlay.`)
  const controller = new AbortController()
  for (const dimension of ['2d','3d']) {
    const snapshot = await stableEditorSnapshot(project)
    assert.ok(snapshot.complete && snapshot.revision)
    const script = `extends Node${dimension.toUpperCase()}\nfunc _process(delta: float) -> void:\n\tposition.x += Input.get_action_strength("ui_right") * 100.0 * delta\n`
    const testPath = `tests/playable${dimension}.gd`
    const testSource = `extends GdUnitTestSuite\nfunc test_scene_input_moves_actor() -> void:\n\tvar scene: PackedScene = load("res://main${dimension}.tscn")\n\tvar game = auto_free(scene.instantiate())\n\tadd_child(game)\n\tvar actor = game.get_node("Actor")\n\tvar before: float = actor.position.x\n\tInput.action_press("ui_right")\n\tactor._process(0.1)\n\tInput.action_release("ui_right")\n\tassert_float(actor.position.x).is_greater(before)\n`
    const scene = dimension === '2d'
      ? '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://move2d.gd" id="1"]\n[node name="Main" type="Node2D"]\n[node name="Actor" type="Polygon2D" parent="."]\nposition=Vector2(220,220)\npolygon=PackedVector2Array(0,0,64,0,64,64,0,64)\ncolor=Color(1,0.35,0.5,1)\nscript=ExtResource("1")\n'
      : '[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://move3d.gd" id="1"]\n[sub_resource type="BoxMesh" id="Box"]\n[node name="Main" type="Node3D"]\n[node name="Actor" type="MeshInstance3D" parent="."]\nmesh=SubResource("Box")\nscript=ExtResource("1")\n[node name="Camera" type="Camera3D" parent="."]\nposition=Vector3(0,0,4)\ncurrent=true\n'
    const change = validateChangeSet({ schemaVersion:1, projectRevision:snapshot.revision, summary:`${dimension} input fixture`, files:[{path:`move${dimension}.gd`,expectedHash:null},{path:`main${dimension}.tscn`,expectedHash:null},{path:testPath,expectedHash:null},{path:'project.godot',expectedHash:snapshot.files.get('project.godot')!.hash}], commands:[
      {tool:'script_create',args:{path:`res://move${dimension}.gd`,content:script}},
      {tool:'filesystem_manage',args:{op:'write_text',params:{path:`res://main${dimension}.tscn`,content:scene}}},
      {tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://' + testPath,content:testSource}}},
      {tool:'filesystem_manage',args:{op:'scan',params:{}}},
      {tool:'scene_open',args:{path:`res://main${dimension}.tscn`}},
      {tool:'project_manage',args:{op:'set_main_scene',params:{path:`res://main${dimension}.tscn`}}}
    ]}, snapshot.revision!, { runId: randomUUID(), storyId: randomUUID(), taskRevision: 1, stageId: '0:developing', eventSeq: 1 })
    const applied = await applyEditorChanges(project,change,controller.signal,async () => {})
    const task: TaskContract = { schemaVersion:1, runId:change.runId, storyId:change.storyId, taskRevision:1, projectRevision:applied.revision, projectPath:project, request:'Offline playable fixture', scope:'feature', criteria:[], keywords:[dimension], tests:[testPath], attachments:[], model:{providerID:'offline-fixture',modelID:'offline-fixture'} }
    const validated = await validateProductionProject(task, controller.signal)
    assert.equal(validated.status,'pass',JSON.stringify(validated).slice(-5000))
    assert.equal(validated.scope.dependencies?.length,2)
    assert.ok(validated.scope.files.every(path => !path.startsWith('addons/')))
    console.log(`PASS: ${expected} ${dimension} saved-project validation with hash-locked addons and whole-project import.`)
    const observed = await observeRuntime(project,`fixture-${dimension}`,[{tool:'game_manage',args:{op:'get_node_info',params:{path:'/root/Main/Actor'}}},{tool:'game_manage',args:{op:'input_sequence',params:{steps:[{at_frame:0,action:'ui_right',pressed:true},{at_frame:20,action:'ui_right',pressed:false}],settle_frames:2}}},{tool:'game_manage',args:{op:'get_node_info',params:{path:'/root/Main/Actor'}}}],controller.signal)
    assert.ok(observed.image.length>100)
    assert.equal(observed.clean,true,JSON.stringify(observed.runtime).slice(-3000))
    const interaction = observed.interaction as { inputs: unknown[] }
    assert.notEqual(JSON.stringify(interaction.inputs[0]),JSON.stringify(interaction.inputs[2]),'Input must cause an observed actor state change.')
    console.log(`PASS: ${expected} ${dimension} ChangeSet, actual input/state change, original framebuffer and clean run logs.`)
    const tested = await runProductionTests(task,controller.signal,false,0)
    assert.equal(tested.result.status,'pass',JSON.stringify(await readFile(tested.artifact.file,'utf8')).slice(-6000))
    assert.equal(tested.result.executed,1)
    assert.equal(tested.result.scopeMatched,true)
    assert.equal(await evidenceIntegrity(task.runId,[tested.artifact]),true)
    console.log(`PASS: ${expected} ${dimension} production test adapter, real discovery/execution and original intact evidence.`)
  }
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  try { await closeSceneEditor() } catch (error) { console.error(error); process.exitCode = 1 }
  closeGodotGateway(); win?.destroy()
  if (fixture) {
    const target = resolve(fixture)
    if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1)?.startsWith('solar-embedded-check-')) throw new Error('Unsafe test cleanup.')
    // Preserve logs on failure; they are needed to diagnose genuine backend limitations.
    // The parent removes this profile after Electron exits and releases LOCK.
    if (process.exitCode) console.log('Acceptance diagnostic directory:', fixture)
  }
  app.exit(Number(process.exitCode ?? 0))
})
