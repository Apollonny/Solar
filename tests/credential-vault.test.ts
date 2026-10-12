import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeCredentialJson,
  encryptCredentialJson,
  hasStrongEncryptionBackend,
  type SecureStorageAdapter
} from '../src/main/services/credential-vault'

function fakeStorage(backend = 'gnome_libsecret', available = true): SecureStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => {
      const encoded = value.toString('utf8')
      if (!encoded.startsWith('protected:')) throw new Error('invalid ciphertext')
      return encoded.slice('protected:'.length)
    }
  }
}

test('credential envelope encrypts JSON and decrypts it through the OS adapter', () => {
  const storage = fakeStorage()
  const credentials = { apiKey: 'private-token', region: 'test-region' }
  const encrypted = encryptCredentialJson(credentials, storage, 'win32')

  assert.equal(encrypted.includes('private-token'), false)
  assert.deepEqual(decodeCredentialJson<typeof credentials>(encrypted, storage, 'win32'), {
    value: credentials,
    encrypted: true
  })
})

test('legacy plaintext credentials remain readable for migration', () => {
  const decoded = decodeCredentialJson<{ apiKey: string }>(
    JSON.stringify({ apiKey: 'legacy-token' }),
    fakeStorage(),
    'darwin'
  )

  assert.deepEqual(decoded, { value: { apiKey: 'legacy-token' }, encrypted: false })
})

test('Linux basic_text fallback is rejected for new encryption and encrypted reads', () => {
  const storage = fakeStorage('basic_text')

  assert.equal(hasStrongEncryptionBackend(storage, 'linux'), false)
  assert.throws(
    () => encryptCredentialJson({ apiKey: 'private-token' }, storage, 'linux'),
    /GNOME Keyring or KWallet/
  )
})

test('unavailable OS encryption is reported instead of writing plaintext', () => {
  assert.throws(
    () => encryptCredentialJson({ apiKey: 'private-token' }, fakeStorage('gnome_libsecret', false), 'darwin'),
    /operating-system encryption is unavailable/
  )
})

test('unsupported encrypted envelope versions are rejected', () => {
  const raw = JSON.stringify({ format: 'genieengine-safe-storage', version: 2, data: 'ignored' })
  assert.throws(() => decodeCredentialJson(raw, fakeStorage(), 'win32'), /unsupported format/)
})
