import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillContextReceipt } from '../../shared/production'

export interface SkillSnapshot {
  path: string; names: string[]; manifest: string
  files: { path: string; bytes: number; sha256: string }[]
}
export const skillHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const validSkillName = (name: unknown): name is string => typeof name === 'string' && name.length <= 64 && /^solar-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
export function validSkillPath(path: unknown): path is string {
  return typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..') && !path.startsWith('/')
}

/** Bounded reads verify links and file changes; no unbounded readFile allocation. */
export async function readSkillFile(root: string, path: string, expectedBytes: number): Promise<string> {
  if (!validSkillPath(path) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 1024 * 1024) throw new Error('Invalid skill snapshot file.')
  let candidate = root
  const rootInfo = await lstat(candidate)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Native skill cache cannot be linked.')
  for (const part of path.split('/')) {
    candidate = join(candidate, part)
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('Native skill cache cannot be linked.')
  }
  const handle = await open(candidate, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== expectedBytes) throw new Error('Native skill cache file size changed.')
    const bytes = Buffer.alloc(expectedBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset !== expectedBytes) throw new Error('Native skill cache file changed during its read.')
    const value = bytes.subarray(0, offset)
    const text = value.toString('utf8')
    if (!Buffer.from(text).equals(value)) throw new Error('Skill snapshot is not valid UTF-8.')
    return text
  } finally { await handle.close() }
}

/** Deliver complete selected documents, with independently verifiable receipts. */
export async function selectedSkillContext(names: string[], bundles: SkillSnapshot[], signal?: AbortSignal): Promise<{ context: string; receipts: SkillContextReceipt[]; paths: string[] }> {
  if (names.length > 8 || new Set(names).size !== names.length || names.some(name => !validSkillName(name))) throw new Error('Invalid or duplicate stage skill selection.')
  signal?.throwIfAborted()
  const documents: string[] = [], receipts: SkillContextReceipt[] = [], paths: string[] = []
  let total = 0
  const checked = new Set<SkillSnapshot>()
  for (const name of names) {
    const owners = bundles.filter(bundle => bundle.names.includes(name))
    if (owners.length !== 1) throw new Error('Assigned skill is missing or duplicated in the app bundles: ' + name)
    const bundle = owners[0]
    if (!checked.has(bundle)) {
      if (await readSkillFile(bundle.path, 'manifest.json', Buffer.byteLength(bundle.manifest)) !== bundle.manifest) throw new Error('Skill manifest changed; restart Solar to verify its cache.')
      checked.add(bundle)
    }
    const file = bundle.files.find(entry => entry.path === `${name}/SKILL.md`)
    if (!file) throw new Error('Assigned skill has no snapshot document: ' + name)
    total += file.bytes
    if (file.bytes > 64 * 1024 || total > 192 * 1024) throw new Error('Selected skills exceed the stage context budget. Select fewer specialist guides; no skill was truncated.')
    const content = await readSkillFile(bundle.path, file.path, file.bytes)
    if (skillHash(content) !== file.sha256 || !new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`).test(content)) throw new Error('Selected skill content changed; restart Solar to verify its cache: ' + name)
    documents.push(`## Assigned reference: ${name}\n${content}`)
    receipts.push({ name, sha256: file.sha256, bytes: file.bytes, manifestSha256: skillHash(bundle.manifest), delivery: 'host-context' })
    paths.push(join(bundle.path, file.path))
    signal?.throwIfAborted()
  }
  return { context: documents.join('\n\n'), receipts, paths }
}
