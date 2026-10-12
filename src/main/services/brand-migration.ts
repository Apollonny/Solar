import { constants } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'

const LEGACY_APP_DIR = 'GenieEngine'
const APP_FILES = new Set([
  'settings.json',
  'gptimage-credentials.json',
  'hy3d-credentials.json',
  'opencode-credentials.json'
])

/** Keep the existing profile so its OS-backed credential key remains available. */
export function preserveLegacyUserDataPath(): void {
  // A separate profile lets development and recovery runs open projects
  // without changing the user's saved credentials or recent-project list.
  if (process.env.SOLAR_PROFILE_DIR) {
    const profile = resolve(process.env.SOLAR_PROFILE_DIR)
    mkdirSync(profile, { recursive: true })
    app.setPath('userData', profile)
    return
  }
  const legacyDir = join(app.getPath('appData'), LEGACY_APP_DIR)
  if (!existsSync(legacyDir)) return

  // Electron's safeStorage key is tied to its userData profile (in Chromium's
  // Local State on Windows). Copying an encrypted credential file alone into
  // Solar's new profile strands it, so existing installs keep the original
  // profile as their canonical data directory.
  app.setPath('userData', legacyDir)
}

/** Copy app-owned data before settings and providers read the Solar folder. */
export async function migrateUserData(): Promise<void> {
  if (process.env.SOLAR_PROFILE_DIR) return
  const oldDir = join(app.getPath('appData'), LEGACY_APP_DIR)
  const newDir = app.getPath('userData')
  if (oldDir === newDir) return

  let files: string[]
  try {
    files = await readdir(oldDir)
  } catch {
    return
  }
  await mkdir(newDir, { recursive: true })
  for (const file of files) {
    if (!APP_FILES.has(file) && !/^opencode-auth-\d+-[0-9a-f-]{36}\.backup\.enc$/.test(file)) continue
    try {
      await copyFile(join(oldDir, file), join(newDir, file), constants.COPYFILE_EXCL)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') continue
      console.warn(`[solar] could not migrate ${file}:`, error)
    }
  }
  // Chromium keeps localStorage in its profile, outside settings.json.
  const oldStorage = join(oldDir, 'Local Storage')
  const newStorage = join(newDir, 'Local Storage')
  if (existsSync(oldStorage) && !existsSync(newStorage)) {
    await cp(oldStorage, newStorage, { recursive: true, force: false }).catch((error) => {
      console.warn('[solar] could not migrate window preferences:', error)
    })
  }
}
