import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { productionOutputSchemas, validateProductionOutput } from '../src/shared/production-output'

test('Structured role outputs are bounded, typed and reject hidden extras', () => {
  validateProductionOutput({scope:'question',answer:'BMAD prepares the story.'},productionOutputSchemas.planner)
  assert.throws(() => validateProductionOutput({scope:'question',answer:42},productionOutputSchemas.planner))
  assert.throws(() => validateProductionOutput({scope:'feature',story:'Plan',shell:'execute'},productionOutputSchemas.planner))
  assert.throws(() => validateProductionOutput({passed:'true',observations:'Visible',criterionIds:['playable']},productionOutputSchemas['vision-reviewer']))
  assert.throws(() => validateProductionOutput({passed:true,observations:'Visible',criterionIds:[]},productionOutputSchemas['vision-reviewer']))
  assert.throws(() => validateProductionOutput({scope:'question',answer:'x'.repeat(1024*1024)},productionOutputSchemas.planner))
})
test('ChangeSet output admits native args but retains exact revision and file hashes', () => {
  const change = { changeSet:{schemaVersion:1,projectRevision:'a'.repeat(64),summary:'Move actor',files:[{path:'move.gd',expectedHash:null}],commands:[{tool:'script_create',args:{source:'extends Node2D'}}]},scenario:[{tool:'game_manage',args:{op:'start'}}] }
  validateProductionOutput(change,productionOutputSchemas.developer)
  assert.throws(() => validateProductionOutput({...change,changeSet:{...change.changeSet,projectRevision:'unknown'}},productionOutputSchemas.developer))
  assert.throws(() => validateProductionOutput({...change,changeSet:{...change.changeSet,files:[{path:'move.gd',expectedHash:0}]}},productionOutputSchemas.developer))
  assert.throws(() => validateProductionOutput({...change,scenario:[]},productionOutputSchemas.developer))
})
test('TEA output requires a real verdict and typed evidence links', () => {
  const gate = {schemaVersion:1,status:'BLOCKED',reasons:['No screenshot'],checks:[{criterionId:'playable',passed:false,evidenceIds:[]}]}
  validateProductionOutput(gate,productionOutputSchemas['tea-gate'])
  assert.throws(() => validateProductionOutput({...gate,status:'CONCERNS'},productionOutputSchemas['tea-gate']))
  assert.throws(() => validateProductionOutput({...gate,checks:[{criterionId:'playable',passed:true,evidenceIds:[7]}]},productionOutputSchemas['tea-gate']))
})
