import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
await build({entryPoints:[join(root,'tests/production-embedded.integration.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(root,'.test-dist/production-embedded.cjs'),packages:'external'})
const mode=process.argv.includes('--libgodot')?'1':'0'
const fixture=await mkdtemp(join(tmpdir(),'solar-embedded-check-'))
const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[join(root,'.test-dist/production-embedded.cjs')],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,SOLAR_ACCEPTANCE_ROOT:root,SOLAR_ACCEPTANCE_DIR:fixture,SOLAR_LIBGODOT:mode,PYTHONDONTWRITEBYTECODE:'1',GODOT_AI_DISABLE_TELEMETRY:'true'}})
const timer=setTimeout(()=>{child.kill();process.exitCode=1},240_000)
child.on('error',error=>{clearTimeout(timer);throw error})
child.on('exit',async code=>{
  clearTimeout(timer);process.exitCode=code??1
  const target=resolve(fixture)
  if(dirname(target)!==resolve(tmpdir()) || !target.split(/[\\/]/).at(-1).startsWith('solar-embedded-check-'))throw new Error('Unsafe test cleanup.')
  if(code===0)await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:300})
  else console.log('Acceptance diagnostics:',fixture)
})
