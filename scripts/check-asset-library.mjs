import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
await build({entryPoints:[join(root,'tests/asset-library.integration.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(root,'.test-dist/asset-library-check.cjs'),packages:'external'})
const fixture=await mkdtemp(join(tmpdir(),'solar-library-check-')),home=join(fixture,'home')
await mkdir(home)
await mkdir(join(home,'.config'),{recursive:true});await mkdir(join(home,'.local/share'),{recursive:true});await mkdir(join(home,'.cache'),{recursive:true})
await mkdir(join(home,'AppData/Roaming'),{recursive:true});await mkdir(join(home,'AppData/Local'),{recursive:true})
const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),['--enable-logging',`--log-file=${join(fixture,'electron.log')}`,`--user-data-dir=${join(fixture,'chromium')}`,join(root,'.test-dist/asset-library-check.cjs')],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData/Roaming'),LOCALAPPDATA:join(home,'AppData/Local'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share'),XDG_CACHE_HOME:join(home,'.cache'),SOLAR_ASSET_LIBRARY_ROOT:join(process.env.APPDATA,'Solar/asset-library'),SOLAR_ACCEPTANCE_ROOT:root,SOLAR_ACCEPTANCE_DIR:fixture,SOLAR_LIBGODOT:process.argv.includes('--native')?'0':'1',...(process.argv.includes('--library-only')?{SOLAR_ACCEPTANCE_LIBRARY_ONLY:'1'}:{}),PYTHONDONTWRITEBYTECODE:'1',GODOT_AI_DISABLE_TELEMETRY:'true'}})
const timer=setTimeout(()=>{child.kill();process.exitCode=1},240_000)
child.once('error',error=>{clearTimeout(timer);throw error})
child.once('exit',async code=>{
  clearTimeout(timer);process.exitCode=code??1
  const target=resolve(fixture)
  if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1)?.startsWith('solar-library-check-'))throw new Error('Unsafe library acceptance cleanup.')
  if(code===0)await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:300})
  else console.log('Acceptance diagnostics:',fixture)
})
