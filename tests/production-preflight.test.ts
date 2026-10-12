import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openRouterKeyQuota, productionModelBlockers, type ModelAccess } from '../src/shared/production-preflight'
const access=(image:boolean|null):ModelAccess=>({configured:true,model:'fixture',catalog:[{id:'fixture',supportsImageInput:image}],quota:{state:'unknown',remaining:null}})
test('Production preflight rejects missing credentials/models/vision and exhausted caps',()=>{
  assert.deepEqual(productionModelBlockers(access(false),access(true)),[])
  for(const image of [false,null])assert.ok(productionModelBlockers(access(false),access(image)).length>0)
  assert.ok(productionModelBlockers({...access(false),configured:false},access(true)).length>0)
  assert.ok(productionModelBlockers(access(false),{...access(true),catalog:[]}).length>0)
  assert.ok(productionModelBlockers(access(false),{...access(true),catalog:null}).length>0)
  assert.ok(productionModelBlockers({...access(false),quota:{state:'exhausted',remaining:0}},access(true)).length>0)
})
test('An unlimited/unknown key cap is not proof of account balance',()=>{
  assert.deepEqual(openRouterKeyQuota({data:{limit_remaining:null}}),{state:'unknown',remaining:null})
  assert.deepEqual(openRouterKeyQuota({data:{limit_remaining:0,label:'never retained'}}),{state:'exhausted',remaining:0})
  assert.deepEqual(openRouterKeyQuota({data:{limit_remaining:12}}),{state:'available',remaining:12})
  assert.deepEqual(openRouterKeyQuota({}),{state:'unknown',remaining:null})
})
