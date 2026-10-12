import { app } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { nativeGameSkillDocuments } from './game-guidance'
import { writeAtomic } from './json-file'
import { readSkillFile, validSkillName, validSkillPath, type SkillSnapshot } from './skill-context'

export interface NativeSkillBundle extends SkillSnapshot {}
let prepared: Promise<NativeSkillBundle> | null = null
const hash = (contents: string): string => createHash('sha256').update(contents).digest('hex')

async function prepare(): Promise<NativeSkillBundle> {
  const documents = await nativeGameSkillDocuments()
  return prepareSkillSnapshot(documents, 'native-game-skills')
}

export async function prepareSkillSnapshot(documents: { names: string[]; files: { path: string; contents: string }[] }, namespace: 'native-game-skills' | 'native-production-skills'): Promise<NativeSkillBundle> {
  if (!documents.names.length || documents.names.length > 512 || documents.names.some(name => !validSkillName(name)) || new Set(documents.names).size !== documents.names.length || !documents.files.length || documents.files.length > 1024 || documents.files.some(file => !validSkillPath(file.path) || typeof file.contents !== 'string' || Buffer.byteLength(file.contents) > 1024 * 1024) || new Set(documents.files.map(file => file.path.toLowerCase())).size !== documents.files.length || documents.names.some(name => !documents.files.some(file => file.path === `${name}/SKILL.md`))) throw new Error('Invalid native skill snapshot documents.')
  const files = documents.files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.contents), sha256: hash(file.contents) }))
  const manifest = JSON.stringify({
    schemaVersion: 1, names: documents.names,
    files
  })
  const cache = join(app.getPath('userData'), namespace)
  await mkdir(cache, { recursive: true })
  if ((await lstat(cache)).isSymbolicLink()) throw new Error('Native skill cache cannot be linked.')
  const target = join(cache, hash(manifest))
  const verify = async (): Promise<void> => {
    if (await readSkillFile(target, 'manifest.json', Buffer.byteLength(manifest)) !== manifest) throw new Error('Solar native skill cache manifest is invalid.')
    for (const entry of documents.files) {
      if (hash(await readSkillFile(target, entry.path, Buffer.byteLength(entry.contents))) !== hash(entry.contents)) throw new Error('Solar native skill cache is modified or incomplete.')
    }
  }
  try {
    await lstat(target)
    await verify()
    return { path: target, names: [...documents.names], manifest, files }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const staging = await mkdtemp(join(cache, '.prepare-'))
  try {
    for (const file of documents.files) await writeAtomic(join(staging, ...file.path.split('/')), file.contents)
    await writeAtomic(join(staging, 'manifest.json'), manifest)
    try { await rename(staging, target) }
    catch (error) {
      // Concurrent Solar instances can prepare the same immutable snapshot.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    await verify()
    return { path: target, names: [...documents.names], manifest, files }
  } finally {
    const checked = resolve(staging)
    if (dirname(checked) !== resolve(cache) || !checked.split(/[\\/]/).at(-1)?.startsWith('.prepare-')) throw new Error('Unsafe native skill staging cleanup path.')
    await rm(checked, { recursive: true, force: true })
  }
}

/** Shared by projects within this app; no global or project skill installation. */
export function prepareNativeGameSkills(): Promise<NativeSkillBundle> {
  if (!prepared) prepared = prepare().catch((error) => { prepared = null; throw error })
  return prepared
}
