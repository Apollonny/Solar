// Explicit maintainer acquisition: catalog-owned sources, independent cache,
// no personal browser/MCP configuration and no execution of downloaded code.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
await build({entryPoints:[join(root,'tests/asset-library.acquisition.ts')],outfile:join(root,'.test-dist/asset-library.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external'})
const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[join(root,'.test-dist/asset-library.cjs')],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,SOLAR_ACCEPTANCE_ROOT:root}})
process.exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1))})
