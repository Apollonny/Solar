import { cp, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
/** Keep original acceptance evidence without duplicate engines/import caches or credentials. */
export async function copyRunProof(source, target) {
  const entries = await readdir(source, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  async function copy(from, to) {
    const info = await lstat(from).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!info) return
    if (info.isSymbolicLink()) throw new Error('Acceptance evidence cannot contain links.')
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true })
      for (const entry of await readdir(from)) await copy(join(from, entry), join(to, entry))
    } else if (info.isFile()) await cp(from, to, { errorOnExist: true })
    else throw new Error('Unsupported acceptance artifact.')
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) throw new Error('Invalid acceptance run directory.')
    const from = join(source, entry.name), to = join(target, entry.name)
    await mkdir(to, { recursive: true })
    for (const name of ['run.json','attempts','checkpoints','evidence']) await copy(join(from,name),join(to,name))
    for (const test of await readdir(from, { withFileTypes: true })) {
      if (!test.isDirectory() || !/^test-[0-2]-[a-f0-9-]{36}$/.test(test.name)) continue
      const destination = join(to, test.name)
      await mkdir(destination)
      for (const name of ['selected.json','discovery.json','reports']) await copy(join(from,test.name,name),join(destination,name))
    }
  }
}
