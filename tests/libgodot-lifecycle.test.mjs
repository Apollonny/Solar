import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/main/services/libgodot-host.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
const delay = ms => new Promise(done => setTimeout(done, ms))

for (const mode of ['graceful', 'failure']) test(`LibGodot ${mode} message cannot release the host before actual thread exit`, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'solar-libgodot-lifecycle-'))
  const profile = join(fixture, 'profile'), previousHelper = process.env.SOLAR_GODOT_HELPER_EXECUTABLE
  let session
  try {
    await mkdir(profile); await mkdir(join(fixture, 'resources'))
    await writeFile(join(fixture, 'resources/libgodot-worker.cjs'), `
      const {parentPort,workerData}=require('node:worker_threads');
      const {writeFileSync}=require('node:fs'); let stopping=false;
      function end() {
        if(stopping)return;stopping=true;
        writeFileSync(workerData.logPath,'native-ended');
        parentPort.postMessage(workerData.libraryPath==='failure'?{type:'error',message:'Synthetic native failure'}:{type:'exited'});
        setTimeout(()=>parentPort.close(),250);
      }
      if(workerData.libraryPath==='failure')end();
      else {parentPort.on('message',()=>end());parentPort.postMessage({type:'ready'});}
    `)
    // Real Node Worker; only Electron app paths and native code are replaced.
    const app = {isPackaged:false,getAppPath:()=>fixture,getPath:()=>profile}
    const module = {exports:{}}
    runInNewContext(bundle.outputFiles[0].text, {module,exports:module.exports,require:name=>name==='electron'?{app}:require(name),process,console,Buffer})
    session = module.exports.startLibGodotEditor({path:mode,sha256:'a'.repeat(64)},fixture,'mock-helper',join(fixture,'native-ended'),'0',{x:0,y:0,width:32,height:32},{x:0,y:0})
    let observedExit=false, callbacks=0
    session.exited.then(()=>{observedExit=true});session.onExit(()=>callbacks++)
    if(mode==='failure')await assert.rejects(session.ready,/Synthetic native failure/)
    else {await session.ready;session.forceStop()}
    const deadline=Date.now()+2000
    while(!await readFile(join(fixture,'native-ended')).catch(()=>null)) {
      assert.ok(Date.now()<deadline,'The worker must reach its native-ended boundary.')
      await delay(5)
    }
    await delay(20)
    assert.equal(observedExit,false,'Native-ended is not thread-ended.')
    assert.equal(callbacks,0)
    assert.ok(await readFile(join(profile,'libgodot-unfinished.json')))
    const error=await session.exited
    assert.equal(callbacks,1)
    if(mode==='failure')assert.match(error.message,/Synthetic native failure/)
    else {assert.equal(error,null);await assert.rejects(readFile(join(profile,'libgodot-unfinished.json')), {code:'ENOENT'})}
  } finally {
    session?.forceStop();await session?.exited
    if(previousHelper===undefined)delete process.env.SOLAR_GODOT_HELPER_EXECUTABLE
    else process.env.SOLAR_GODOT_HELPER_EXECUTABLE=previousHelper
    const target=resolve(fixture)
    if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1).startsWith('solar-libgodot-lifecycle-'))throw new Error('Unsafe lifecycle fixture cleanup.')
    await rm(target,{recursive:true,force:true})
  }
})
