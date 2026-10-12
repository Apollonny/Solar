/** Real renderer and IPC; workflow status fixtures exercise presentation only. */
import { app, BrowserWindow } from 'electron'
import { strict as assert } from 'node:assert'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setMainWindow, sendToRenderer } from '../src/main/window'
import { registerIpcHandlers } from '../src/main/ipc'
import { setCurrentProject, setProductionEnabled } from '../src/main/state'
import { inspectStudio } from '../src/main/services/studio-readiness'
import { prepareProductionProject } from '../src/main/services/production-addons'
import { digest } from '../src/main/services/production-store'
import type { ProductionState } from '../src/shared/production'

const root = process.env.SOLAR_ACCEPTANCE_ROOT!, fixture = process.env.SOLAR_ACCEPTANCE_DIR!
let win: BrowserWindow | null = null
app.getAppPath = () => root; app.on('window-all-closed', () => {})
void app.whenReady().then(async () => {
  const profile = join(fixture,'profile'), project = join(fixture,'project')
  await mkdir(profile); await mkdir(project); app.setPath('userData',profile)
  await writeFile(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Solar Studio"\n')
  setCurrentProject({name:'Solar Studio',path:project}); setProductionEnabled(true); registerIpcHandlers()
  assert.equal((await inspectStudio(project,false)).addons.status,'missing')
  await prepareProductionProject(project)
  const prepared = await readFile(join(project,'project.godot'))
  const readiness = await inspectStudio(project,true)
  assert.equal(readiness.addons.status,'ready'); assert.equal(readiness.ready,false)
  assert.equal(readiness.models.configured,false); assert.equal(readiness.editor.status,'closed')
  assert.equal(digest(await readFile(join(project,'project.godot'))),digest(prepared),'Readiness must not modify project settings')
  const gateway = join(project,'addons/godot_ai/plugin.cfg'), original = await readFile(gateway)
  await writeFile(gateway,Buffer.concat([original,Buffer.from('\n; user customization\n')]))
  assert.equal((await inspectStudio(project,false)).addons.status,'conflict')
  await assert.rejects(prepareProductionProject(project))
  assert.ok((await readFile(gateway)).toString().endsWith('; user customization\n'),'Preserve a user-modified addon')
  await writeFile(gateway,original)
  win = new BrowserWindow({width:1426,height:900,show:false,backgroundColor:'#08090e',webPreferences:{preload:join(root,'out/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
  setMainWindow(win); await win.loadFile(join(root,'out/renderer/index.html')); win.show()
  const evaluate = (expression: string): Promise<any> => win!.webContents.executeJavaScript(expression).catch(error => { throw new Error('UI expression failed: '+expression+' · '+error.message) })
  const wait = async (expression: string): Promise<void> => {
    for (let attempt=0; attempt<150; attempt++) { if (await evaluate(expression)) return; await new Promise(done => setTimeout(done,100)) }
    throw new Error('Studio UI did not reach its expected state: ' + expression)
  }
  const output = join(root,'.test-dist/acceptance'); await mkdir(output,{recursive:true})
  await wait('[...document.querySelectorAll(".studio-actions button")].find(button=>button.textContent==="Check connections")?.disabled===false')
  const capture = async (name: string): Promise<void> => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert.equal(await evaluate('(()=>{const panel=document.querySelector(".production-panel");return panel.scrollWidth>panel.clientWidth+1})()'),false,'Studio must fit the assistant width')
    assert.ok(await evaluate('(()=>{const input=document.querySelector(".chat-textarea");const rect=input.getBoundingClientRect();return rect.height>30 && rect.bottom<=innerHeight})()'),'Composer remains visible')
    await writeFile(join(output,name+'.png'),(await win!.capturePage()).toPNG())
  }
  await evaluate('[...document.querySelectorAll(".studio-actions button")].find(button=>button.textContent==="Check connections").click()')
  await wait('!document.querySelector(".studio-readiness").getAttribute("aria-busy") || document.querySelector(".studio-readiness").getAttribute("aria-busy")==="false"')
  await capture('studio-ready-desktop')
  win.setSize(1120,740); await new Promise(done => setTimeout(done,250))
  await capture('studio-ready-compact')
  const state: ProductionState = {schemaVersion:1,mode:'microsoft',runId:'00000000-0000-4000-8000-000000000001',projectPath:project,projectRevision:'a'.repeat(64),phase:'developing',status:'running',repair:0,eventSeq:1,startedAt:new Date().toISOString(),progress:{role:'developer',startedAt:new Date(Date.now()-125_000).toISOString(),firstResponse:true,toolsStarted:3,toolsFailed:0}}
  sendToRenderer('production:state',state)
  await wait('document.querySelector(".studio-run.running") && document.querySelector(".studio-elapsed")')
  await capture('studio-running-compact')
  sendToRenderer('production:state',{...state,projectPath:'another-project',phase:'quality_review',eventSeq:99})
  sendToRenderer('production:state',{...state,eventSeq:0,phase:'planning'})
  await new Promise(done => setTimeout(done,200))
  assert.equal(await evaluate('document.querySelector(".production-current strong").textContent'),'Developing','Ignore another project and out-of-order state')
  sendToRenderer('production:state',{...state,eventSeq:2,status:'blocked',message:'The model did not return a complete artifact. Check AI settings and resume saved work.',canResume:true})
  await wait('document.querySelector(".studio-run.blocked")')
  await capture('studio-blocked-compact')
  await evaluate('[...document.querySelectorAll(".studio-actions button")].find(button=>button.textContent==="AI settings").click()')
  await wait('document.querySelector(".setup-overlay") || document.querySelector(".setup-modal")')
  console.log('PASS: Actual Studio renderer/preload/IPC, project preparation, read-only readiness, preserved addon conflict, desktop/compact layouts, visible composer, progress and project/event filtering. No model generation.')
}).catch(error => { console.error(error); process.exitCode=1 }).finally(() => { win?.destroy(); app.exit(Number(process.exitCode??0)) })
