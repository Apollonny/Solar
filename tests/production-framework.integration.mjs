import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const binary = resolve('vendor/orchestrator/win-x64/Solar.Orchestrator.exe')
const scratch = await mkdtemp(join(tmpdir(), 'solar-framework-check-'))
const phases = []
const events = []
let callback = async stage => {
  phases.push(stage.phase)
  return { status: 'ok', data: stage.phase === 'quality_review' ? { status: 'PASS' } : { stage: stage.phase } }
}
let proc, pending = new Map(), next = 0, buffer = ''
function launch() {
  proc = spawn(binary, [], { stdio: 'pipe', windowsHide: true })
  proc.stderr.resume()
  proc.stdout.on('data', bytes => {
    buffer += bytes.toString('utf8')
    let line
    while ((line = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0,line)); buffer = buffer.slice(line+1)
      if (msg.method === 'executor.invoke') {
        callback(msg.params).then(result => send({ jsonrpc: '2.0', id: msg.id, result }))
      } else if (msg.method) events.push({ method: msg.method, ...msg.params })
      else { const request = pending.get(msg.id); pending.delete(msg.id); if(msg.error)request?.reject(new Error(msg.error.message));else request?.resolve(msg.result) }
    }
  })
}
function send(msg) { proc.stdin.write(JSON.stringify(msg)+'\n') }
function call(method, params) { return new Promise((resolve,reject) => { const id='test-'+ ++next;pending.set(id,{resolve,reject});send({jsonrpc:'2.0',id,method,params}) }) }
async function until(predicate) { const deadline=Date.now()+15_000;while(!predicate()){if(Date.now()>deadline)throw new Error('Framework test timeout: '+JSON.stringify(events.slice(-4)));await new Promise(r=>setTimeout(r,20))} }
async function stop() { proc.kill(); await new Promise(r => proc.once('exit',r)); buffer=''; pending.clear() }
try {
  launch()
  const init=await call('initialize',{});assert.equal(init.framework,'Microsoft.Agents.AI.Workflows/1.22.0')
  const runId=randomUUID(); const base={runId,projectRevision:'a'.repeat(64),checkpointDirectory:join(scratch,'checkpoints'),task:{request:'contract fixture'}}
  await call('workflow.start',base)
  await until(()=>events.some(e=>e.kind==='finished'&&e.runId===runId))
  assert.equal(events.find(e=>e.kind==='finished'&&e.runId===runId).data.status,'complete')
  assert.deepEqual(phases,['planning','skills','tea_strategy','developing','applying','validating','runtime','tests','quality_review'])
  assert.ok(events.some(e=>e.kind==='checkpoint'))
  assert.ok((await readdir(join(scratch,'checkpoints'))).length)
  await stop()
  // Kill after a committed checkpoint; rehydrate a new Microsoft workflow instance.
  events.length=0;phases.length=0
  const second={...base,runId:randomUUID(),checkpointDirectory:join(scratch,'resume')}
  let hold
  callback=async stage=>{phases.push(stage.phase);if(stage.phase==='developing')return await new Promise(r=>hold=r);return {status:'ok',data:stage.phase==='quality_review'?{status:'PASS'}:{}}}
  launch();await call('initialize',{});await call('workflow.start',second)
  await until(()=>hold&&events.some(e=>e.kind==='checkpoint'))
  const checkpoint=events.filter(e=>e.kind==='checkpoint').at(-1).data
  await stop()
  callback=async stage=>({status:'ok',data:stage.phase==='quality_review'?{status:'PASS'}:{}})
  launch();await call('initialize',{});await call('workflow.resume',{...second,checkpoint,eventSeq:100})
  await until(()=>events.some(e=>e.kind==='finished'&&e.runId===second.runId))
  assert.equal(events.find(e=>e.kind==='finished'&&e.runId===second.runId).data.status,'complete')
  await stop()
  // Critical human approval is a real SDK RequestPort and stays revision-bound.
  events.length=0
  callback=async stage=> stage.phase==='applying'&&!stage.approved?{status:'approval_required',data:{}}:{status:'ok',data:stage.phase==='quality_review'?{status:'PASS'}:{}}
  const third={...base,runId:randomUUID(),checkpointDirectory:join(scratch,'approval')}
  launch();await call('initialize',{});await call('workflow.start',third)
  await until(()=>events.some(e=>e.kind==='approval_required'))
  assert.ok(!events.some(e=>e.kind==='finished'))
  await until(()=>events.some(e=>e.kind==='checkpoint'))
  const approvalCheckpoint=events.filter(e=>e.kind==='checkpoint').at(-1).data
  await stop();events.length=0
  launch();await call('initialize',{});await call('workflow.resume',{...third,checkpoint:approvalCheckpoint,eventSeq:200})
  await until(()=>events.some(e=>e.kind==='approval_required'))
  await assert.rejects(call('workflow.approve',{runId:third.runId,projectRevision:'b'.repeat(64),approved:true}))
  await call('workflow.approve',{runId:third.runId,projectRevision:third.projectRevision,approved:true})
  await until(()=>events.some(e=>e.kind==='finished'))
  assert.equal(events.find(e=>e.kind==='finished').data.status,'complete')
  await stop();events.length=0
  const declined={...base,runId:randomUUID(),checkpointDirectory:join(scratch,'declined')}
  launch();await call('initialize',{});await call('workflow.start',declined)
  await until(()=>events.some(e=>e.kind==='approval_required'))
  await call('workflow.approve',{runId:declined.runId,projectRevision:declined.projectRevision,approved:false})
  await until(()=>events.some(e=>e.kind==='finished'))
  assert.equal(events.find(e=>e.kind==='finished').data.status,'cancelled')
  await stop();events.length=0;phases.length=0
  let reads=0,maxReads=0
  callback=async stage=>{
    phases.push(stage.phase)
    if(['skills','tea_strategy'].includes(stage.phase)){reads++;maxReads=Math.max(reads,maxReads);await new Promise(r=>setTimeout(r,70));reads--}
    return {status:'ok',data:stage.phase==='quality_review'?{status:'FAIL'}:{}}
  }
  const repair={...base,runId:randomUUID(),checkpointDirectory:join(scratch,'repairs')}
  launch();await call('initialize',{});await call('workflow.start',repair)
  await until(()=>events.some(e=>e.kind==='finished'))
  assert.equal(events.find(e=>e.kind==='finished').data.status,'fail')
  assert.equal(phases.filter(p=>p==='developing').length,3,'Initial implementation plus exactly two repairs.')
  assert.equal(maxReads,2,'Only the two independent preparation reads fan out.')
  await stop();events.length=0;phases.length=0
  callback=async stage=>{phases.push(stage.phase);return {status:'transient',data:{reason:'fixture'}}}
  const retry={...base,runId:randomUUID(),checkpointDirectory:join(scratch,'retries')}
  launch();await call('initialize',{});await call('workflow.start',retry)
  await until(()=>events.some(e=>e.kind==='finished'))
  assert.equal(phases.length,3,'Temporary failure has at most three total attempts.')
  assert.equal(events.find(e=>e.kind==='finished').data.status,'transient')
  await stop();events.length=0;phases.length=0
  callback=async stage=>{phases.push(stage.phase);return new Promise(()=>{})}
  const cancel={...base,runId:randomUUID(),checkpointDirectory:join(scratch,'cancel')}
  launch();await call('initialize',{});await call('workflow.start',cancel)
  await until(()=>phases.length===1)
  await call('workflow.cancel',{runId:cancel.runId})
  await until(()=>events.some(e=>e.kind==='finished'))
  assert.equal(events.find(e=>e.kind==='finished').data.status,'cancelled')
  assert.equal(phases.length,1,'Stop must not dispatch a next stage.')
  console.log('PASS: Microsoft stage order, durable checkpoint/resume, revision-bound approval, two read tasks, bounded repairs/retries and Stop.')
} finally {
  if(proc?.exitCode===null) await stop()
  const checked=resolve(scratch);if(dirname(checked)!==resolve(tmpdir())||!checked.split(/[\\/]/).at(-1).startsWith('solar-framework-check-'))throw new Error('Unsafe test cleanup')
  await rm(checked,{recursive:true,force:true})
}
