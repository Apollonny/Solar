import { lstat, mkdir, readFile, readdir, realpath, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getEmbeddedEditorIdentity, getSceneEditorState } from './scene-editor'
import { digest, vendorDirectory, verifyVendor } from './production-store'
import { app } from 'electron'
import { writeAtomic } from './json-file'
import { inspectLockedDependency } from './validation-dependencies'
import type { StudioReadiness } from '../../shared/production'

async function contents(root: string): Promise<{ path: string; data: Buffer }[]> {
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The addon root is not a regular directory.')
  const files: { path: string; data: Buffer }[] = []
  const walk = async (part: string): Promise<void> => {
    for (const item of await readdir(join(root, part), { withFileTypes: true })) {
      const path = part ? `${part}/${item.name}` : item.name
      if (item.isSymbolicLink()) throw new Error('Addon links are unsupported.')
      if (item.isDirectory()) await walk(path)
      else if (item.isFile()) files.push({ path, data: await readFile(join(root, path)) })
    }
  }
  await walk(''); return files
}
let preparation: Promise<void> | null = null
function verifyAddon(name: string, existing: { path: string; data: Buffer }[], expected: { path: string; data: Buffer }[]): void {
  const directory = 'addons/' + name
  inspectLockedDependency({ revision: null, complete: true, issues: [], durationMs: 0, files: new Map(existing.map(file => [directory + '/' + file.path, { hash: digest(file.data), text: /\.(uid|import)$/.test(file.path) ? file.data.toString('utf8') : undefined }])) }, { directory, files: Object.fromEntries(expected.map(file => [directory + '/' + file.path, digest(file.data)])) })
}
/** A read-only check. Never install, enable or repair a user's addon here. */
export async function inspectProductionAddons(projectPath: string): Promise<StudioReadiness['addons']> {
  try {
    const root = await realpath(projectPath), config = await readFile(join(root,'project.godot'),'utf8')
    const parent = await lstat(join(root,'addons')).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!parent) return { status: 'missing', message: 'Prepare this project for scene operations and automated tests.' }
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The addons directory is not a regular project directory.')
    const groups = await lockedProductionAddons()
    for (const group of groups) {
      const target = join(root,'addons',group.name)
      if (!await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })) return { status: 'missing', message: 'The project gateway or test runner is missing. Prepare this project.' }
      verifyAddon(group.name, await contents(target), group.files)
    }
    const body = config.match(/^\[editor_plugins\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? ''
    if (!/^enabled\s*=\s*PackedStringArray\([^\r\n]*"res:\/\/addons\/godot_ai\/plugin.cfg"[^\r\n]*\)/m.test(body)) return { status: 'missing', message: 'The editor gateway is installed but disabled. Prepare this project to enable it.' }
    return { status: 'ready', message: 'Editor gateway and test runner are prepared.' }
  } catch (error) { return { status: 'conflict', message: 'Project preparation needs attention: ' + (error as Error).message.slice(0,500) } }
}
/** The exact app-owned project copies, including the narrowly scoped overlay. */
export async function lockedProductionAddons(compatibilityPatches?:number): Promise<{ name: string; files: { path: string; data: Buffer }[] }[]> {
  await verifyVendor('execution')
  const overlayPath = join(app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'resources/production-lock/godot-ai-overlay.json')
  const overlay = JSON.parse(await readFile(overlayPath, 'utf8')) as { patches: { path: string; before: string; after: string }[] }
  const ai = await contents(join(vendorDirectory('execution'), 'plugin/addons/godot_ai'))
  for (const patch of overlay.patches.slice(0,compatibilityPatches??overlay.patches.length)) {
    const file = ai.find(file => file.path === patch.path)
    if (!file || file.data.toString('utf8').split(patch.before).length !== 2) throw new Error('Compatibility overlay source mismatch.')
    file.data = Buffer.from(file.data.toString('utf8').replace(patch.before, patch.after))
  }
  return [{ name: 'godot_ai', files: ai }, { name: 'gdUnit4', files: await contents(join(vendorDirectory('execution'), 'gdunit4')) }]
}
/** User invokes this concrete installation while the editor is closed. Existing addons are never overwritten. */
export function prepareProductionProject(projectPath: string): Promise<void> {
  if (preparation) return Promise.reject(new Error('Project preparation is already running.'))
  preparation = prepare(projectPath).finally(() => { preparation = null })
  return preparation
}
async function prepare(projectPath: string): Promise<void> {
  if (getEmbeddedEditorIdentity() || getSceneEditorState().status === 'opening') throw new Error('Save your scenes and close the 2D / 3D editor before preparing the gateway.')
  const root = await realpath(projectPath)
  const configPath = join(root, 'project.godot'), original = await readFile(configPath, 'utf8')
  const groups = await lockedProductionAddons()
  const upgrades:{path:string;before:string;after:string}[]=[]
  // Preflight the entire install before creating any game files.
  const addons = join(root, 'addons')
  const parent = await lstat(addons).catch(() => null)
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error('The addons directory is not a regular project directory.')
  for (const group of groups) {
    const target = join(addons, group.name)
    if (await lstat(target).catch(() => null)) {
      const existing = await contents(target)
      try {verifyAddon(group.name,existing,group.files)}catch(error) {
        // Only complete, exact earlier Solar overlays qualify for an upgrade.
        // User-modified or independently installed addon sources still fail closed.
        let compatible=false
        if(group.name==='godot_ai')for(const count of [3,4]) {
          const prior=(await lockedProductionAddons(count)).find(item=>item.name===group.name)!
          try {verifyAddon(group.name,existing,prior.files);compatible=true;break}catch { /* another exact supported overlay */ }
        }
        if(!compatible)throw error
        for(const file of group.files) {
          const before=existing.find(item=>item.path===file.path)!
          if(digest(before.data)!==digest(file.data))upgrades.push({path:join(target,file.path),before:before.data.toString('utf8'),after:file.data.toString('utf8')})
        }
      }
    }
  }
  const plugin = 'res://addons/godot_ai/plugin.cfg'
  const section = /(^\[editor_plugins\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m
  let next: string
  const match = original.match(section)
  if (match) {
    const body = match[2], entry = /^enabled\s*=\s*PackedStringArray\(([^\r\n]*)\)\s*$/m
    if (/^enabled\s*=/m.test(body) && !entry.test(body)) throw new Error('Unsupported editor plugin configuration; it was left untouched.')
    const replacement = entry.test(body) ? body.replace(entry, (_all, values: string) => `enabled=PackedStringArray(${values.trim()}${values.trim() ? ', ' : ''}${JSON.stringify(plugin)})`) : body + `enabled=PackedStringArray(${JSON.stringify(plugin)})\n`
    next = original.replace(section, match[1] + replacement)
  } else next = original + `\n[editor_plugins]\nenabled=PackedStringArray(${JSON.stringify(plugin)})\n`
  if (match && /^enabled\s*=\s*PackedStringArray\([^\r\n]*"res:\/\/addons\/godot_ai\/plugin.cfg"[^\r\n]*\)/m.test(match[2])) next = original
  // Build complete directories before exposing either plugin to Godot. All
  // removals below are confined to this newly created, private staging folder.
  await mkdir(addons, { recursive: true })
  const staging = join(addons, '.solar-install-' + randomUUID())
  await mkdir(staging)
  try {
    for (const group of groups) {
      if (await lstat(join(addons, group.name)).catch(() => null)) continue
      for (const file of group.files) {
        const path = join(staging, group.name, file.path)
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.data, { flag: 'wx' })
      }
    }
    if (getEmbeddedEditorIdentity() || getSceneEditorState().status === 'opening') throw new Error('The editor opened during preparation. Close it before preparing the gateway.')
    if (await readFile(configPath, 'utf8') !== original) throw new Error('Project settings changed during preparation; no addons were installed.')
    for(const update of upgrades)if(await readFile(update.path,'utf8')!==update.before)throw new Error('Existing addon changed during preparation; it was preserved.')
    const applied:typeof upgrades=[]
    try {
      for(const update of upgrades) {await writeAtomic(update.path,update.after,update.before);applied.push(update)}
    } catch(error) {
      for(const update of applied.reverse())await writeAtomic(update.path,update.before,update.after).catch(()=>{})
      throw error
    }
    for (const group of groups) {
      const staged = join(staging, group.name)
      if (!await lstat(staged).catch(() => null)) continue
      if (await lstat(join(addons, group.name)).catch(() => null)) throw new Error('Another installation created an addon during preparation; it was preserved.')
      await rename(staged, join(addons, group.name))
    }
    if (next !== original) await writeAtomic(configPath, next, original)
  } finally {
    const target = resolve(staging), rel = relative(await realpath(addons), target)
    if (isAbsolute(rel) || rel.startsWith('..') || dirname(target) !== resolve(addons) || !rel.startsWith('.solar-install-')) throw new Error('Unsafe addon staging cleanup.')
    await rm(target, { recursive: true, force: true })
  }
}
