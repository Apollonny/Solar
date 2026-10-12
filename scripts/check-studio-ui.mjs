import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
await build({entryPoints:[join(root,'tests/studio-ui.acceptance.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(root,'.test-dist/studio-ui.cjs'),packages:'external'})
const fixture=await mkdtemp(join(tmpdir(),'solar-studio-ui-')),home=join(fixture,'home')
await mkdir(join(home,'AppData/Roaming'),{recursive:true});await mkdir(join(home,'AppData/Local'),{recursive:true})
const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[join(root,'.test-dist/studio-ui.cjs')],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData/Roaming'),LOCALAPPDATA:join(home,'AppData/Local'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share'),XDG_CACHE_HOME:join(home,'.cache'),OPENCODE_CONFIG:join(home,'.config/opencode/opencode.json'),OPENCODE_CONFIG_DIR:join(home,'.config/opencode'),SOLAR_ACCEPTANCE_ROOT:root,SOLAR_ACCEPTANCE_DIR:fixture}})
const timer=setTimeout(()=>child.kill(),120_000)
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',value=>done(value??1))})
clearTimeout(timer);process.exitCode=code
const target=resolve(fixture)
if(dirname(target)!==resolve(tmpdir())||!target.split(/[\\/]/).at(-1)?.startsWith('solar-studio-ui-'))throw new Error('Unsafe Studio fixture cleanup.')
if(code===0)await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:300});else console.log('Studio UI diagnostics:',fixture)
