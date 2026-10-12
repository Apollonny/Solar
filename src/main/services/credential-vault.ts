/**
 * Small, versioned envelope for app-owned API credentials. Encryption is
 * provided by Electron safeStorage; this module stays dependency-injected so
 * its format and fallback policy can be tested without launching Electron.
 */

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend(): string
}

interface EncryptedCredentials {
  format: 'solar-safe-storage'
  version: 1
  data: string
}

const FORMAT = 'solar-safe-storage'
const LEGACY_FORMAT = 'genieengine-safe-storage'

export function hasStrongEncryptionBackend(storage: SecureStorageAdapter, platform: NodeJS.Platform): boolean {
  if (!storage.isEncryptionAvailable()) return false
  // Electron's basic_text Linux backend uses a hard-coded password and does
  // not protect secrets at rest. Never use it for new credential writes.
  if (platform === 'linux') {
    const backend = storage.getSelectedStorageBackend()
    if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) return false
  }
  return true
}

function unavailableMessage(platform: NodeJS.Platform): string {
  return platform === 'linux'
    ? 'Solar cannot securely store this API key because no Linux keyring is available. Configure GNOME Keyring or KWallet, then try again.'
    : 'Solar cannot securely store this API key because operating-system encryption is unavailable.'
}

export function encryptCredentialJson<T>(
  credentials: T,
  storage: SecureStorageAdapter,
  platform: NodeJS.Platform
): string {
  if (!hasStrongEncryptionBackend(storage, platform)) throw new Error(unavailableMessage(platform))

  const envelope: EncryptedCredentials = {
    format: FORMAT,
    version: 1,
    data: storage.encryptString(JSON.stringify(credentials)).toString('base64')
  }
  return JSON.stringify(envelope, null, 2)
}

export function decodeCredentialJson<T>(
  raw: string,
  storage: SecureStorageAdapter,
  platform: NodeJS.Platform
): { value: T; encrypted: boolean } {
  if (raw.length > 1024 * 1024) throw new Error('Stored credentials exceed the supported size. Re-enter the key in Settings.')
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { throw new Error('Stored credentials are not valid JSON. Re-enter the key in Settings.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored credentials have an invalid format.')
  }

  const record = parsed as Record<string, unknown>
  if (record.format !== FORMAT && record.format !== LEGACY_FORMAT) return { value: parsed as T, encrypted: false }
  if (record.version !== 1 || typeof record.data !== 'string' || !record.data.length || record.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.data)) {
    throw new Error('Stored encrypted credentials have an unsupported format.')
  }
  if (!hasStrongEncryptionBackend(storage, platform)) throw new Error(unavailableMessage(platform))

  try {
    const plaintext = storage.decryptString(Buffer.from(record.data, 'base64'))
    return { value: JSON.parse(plaintext) as T, encrypted: true }
  } catch {
    throw new Error('Solar could not decrypt the saved API key. Re-enter the key in Settings.')
  }
}
