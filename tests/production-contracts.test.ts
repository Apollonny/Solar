import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { enforceQualityGate, validProjectPath } from '../src/shared/production-gate'
import { validateChangeSet } from '../src/shared/production-changes'
import type { EvidenceArtifact, GateReport, TaskContract, TestExecutionResult } from '../src/shared/production'
import { inspectLockedDependency } from '../src/main/services/validation-dependencies'
import { scopedExternalRead } from '../src/main/services/production-permissions'
import type { ProjectSnapshot } from '../src/main/services/project-snapshot'
const task: TaskContract = { schemaVersion:1,runId:'run',storyId:'story',taskRevision:1,projectRevision:'a'.repeat(64),request:'fixture',projectPath:'fixture',scope:'feature',criteria:[{id:'playable',description:'real playable feature',evidence:['validation','runtime','test','screenshot','interaction']}],keywords:['2d'],tests:['tests/playable.gd'],attachments:[],model:{providerID:'fixture',modelID:'fixture'} }
const evidence: EvidenceArtifact[] = (['validation','test','runtime','screenshot','interaction','vision'] as const).map(kind=>({schemaVersion:1,id:kind,runId:task.runId,storyId:task.storyId,taskRevision:1,projectRevision:task.projectRevision,stageId:'0:runtime',eventSeq:1,kind,origin:kind==='validation'?'solar-validator':kind==='test'?'gdunit4':kind==='vision'?'vision-reviewer':'godot-ai',file:kind,sha256:'b'.repeat(64),bytes:1,createdAt:new Date().toISOString(),complete:true}))
const report: GateReport = {schemaVersion:1,status:'PASS',reasons:[],checks:[{criterionId:'playable',passed:true,evidenceIds:evidence.map(e=>e.id)}]}
const tests: TestExecutionResult = {status:'pass',exitCode:0,selected:task.tests,discovered:1,executed:1,failed:0,skipped:0,report:'report.xml',truncated:false,scopeMatched:true}
const gate = (items=evidence,result=tests,integrity=true) => enforceQualityGate(task,report,items,result,'pass',integrity)
const identity={runId:task.runId,storyId:task.storyId,taskRevision:task.taskRevision,stageId:'0:developing',eventSeq:1}
test('Native external evidence reads accept exact parent /* and /** without expanding scope',()=>{
  const path='C:/Solar/profile/runs/evidence/runtime.json'
  assert.equal(scopedExternalRead(['C:/Solar/profile/runs/evidence/*'],[path]),true)
  assert.equal(scopedExternalRead(['C:/Solar/profile/runs/evidence/**'],[path]),true)
  assert.equal(scopedExternalRead(['C:/Solar/profile/runs/**'],[path]),false)
  assert.equal(scopedExternalRead(['C:/Solar/**/evidence/**'],[path]),false)
  assert.equal(scopedExternalRead(['C:/Solar/profile/runs/evidence/**','C:/private/**'],[path]),false)
  assert.equal(scopedExternalRead([],[path]),false)
})
test('Only intact current evidence with complete selected tests can PASS',()=>assert.equal(gate().status,'PASS'))
test('Zero tests, missing discovery, skipped required tests and bad exit cannot PASS',()=>{
  for(const result of [{...tests,discovered:0,executed:0},{...tests,discovered:2},{...tests,skipped:1},{...tests,exitCode:1},{...tests,selected:[]},{...tests,truncated:true},{...tests,scopeMatched:false}])assert.notEqual(gate(evidence,result).status,'PASS')
})
test('Stale, tampered, incomplete and unreviewed screenshots cannot PASS',()=>{
  assert.equal(gate(evidence.map(e=>({...e,projectRevision:'c'.repeat(64)}))).status,'STALE')
  assert.notEqual(gate(evidence,tests,false).status,'PASS')
  assert.notEqual(gate(evidence.map(e=>({...e,complete:false}))).status,'PASS')
  assert.notEqual(gate(evidence.filter(e=>e.kind!=='vision')).status,'PASS')
})
test('Changes forbid shell, nested batches, gateway session injection and unbound files',()=>{
  const change={schemaVersion:1,projectRevision:task.projectRevision,summary:'fixture',files:[{path:'main.gd',expectedHash:null}],commands:[{tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://main.gd',text:'extends Node'}}}]}
  assert.ok(validateChangeSet(change,task.projectRevision,identity))
  for(const commands of [[{tool:'test_run',args:{}}],[{tool:'batch_execute',args:{commands:[]}}],[{tool:'scene_save',args:{session_id:'foreign'}}],[{tool:'filesystem_manage',args:{op:'write_text',params:{path:'res://foreign.gd'}}}]])assert.throws(()=>validateChangeSet({...change,commands},task.projectRevision,identity))
  for(const path of ['../game.gd','C:/keys','addons/godot_ai/plugin.gd','.solar/run.json']) assert.throws(()=>validateChangeSet({...change,files:[{path,expectedHash:null}]},task.projectRevision,identity))
  for(const path of ['../game.gd','C:/keys','a/../b','.godot/cache'])assert.equal(validProjectPath(path),false)
})

test('Locked addon scopes allow only unchanged sources and their generated metadata',()=>{
  const path='addons/fixture/main.gd', hash='a'.repeat(64)
  const snapshot: ProjectSnapshot={complete:true,revision:'revision',issues:[],durationMs:0,files:new Map([[path,{hash,text:'extends Node'}],[path+'.uid',{hash:'b'.repeat(64),text:'uid://abcdef\n'}]])}
  const dependency={directory:'addons/fixture',files:{[path]:hash}}
  assert.equal(inspectLockedDependency(snapshot,dependency).summary.files,2)
  assert.throws(()=>inspectLockedDependency({...snapshot,files:new Map([[path,{hash:'c'.repeat(64)}]])},dependency))
  assert.throws(()=>inspectLockedDependency({...snapshot,files:new Map([...snapshot.files,['addons/fixture/foreign.gd',{hash}]])},dependency))
  assert.throws(()=>inspectLockedDependency({...snapshot,files:new Map([...snapshot.files,['addons/fixture/foreign.gd.uid',{hash,text:'uid://abc'}]])},dependency))
})
