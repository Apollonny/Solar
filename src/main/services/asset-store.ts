import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { decodeCredentialJson, encryptCredentialJson, hasStrongEncryptionBackend } from './credential-vault'
import { writeAtomic } from './json-file'

/**
 * Shared pieces of the asset-generation services (hy3d.ts, gptimage.ts):
 * where generated assets land inside a project, and how provider credentials
 * are stored. New credentials are encrypted with the OS credential backend;
 * legacy plaintext files are migrated when a strong backend is available.
 */

export const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function relativeProjectPath(projectPath: string, targetPath: string): string {
  const root = resolve(projectPath)
  const target = resolve(targetPath)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Asset paths must stay inside the project.')
  }
  return rel
}

/** Reject existing symlink components before an asset request is sent. */
export async function validateProjectDirectory(projectPath: string, targetPath: string): Promise<void> {
  const root = await realpath(projectPath)
  const rel = relativeProjectPath(projectPath, targetPath)
  let current = root

  for (const part of rel.split(sep)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return
      throw err
    }
    if (info.isSymbolicLink()) throw new Error('Asset paths cannot pass through a symbolic link.')
    if (!info.isDirectory()) throw new Error('An asset output path component is not a directory.')
    current = await realpath(current)
    if (!isWithin(root, current)) throw new Error('Asset paths must stay inside the project.')
  }
}

/** Create an asset directory one component at a time, rejecting symlinks. */
export async function ensureProjectDirectory(projectPath: string, targetPath: string): Promise<string> {
  const root = await realpath(projectPath)
  const rel = relativeProjectPath(projectPath, targetPath)
  let current = root

  for (const part of rel.split(sep)) {
    const next = join(current, part)
    try {
      await mkdir(next)
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST')) throw err
    }
    const info = await lstat(next)
    if (info.isSymbolicLink()) throw new Error('Asset paths cannot pass through a symbolic link.')
    if (!info.isDirectory()) throw new Error('An asset output path component is not a directory.')
    current = await realpath(next)
    if (!isWithin(root, current)) throw new Error('Asset paths must stay inside the project.')
  }

  return current
}

/** Atomically replace a generated asset so an existing symlink is never followed. */
export async function writeAssetFile(directory: string, fileName: string, contents: Buffer): Promise<void> {
  if (!fileName || basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    throw new Error('Generated asset filenames must be a single path component.')
  }
  const directoryInfo = await lstat(directory)
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error('Generated assets must be written to a real project directory.')
  }
  const target = join(directory, fileName)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, contents, { flag: 'wx' })
    await rename(temporary, target)
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => {})
    throw err
  }
}

/** Resolve a project-relative regular file without following symlinks. */
export async function resolveProjectFile(projectPath: string, projectRelativePath: string): Promise<string> {
  const root = await realpath(projectPath)
  const target = resolve(projectPath, projectRelativePath)
  const rel = relativeProjectPath(projectPath, target)
  let current = root
  let info
  const parts = rel.split(sep)

  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('Project file paths cannot pass through a symbolic link.')
    current = await realpath(current)
    if (!isWithin(root, current)) throw new Error('Project file paths must stay inside the project.')
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error('A project file path component is not a directory.')
    }
  }

  if (!info?.isFile()) throw new Error('image_path must point to a regular file inside the project.')
  return current
}

/**
 * Resolve `assets/<folder>/<name>` inside the project, refusing anything that
 * escapes it (the folder comes from the model — treat it as untrusted).
 * Leading slashes are stripped rather than rejected, so a stray absolute-ish
 * input stays contained under assets/.
 */
export function assetDir(projectPath: string, folder: string, name: string): { abs: string; rel: string } {
  const cleanFolder = normalize(folder).replace(/^[/\\]+|[/\\]+$/g, '')
  if (!cleanFolder || cleanFolder.split(/[/\\]/).some((part) => part === '..' || part.startsWith('.'))) {
    throw new Error(`Invalid asset folder "${folder}" — use a relative path like "entities/e_player".`)
  }
  const cleanName = slug(name)
  if (!cleanName) throw new Error('Asset name is required.')
  const rel = join('assets', cleanFolder, cleanName)
  const abs = resolve(projectPath, rel)
  if (!isWithin(resolve(projectPath), abs) || abs === resolve(projectPath)) {
    throw new Error(`Asset path escapes the project: ${folder}`)
  }
  return { abs, rel }
}

