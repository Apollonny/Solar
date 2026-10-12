import { app, BrowserWindow } from 'electron'
import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setMainWindow } from '../src/main/window'
import { registerIpcHandlers } from '../src/main/ipc'
import { setAdvancedMode, setCurrentProject } from '../src/main/state'

const root=process.env.SOLAR_ACCEPTANCE_ROOT!,fixture=process.env.SOLAR_ACCEPTANCE_DIR!
let win:BrowserWindow|null=null
app.getAppPath=()=>root;app.on('window-all-closed',()=>{})
void app.whenReady().then(async()=>{
  const profile=join(fixture,'profile'),project=join(fixture,'project')
  await mkdir(profile);await mkdir(project);app.setPath('userData',profile)
  await writeFile(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Asset Library"\n')
  setCurrentProject({name:'Asset Library',path:project});setAdvancedMode(true);registerIpcHandlers()
  win=new BrowserWindow({width:1380,height:880,backgroundColor:'#08090e',show:false,webPreferences:{preload:join(root,'out/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
  setMainWindow(win);await win.loadFile(join(root,'out/renderer/index.html'));win.show()
  const evaluate=(expression:string):Promise<unknown>=>win!.webContents.executeJavaScript(expression)
  const wait=async(expression:string):Promise<void>=>{
    for(let attempt=0;attempt<80;attempt++) {if(await evaluate(expression))return;await new Promise(done=>setTimeout(done,100))}
    throw new Error('UI did not reach its expected state: '+expression)
  }
  await wait('document.querySelectorAll(".workspace .tab").length===3')
  await evaluate('[...document.querySelectorAll(".workspace .tab")].find(button=>button.textContent.trim()==="Files").click()')
  await wait('document.querySelector(".asset-library-nav")')
  await evaluate('[...document.querySelectorAll(".asset-library-nav button")].find(button=>button.textContent==="Asset library").click()')
  await wait('document.querySelectorAll(".asset-library-row").length===14')
  await evaluate('[...document.querySelectorAll(".asset-library-row")].find(button=>button.textContent.includes("Universal Animation Library")).click()')
  await wait('document.querySelectorAll(".asset-library-file-list li").length>0')
  const output=join(root,'.test-dist/acceptance');await mkdir(output,{recursive:true})
  await writeFile(join(output,'asset-library-ui.png'),(await win.capturePage()).toPNG())
  const overflow=await evaluate('(()=>{const pane=document.querySelector(".asset-library").getBoundingClientRect();return [...document.querySelectorAll(".asset-library-row,.asset-library-filters")].some(el=>el.getBoundingClientRect().right>pane.right+1)})()')
  assert.equal(overflow,false,'Rows/controls must fit the existing compact sidebar.')
  await evaluate('(()=>{const select=document.querySelector(".asset-library-filters select");select.value="2d";select.dispatchEvent(new Event("change",{bubbles:true}))})()')
  await wait('document.querySelectorAll(".asset-library-row").length===6')
  await evaluate('[...document.querySelectorAll(".asset-library-row")].find(button=>button.textContent.includes("Mana Seed")).click()')
  await wait('document.querySelector(".asset-library-detail .btn-primary")')
  await evaluate('[...document.querySelectorAll(".asset-library-detail button")].find(button=>button.textContent==="Use in chat").click()')
  await wait('document.querySelector(".chat-textarea")?.value.includes("mana-seed-character")')
  assert.equal(await evaluate('document.querySelector(".workspace .tab.active").textContent.trim()'),'Chat')
  console.log('PASS: Actual preload/IPC library UI, 14 cached sources, compact layout, 2D filter and project-bound draft handoff without sending.')
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{win?.destroy();app.exit(Number(process.exitCode??0))})
