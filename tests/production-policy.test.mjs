import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { SolarGameSkills } from '../resources/solar-skills-plugin.mjs'
test('Managed roles deny delegation, writing, unselected skills and unrelated guides',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'solar-policy-check-'))
  try {
    const path=join(directory,'policy.json')
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'tea-gate',runId:'fixture',skills:['solar-godot-gdscript-mastery'],projectPath:directory,readPaths:[]}}}))
    process.env.SOLAR_EXECUTION_MODE='microsoft';process.env.SOLAR_EXECUTION_POLICY=path
    const hook=(await SolarGameSkills())['tool.execute.before']
    for(const tool of ['task','bash','write','edit','solar_game_play','solar_test_run'])await assert.rejects(hook({sessionID:'stage',tool},{args:{}}))
    await assert.rejects(hook({sessionID:'unknown',tool:'skill'},{args:{name:'solar-godot-gdscript-mastery'}}))
    await assert.rejects(hook({sessionID:'stage',tool:'skill'},{args:{name:'solar-studio-router'}}))
    await assert.rejects(hook({sessionID:'stage',tool:'solar_game_guidance'},{args:{action:'read',id:'studio-router'}}))
    await assert.rejects(hook({sessionID:'stage',tool:'solar_production_guidance'},{args:{action:'read',file:'bmad/workflows/example.md'}}))
    await hook({sessionID:'stage',tool:'skill'},{args:{name:'solar-godot-gdscript-mastery'}})
    await hook({sessionID:'stage',tool:'solar_game_guidance'},{args:{action:'search',query:'movement'}})
    await assert.rejects(hook({sessionID:'stage',tool:'solar_asset_library'},{args:{action:'search',query:'weapon'}}))
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'developer',runId:'fixture',skills:['solar-godot-gdscript-mastery'],projectPath:directory,readPaths:[]}}}))
    await hook({sessionID:'stage',tool:'solar_asset_library'},{args:{action:'inspect',packId:'styloo-weapons'}})
    await hook({sessionID:'stage',tool:'solar_asset_library'},{args:{action:'recommend',query:'weapon',mechanic:'combat',dimension:'3d'}})
    await assert.rejects(hook({sessionID:'stage',tool:'solar_asset_library'},{args:{action:'import',packId:'styloo-weapons',files:[]}}))
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'planner',runId:'fixture',skills:['solar-bmad-planning'],projectPath:directory,readPaths:[],toolAllowlist:['skill','solar_production_guidance','StructuredOutput']}}}))
    await hook({sessionID:'stage',tool:'skill'},{args:{name:'solar-bmad-planning'}})
    await hook({sessionID:'stage',tool:'StructuredOutput'},{args:{ok:true}})
    const guidance={args:{action:'search',query:'story',_solar_session:'forged-session'}}
    await hook({sessionID:'stage',tool:'solar_production_guidance'},guidance)
    assert.equal(guidance.args._solar_session,'stage','Transport scope is chosen by the hook, never the model.')
    await hook({sessionID:'stage',tool:'solar_production_guidance'},{args:{action:'read',file:'skills/solar-bmad-planning/SKILL.md'}})
    await assert.rejects(hook({sessionID:'stage',tool:'read'},{args:{filePath:path}}))
    await assert.rejects(hook({sessionID:'stage',tool:'solar_asset_library'},{args:{action:'recommend'}}))
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'tea-gate',runId:'fixture',skills:['solar-godot-gdscript-mastery'],projectPath:directory,readPaths:[]}}}))
    await hook({sessionID:'stage',tool:'read'},{args:{filePath:path}})
    const params=(await SolarGameSkills())['chat.params']
    const options={reasoning_budget:4096}, output={maxOutputTokens:65536,options}
    await params({sessionID:'stage',agent:'solar-production-tea-gate'},output)
    assert.equal(output.maxOutputTokens,8192)
    assert.deepEqual(output.options,{reasoning_budget:4096})
    const large={maxOutputTokens:65536,options:{thinking:{budget_tokens:32000}}}
    await params({sessionID:'stage',agent:'solar-production-tea-gate'},large)
    assert.equal(large.maxOutputTokens,34048)
    assert.equal(large.options.thinking.budget_tokens,32000)
    await assert.rejects(params({sessionID:'stage',agent:'title'},{maxOutputTokens:65536,options:{}}))
    await assert.rejects(params({sessionID:'stage',agent:'solar-production-tea-gate'},{maxOutputTokens:1024,options}))
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'vision-reviewer',runId:'fixture',skills:[],projectPath:directory,readPaths:[]}}}))
    const shortVision={maxOutputTokens:65536,options:{}}
    await params({sessionID:'stage',agent:'solar-production-vision-reviewer'},shortVision)
    assert.equal(shortVision.maxOutputTokens,1024)
  } finally {
    const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1).startsWith('solar-policy-check-'))throw new Error('Unsafe cleanup')
    await rm(target,{recursive:true,force:true}); delete process.env.SOLAR_EXECUTION_MODE
  }
})