/** Media types the chat/vision pipeline accepts for generated-asset previews. */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

export interface CredentialUpdate { commit(): Promise<void>; rollback(): Promise<void> }
async function credentialRaw(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Stored credentials must be a regular file.')
    if (info.size > 1024 * 1024) throw new Error('Stored credentials exceed the supported size.')
    const raw = await readFile(path,'utf8')
    if (Buffer.byteLength(raw) !== info.size) throw new Error('Stored credentials changed while being read.')
    return raw
  }
  catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** OS-encrypted credentials file in userData for one provider. */
export function credentialsStore<T extends Record<string, string>>(fileName: string) {
  const path = (): string => join(app.getPath('userData'), fileName)

  return {
    async snapshot(): Promise<{original:string|null;value:T|null;error?:unknown}> {
      const original = await credentialRaw(path())
      if (original === null) return {original,value:null}
      try {
        const value = decodeCredentialJson<T>(original,safeStorage,process.platform).value
        if (!value || typeof value!=='object' || Array.isArray(value) || !Object.values(value).every(item=>typeof item==='string'&&item)) throw new Error('Stored credentials have invalid fields. Re-enter the key in Settings.')
        return {original,value}
      } catch(error) { return {original,value:null,error} }
    },
    async load(): Promise<T | null> {
      const raw = await credentialRaw(path())
      if (raw === null) return null
      const decoded = decodeCredentialJson<T>(raw, safeStorage, process.platform)
      const credentials = decoded.value
      // Invalid data needs explicit recovery; it must not silently disappear.
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || !Object.values(credentials).every((v) => typeof v === 'string' && v)) throw new Error('Stored credentials have invalid fields. Re-enter the key in Settings.')

      if (!decoded.encrypted) {
        if (hasStrongEncryptionBackend(safeStorage, process.platform)) {
          await writeAtomic(path(), encryptCredentialJson(credentials, safeStorage, process.platform), raw)
        } else {
          console.warn(
            '[solar] legacy asset credentials remain in plaintext because OS secure storage is unavailable'
          )
        }
      }
      return credentials
    },
    async save(values: T): Promise<void> {
      await (await this.prepare(values)).commit()
    },
    async prepare(values: T, preserveUnreadable = false, expectedOriginal?:string|null): Promise<CredentialUpdate> {
      if (!Object.values(values).every(value => typeof value === 'string' && value)) throw new Error('Invalid credential fields.')
      const file = path(), original = await credentialRaw(file)
      if (expectedOriginal !== undefined && original !== expectedOriginal) throw new Error('The credential file changed while settings were being prepared.')
      const encrypted = encryptCredentialJson(values, safeStorage, process.platform)
      if (Buffer.byteLength(encrypted)>1024*1024) throw new Error('The encrypted credential store exceeds the supported size. No credentials were changed.')
      let unreadable = preserveUnreadable
      if (original !== null && !unreadable) {
        try {
          const previous = decodeCredentialJson<Record<string,string>>(original,safeStorage,process.platform).value
          unreadable = !previous || typeof previous !== 'object' || Array.isArray(previous) || !Object.values(previous).every(value=>typeof value==='string'&&value)
        } catch { unreadable = true }
      }
      const backup = unreadable && original !== null ? encryptCredentialJson({original}, safeStorage, process.platform) : null
      let committed = false
      return {
        async commit() {
          if (committed) throw new Error('Credential update already committed.')
          if (backup) await writeAtomic(`${file}.recovery-${randomUUID()}.enc`,backup)
          await writeAtomic(file,encrypted,original); committed = true
        },
        async rollback() {
          if (!committed) return
          if (original !== null) await writeAtomic(file,original,encrypted)
          else { if (await credentialRaw(file) !== encrypted) throw new Error('Credentials changed after the save; newer credentials were preserved.'); await rm(file,{force:true}) }
          committed = false
        }
      }
    },
    async clear(): Promise<void> {
      await rm(path(), { force: true })
    },
    async isConfigured(): Promise<boolean> {
      return (await this.load()) !== null
    }
  }
}
