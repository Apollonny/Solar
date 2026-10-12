import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Only a missing file is an empty configuration; malformed data must survive. */
export async function readJsonForUpdate(path: string): Promise<{
  value: Record<string, unknown>
  original: string | null
}> {
  let original: string
  try {
    original = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { value: {}, original: null }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(original)
  } catch {
    throw new Error('OpenCode config is not valid JSON; it was left untouched.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode config has an unsupported format; it was left untouched.')
  }
  return { value: parsed as Record<string, unknown>, original }
}

export async function writeAtomic(filePath: string, contents: string, expectedCurrent?: string | null): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    if (expectedCurrent !== undefined) {
      let current: string | null
      try {
        current = await readFile(filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') current = null
        else throw err
      }
      if (current !== expectedCurrent) throw new Error('The file changed while the update was being prepared.')
    }
    await rename(temporary, filePath)
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => {})
    throw err
  }
}