test('Exact selected skill files are readable; injected cache files and project skill configs are denied',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'solar-policy-check-'))
  const previous={mode:process.env.SOLAR_EXECUTION_MODE,policy:process.env.SOLAR_EXECUTION_POLICY,native:process.env.SOLAR_NATIVE_SKILLS_PATH}
  try {
    const project=join(directory,'project'),cache=join(directory,'cache'),path=join(directory,'policy.json')
    const doc=join(cache,'solar-2d','SKILL.md'),injected=join(cache,'solar-2d','injected.md')
    await mkdir(join(cache,'solar-2d'),{recursive:true});await mkdir(join(project,'.opencode','skills'),{recursive:true})
    await writeFile(doc,'Selected body');await writeFile(injected,'Unverified injected content')
    const privateSkill=join(project,'.opencode','skills','SKILL.md');await writeFile(privateSkill,'Unselected project skill')
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'developer',skills:['solar-2d'],projectPath:project,readPaths:[doc]}}}))
    process.env.SOLAR_EXECUTION_MODE='microsoft';process.env.SOLAR_EXECUTION_POLICY=path;process.env.SOLAR_NATIVE_SKILLS_PATH=cache
    const hook=(await SolarGameSkills())['tool.execute.before']
    await hook({sessionID:'stage',tool:'read'},{args:{filePath:doc}})
    await assert.rejects(hook({sessionID:'stage',tool:'read'},{args:{filePath:injected}}))
    await assert.rejects(hook({sessionID:'stage',tool:'read'},{args:{filePath:privateSkill}}))
  } finally {
    for(const [key,value] of Object.entries({SOLAR_EXECUTION_MODE:previous.mode,SOLAR_EXECUTION_POLICY:previous.policy,SOLAR_NATIVE_SKILLS_PATH:previous.native}))if(value===undefined)delete process.env[key];else process.env[key]=value
    const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1).startsWith('solar-policy-check-'))throw new Error('Unsafe cleanup')
    await rm(target,{recursive:true,force:true})
  }
})
test('Managed prompts contain only assigned skill metadata while native skill bodies stay intact',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'solar-policy-check-'))
  try {
    const path=join(directory,'policy.json')
    await writeFile(path,JSON.stringify({schemaVersion:1,sessions:{stage:{role:'developer',runId:'fixture',skills:['solar-2d','solar-ecs'],projectPath:directory,readPaths:[]},empty:{role:'planner',runId:'fixture',skills:[],projectPath:directory,readPaths:[]}}}))
    process.env.SOLAR_EXECUTION_MODE='microsoft';process.env.SOLAR_EXECUTION_POLICY=path
    const hook=(await SolarGameSkills())['experimental.chat.system.transform']
    const entry=name=>`<skill><name>${name}</name><description>Reference for ${name}</description><location>/native/${name}/SKILL.md</location></skill>`
    const catalog='<available_skills>'+['solar-2d','solar-ecs','solar-studio-router',...Array.from({length:189},(_,index)=>`solar-unused-${index}`)].map(entry).join('\n')+'</available_skills>'
    const output={system:['Keep role and provider instructions.',catalog,'Load only the stage allowlist.']}
    const nativeSystem=output.system
    await hook({sessionID:'stage'},output)
    assert.equal(output.system,nativeSystem,'OpenCode retains the original system array; mutate it in place.')
    assert.equal(output.system[0],'Keep role and provider instructions.')
    assert.equal(output.system[2],'Load only the stage allowlist.')
    assert.ok(output.system[1].includes('/native/solar-2d/SKILL.md')&&output.system[1].includes('solar-ecs'))
    assert.ok(!output.system[1].includes('solar-unused')&&!output.system[1].includes('studio-router'))
    assert.ok(output.system[1].length<catalog.length/20)
    const empty={system:[catalog]};await hook({sessionID:'empty'},empty);assert.equal(empty.system[0],'<available_skills>\n\n</available_skills>')
    await assert.rejects(hook({sessionID:'stage'},{system:['No skills are currently available.']}))
    const legacy={system:[catalog]};delete process.env.SOLAR_EXECUTION_MODE;await hook({sessionID:'stage'},legacy);assert.equal(legacy.system[0],catalog)
  } finally {
    const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1).startsWith('solar-policy-check-'))throw new Error('Unsafe cleanup')
    await rm(target,{recursive:true,force:true});delete process.env.SOLAR_EXECUTION_MODE
  }
})
