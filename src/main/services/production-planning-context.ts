import { validProjectPath } from '../../shared/production-gate'
import type { ProjectSnapshot } from './project-snapshot'
import {deriveTaskSelection,type TaskSelectionPolicy} from '../../shared/ai-task-selection'

/** Dimension checks use complete saved scene text, not the model's truncated excerpt. */
export function projectTaskSelection(snapshot:ProjectSnapshot,request:string,scope?:string):TaskSelectionPolicy {
  const facts=planningProjectContext(snapshot,request)
  // The model excerpt is bounded independently. Follow saved scene instances so
  // a UI entry scene cannot hide its nested 3D world behind the excerpt limit.
  const sources=new Map(facts.sources.map(source=>[source.path,{path:source.path,text:snapshot.files.get(source.path)?.text??source.text}]))
  const scenes=[...sources.keys()].filter(path=>path.endsWith('.tscn'))
  for(let index=0;index<scenes.length;index++) {
    for(const match of (sources.get(scenes[index])?.text??'').matchAll(/path="res:\/\/([^"\r\n]+\.tscn)"/g)) {
      const path=match[1],file=snapshot.files.get(path)
      if(sources.has(path)||!file?.text||!validProjectPath(path)||/^(addons|assets\/library|exports)\//i.test(path)||/(^|\/)\./.test(path))continue
      sources.set(path,{path,text:file.text});scenes.push(path)
    }
  }
  return deriveTaskSelection(request,[...sources.values()],scope)
}

/** Reuse bounded saved-project facts; the model need not rediscover installed addons. */
export function planningProjectContext(snapshot: ProjectSnapshot, request: string): { revision: string; sources: { path: string; hash: string; text: string; truncated: boolean }[]; files: string[]; omittedFiles: number } {
  if (!snapshot.complete || !snapshot.revision) throw new Error('Planning requires a complete project snapshot.')
  const product = [...snapshot.files].filter(([path]) => validProjectPath(path) && !/^(addons|assets\/library|exports)\//i.test(path) && !/(^|\/)\.|(^|\/)(credentials?|auth)(\.|\/)/i.test(path))
  const allowed = new Map(product), selected = new Set<string>()
  const add = (path: string): void => { if (selected.size < 6 && allowed.get(path)?.text !== undefined) selected.add(path) }
  add('project.godot')
  const entry = allowed.get('project.godot')?.text?.match(/^run\/main_scene\s*=\s*"res:\/\/([^"\r\n]+)"/m)?.[1]
  if (entry) add(entry)
  for (const [path] of product) if (request.toLowerCase().includes(path.toLowerCase()) || request.toLowerCase().includes(path.split('/').at(-1)!.toLowerCase())) add(path)
  if (entry) for (const match of (allowed.get(entry)?.text ?? '').matchAll(/path="res:\/\/([^"\r\n]+\.(?:gd|tscn|tres))"/g)) add(match[1])
  if (!entry) for (const [path] of product) if (path.endsWith('.tscn')) { add(path); break }
  let remaining = 32_000
  const sources = [...selected].map(path => {
    const file = allowed.get(path)!, size = Math.min(remaining,16_000), text = (file.text ?? '').slice(0,size)
    remaining -= text.length
    return { path, hash: file.hash, text, truncated: text.length !== file.text?.length }
  })
  return { revision: snapshot.revision, sources, files: product.slice(0,80).map(([path]) => path), omittedFiles: Math.max(0,product.length-80) }
}
