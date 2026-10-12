import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { controlledAgentConfig, effectiveExecutorPermission, productionRoles, productionRoleSteps, roleSolarReadTools, type ExecutorPermission } from '../src/main/services/production-role-config'

test('Managed tool exceptions survive native normalization and preserve role boundaries', () => {
  for (const role of productionRoles) {
    const config=controlledAgentConfig()[`solar-production-${role}`] as {tools?:unknown;steps:number;permission:Record<string,string>}
    assert.equal(config.steps,productionRoleSteps[role]);assert.ok(config.steps>=4&&config.steps<=24)
    assert.equal(config.tools,undefined,'Do not mix deprecated tools with ordered permissions')
    const rules:ExecutorPermission[]=Object.entries(config.permission).map(([permission,action])=>({permission,pattern:'*',action}))
    assert.equal(rules[0].permission,'*')
    for(const tool of roleSolarReadTools(role))assert.equal(effectiveExecutorPermission(tool,rules),'allow')
    assert.equal(effectiveExecutorPermission('StructuredOutput',rules),'allow')
    assert.equal(effectiveExecutorPermission('solar_asset_library',rules),role==='planner'||role==='developer'?'allow':'deny')
    for(const tool of ['task','question','bash','edit','write','apply_patch','solar_run_game_test','solar_game_control','solar_generate_image'])assert.equal(effectiveExecutorPermission(tool,rules),'deny')
  }
})

test('Permission diagnostics detect catch-all rules appended by deprecated tool normalization', () => {
  const rules:ExecutorPermission[]=[{permission:'solar*',pattern:'*',action:'deny'},{permission:'solar_asset_library',pattern:'*',action:'allow'},{permission:'*',pattern:'*',action:'deny'}]
  assert.equal(effectiveExecutorPermission('solar_asset_library',rules),'deny')
  assert.equal(effectiveExecutorPermission('skill',[...rules,{permission:'skill',pattern:'*',action:'allow'}]),'allow')
})
