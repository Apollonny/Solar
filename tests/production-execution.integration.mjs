import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const bundle=join(root,'vendor/execution/win-x64'),python=join(bundle,'python/python.exe'),godot=join(root,'vendor/godot/win32/godot.exe')
const scratch=await mkdtemp(join(tmpdir(),'solar-execution-check-'))
const environment={...process.env,PYTHONDONTWRITEBYTECODE:'1',GODOT_AI_DISABLE_TELEMETRY:'true',APPDATA:join(scratch,'user-data'),LOCALAPPDATA:join(scratch,'user-data')}
await mkdir(environment.APPDATA,{recursive:true})
let bridge,backend
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})})
async function command(binary,args,cwd=scratch){
  return await new Promise((done,reject)=>{const p=spawn(binary,args,{cwd,windowsHide:true,env:environment});let log='';const timer=setTimeout(()=>p.kill(),90_000);p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);done({code,log})})})
}
try {
  // Authenticated upstream attach runs entirely from the offline runtime.
  const port=await freePort(),ws=await freePort(),cap=randomBytes(32).toString('base64url')
  backend=spawn(python,['-m','godot_ai','--transport','streamable-http','--port',String(port),'--ws-port',String(ws),'--exclude-domains','testing','--owner-pid',String(process.pid)],{windowsHide:true,env:{...environment,GODOT_AI_HTTP_CAPABILITY:cap,GODOT_AI_WS_TOKEN:randomBytes(32).toString('hex')},stdio:'ignore'})
  let healthy=false
  for(let attempt=0;attempt<60;attempt++){
    try{const response=await fetch(`http://127.0.0.1:${port}/godot-ai/status`,{headers:{Authorization:'Bearer '+cap},signal:AbortSignal.timeout(1000)});if(response.ok){healthy=true;break}}catch{}
    await new Promise(r=>setTimeout(r,250))
  }
  assert.ok(healthy,'offline backend never published authenticated health')
  bridge=spawn(python,['-m','godot_ai','attach','--port',String(port),'--ws-port',String(ws),'--exclude-domains','testing','--disable-telemetry'],{windowsHide:true,env:environment,stdio:'pipe'})
  let buffer='',id=0;const pending=new Map();let stderr=''
  bridge.stderr.on('data',b=>stderr+=b)
  bridge.stdout.on('data',b=>{buffer+=b;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;const msg=JSON.parse(line);const request=pending.get(msg.id);if(request){pending.delete(msg.id);clearTimeout(request.timer);msg.error?request.reject(new Error(JSON.stringify(msg.error))):request.resolve(msg.result)}}})
  const call=(method,params)=>new Promise((resolve,reject)=>{const key='fixture-'+ ++id;const timer=setTimeout(()=>reject(new Error('Attach timeout: '+stderr.slice(-800))),40_000);pending.set(key,{resolve,reject,timer});bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n')})
  await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'solar-offline-contract-check',version:'1'}})
  bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
  const tools=await call('tools/list',{})
  assert.ok(tools.tools.some(t=>t.name==='editor_state'))
  assert.ok(!tools.tools.some(t=>t.name==='test_run'),'Godot AI must not own tests')
  const sessions=await call('tools/call',{name:'session_manage',arguments:{op:'list'}})
  assert.equal(sessions.isError??false,false)
  const sessionData=sessions.structuredContent??JSON.parse(sessions.content.find(c=>c.type==='text').text)
  assert.ok(Array.isArray(sessionData.sessions),'session identity contract')
  console.log('PASS: offline Godot AI authenticated attach, session contract and excluded test runner.')
  bridge.kill()
  // Real GdUnit4 scene tests, using an isolated project/import cache.
  const project=join(scratch,'project'),reports=join(scratch,'reports')
  await mkdir(join(project,'tests'),{recursive:true});await cp(join(bundle,'gdunit4'),join(project,'addons/gdUnit4'),{recursive:true})
  await writeFile(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Solar acceptance fixture"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
  await writeFile(join(project,'tests/scene_contract.gd'),`extends GdUnitTestSuite\nfunc test_2d_scene_input() -> void:\n\tvar actor: Node2D = auto_free(Node2D.new())\n\tadd_child(actor)\n\tInput.action_press("ui_right")\n\tawait get_tree().process_frame\n\tactor.position.x += Input.get_action_strength("ui_right") * 10.0\n\tInput.action_release("ui_right")\n\tassert_float(actor.position.x).is_equal(10.0)\nfunc test_3d_scene_state() -> void:\n\tvar actor: Node3D = auto_free(Node3D.new())\n\tadd_child(actor)\n\tactor.position = Vector3(1, 2, 3)\n\tawait get_tree().process_frame\n\tassert_vector(actor.global_position).is_equal(Vector3(1, 2, 3))\n`)
  const imported=await command(godot,['--headless','--path',project,'--editor','--import'],project)
  assert.equal(imported.code,0,imported.log.slice(-1600))
  const selectedFile=join(scratch,'selected.json'),discoveryFile=join(scratch,'discovery.json')
  await writeFile(selectedFile,JSON.stringify(['tests/scene_contract.gd']))
  const discovery=await command(godot,['--headless','--path',project,'--script',join(root,'resources/gdunit-discover.gd'),'--',selectedFile,discoveryFile],project)
  assert.equal(discovery.code,0,discovery.log.slice(-2500))
  const run=await command(godot,['--headless','--path',project,'--script','addons/gdUnit4/bin/GdUnitCmdTool.gd','--ignoreHeadlessMode','-a','res://tests/scene_contract.gd','-rd',reports],project)
  assert.equal(run.code,0,run.log.slice(-2500))
  const parsed=await command(python,[join(root,'resources/gdunit-report.py'),reports,discoveryFile])
  assert.equal(parsed.code,0,parsed.log)
  const result=JSON.parse(parsed.log)
  assert.equal(result.executed,2);assert.equal(result.failed,0);assert.equal(result.skipped,0)
  assert.equal(result.scopeMatched,true)
  const originalDiscovery=JSON.parse(await (await import('node:fs/promises')).readFile(discoveryFile,'utf8'))
  await writeFile(discoveryFile,JSON.stringify({...originalDiscovery,selected:[...originalDiscovery.selected,'tests/missing.gd']}))
  const missing=JSON.parse((await command(python,[join(root,'resources/gdunit-report.py'),reports,discoveryFile])).log)
  assert.equal(missing.scopeMatched,false,'A missing selected suite must never pass.')
  console.log('PASS: actual GdUnit4 2D input and 3D scene results, isolated import and original JUnit report.')
  await writeFile(join(project,'tests/broken.gd'),'extends GdUnitTestSuite\nfunc test_intentional_failure() -> void:\n\tassert_int(1).is_equal(2)\n')
  const failure=await command(godot,['--headless','--path',project,'--script','addons/gdUnit4/bin/GdUnitCmdTool.gd','--ignoreHeadlessMode','-a','res://tests/broken.gd','-rd',join(scratch,'broken-reports')],project)
  assert.notEqual(failure.code,0)
  const failed=JSON.parse((await command(python,[join(root,'resources/gdunit-report.py'),join(scratch,'broken-reports')])).log)
  assert.equal(failed.failed,1)
  console.log('PASS: deliberately broken GdUnit4 fixture reports failure and nonzero exit.')
} catch(error) { console.error(error); throw error }
finally {
  for(const child of [bridge,backend])if(child?.pid){
    await new Promise(done=>{const kill=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.on('error',done);kill.on('close',done)})
    child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy()
  }
  const target=resolve(scratch);if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1).startsWith('solar-execution-check-'))throw new Error('Unsafe test cleanup')
  await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:250})
}
