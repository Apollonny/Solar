import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProjectDirectory } from './asset-store'
import { writeAtomic } from './json-file'

/** App-owned records have dedicated directories; never prune arbitrary .solar files. */
export async function agentStateDirectory(projectPath: string, kind: 'run-metrics' | 'validation-cache'): Promise<string> {
  const stateDir = await ensureProjectDirectory(projectPath, join(projectPath, '.solar'))
  const ignore = join(stateDir, '.gdignore')
  try { await lstat(ignore) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeAtomic(ignore, '')
  }
  const gitIgnore = join(stateDir, '.gitignore')
  try { await lstat(gitIgnore) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeAtomic(gitIgnore, '*\n')
  }
  return ensureProjectDirectory(projectPath, join(stateDir, kind))
}

export async function readAgentRecord(directory: string, file: string): Promise<unknown> {
  const path = join(directory, file)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Invalid agent record.')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export async function pruneAgentRecords(directory: string, maxBytes: number): Promise<void> {
  const records: { name: string; bytes: number; accessed: number }[] = []
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue
    const path = join(directory, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) continue
    records.push({ name, bytes: info.size, accessed: info.mtimeMs })
  }
  records.sort((a, b) => b.accessed - a.accessed)
  let bytes = 0
  for (const record of records) {
    bytes += record.bytes
    if (bytes > maxBytes) await rm(join(directory, record.name), { force: true })
  }
}
