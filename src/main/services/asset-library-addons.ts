import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { getCurrentProject } from '../state'
import { sendToRenderer } from '../window'
import { ensureProjectDirectory } from './asset-store'
import { libraryAddonFiles } from './asset-library'
import { getGameState } from './game'
import { getEmbeddedEditorIdentity, getSceneEditorState } from './scene-editor'
import { writeAtomic } from './json-file'

let installing=false
/** Explicit UI action, bound to the displayed project. Never run from AI search. */
export async function installLibraryAddon(id:string,projectPath:string):Promise<string> {
  if(installing)throw new Error('An editor addon installation is already running.')
  installing=true
  let staging:string|null=null,addons:string|null=null
  const checkIdle=():void=>{
    if(getCurrentProject()?.path!==projectPath)throw new Error('The active project changed; the addon was not enabled.')
    if(getEmbeddedEditorIdentity()||getSceneEditorState().status==='opening'||getGameState().status!=='stopped')throw new Error('Save your work and close the 2D / 3D editor and running game before installing an editor addon.')
  }
  try {
    checkIdle()
    const source=await libraryAddonFiles(id),root=await realpath(projectPath)
    const config=join(root,'project.godot'),original=await readFile(config,'utf8'),plugin=`res://addons/${source.name}/plugin.cfg`
    const section=/(^\[editor_plugins\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m,match=original.match(section)
    let next=original
    if(match) {
      const entry=/^enabled\s*=\s*PackedStringArray\(([^\r\n]*)\)\s*$/m
      if(/^enabled\s*=/m.test(match[2])&&!entry.test(match[2]))throw new Error('Unsupported plugin settings; project.godot was preserved.')
      const values=match[2].match(entry)?.[1]
      if(!values?.includes(JSON.stringify(plugin))) {
        const body=values!==undefined?match[2].replace(entry,`enabled=PackedStringArray(${values.trim()}${values.trim()?', ':''}${JSON.stringify(plugin)})`):match[2]+`enabled=PackedStringArray(${JSON.stringify(plugin)})\n`
        next=original.replace(section,match[1]+body)
      }
    } else next+=`\n[editor_plugins]\nenabled=PackedStringArray(${JSON.stringify(plugin)})\n`
    addons=await ensureProjectDirectory(root,join(root,'addons'))
    const target=join(addons,source.name),existing=await lstat(target).catch(()=>null)
    if(existing) {
      if(existing.isSymbolicLink()||!existing.isDirectory())throw new Error('The existing addon was preserved.')
      const expected=new Map(source.files.filter(file=>!/\.(uid|import)$/.test(file.path)).map(file=>[file.path,createHash('sha256').update(file.bytes).digest('hex')]))
      const walk=async(part:string):Promise<void>=>{
        for(const item of await readdir(join(target,part),{withFileTypes:true})) {
          const path=part?part+'/'+item.name:item.name
          if(item.isSymbolicLink())throw new Error('The existing addon was preserved.')
          if(item.isDirectory())await walk(path)
          else if(!/\.(uid|import)$/.test(path)) {
            if(!item.isFile()||expected.get(path)!==createHash('sha256').update(await readFile(join(target,path))).digest('hex'))throw new Error('A different or edited Poly Haven addon exists; it was preserved.')
            expected.delete(path)
          }
        }
      }
      await walk('');if(expected.size)throw new Error('The existing addon is incomplete; it was preserved.')
    } else {
      staging=join(addons,'.solar-addon-'+randomUUID());await mkdir(staging)
      for(const file of source.files) {const path=join(staging,file.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,file.bytes,{flag:'wx'})}
      checkIdle()
      if(await readFile(config,'utf8')!==original)throw new Error('Project settings changed during installation.')
      if(await lstat(target).catch(()=>null))throw new Error('Another addon installation appeared; it was preserved.')
      await rename(staging,target)
    }
    checkIdle();if(next!==original)await writeAtomic(config,next,original)
    sendToRenderer('chat:files-changed')
    return `Poly Haven Import installed for this project (${source.revision.slice(0,12)}). Open the scene editor to use its Import tab.`
  } finally {
    if(staging&&addons) {
      const target=resolve(staging)
      if(dirname(target)!==resolve(addons)||!target.split(/[\\/]/).at(-1)?.startsWith('.solar-addon-'))throw new Error('Unsafe addon staging cleanup.')
      await rm(target,{recursive:true,force:true})
    }
    installing=false
  }
}
