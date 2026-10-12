import type { ModelProviderId } from './types'
import { MODEL_PROVIDERS } from './model-providers'

export function normalizeApiKey(value: unknown, label = 'API key'): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const key = value.trim()
  if (key.length > 16_384 || /\s|[\x00-\x1f\x7f]/.test(key)) throw new Error(`${label} contains whitespace or invalid characters. Paste only the key.`)
  return key
}

export function canonicalApiEndpoint(value: string, provider: ModelProviderId): string {
  let url: URL
  try { url = new URL(value.trim() || MODEL_PROVIDERS[provider].endpoint) }
  catch { throw new Error('Enter a valid HTTP(S) API base URL.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || url.protocol !== 'https:' && !loopback || url.username || url.password) throw new Error('Use an HTTPS API URL (HTTP is allowed only for localhost).')
  if (url.hash) throw new Error('Remove the fragment from the API base URL.')
  if ([...url.searchParams.keys()].some(key => /^(?:key|api[_-]?key|token|access[_-]?token|authorization)$/i.test(key))) throw new Error('API keys belong in the key field, not the API URL.')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href
}

export interface CredentialConnection { version: 1; provider: ModelProviderId; endpoint: string }
export function boundApiCredential(key: string, provider: ModelProviderId, endpoint: string): Record<string, unknown> {
  return { type: 'api', key: normalizeApiKey(key), solarConnection: {version:1,provider,endpoint:canonicalApiEndpoint(endpoint,provider)} satisfies CredentialConnection }
}
export function credentialMatchesConnection(entry: Record<string, unknown> | undefined, provider: ModelProviderId, endpoint: string, legacyEndpoint?: string): boolean {
  if (!entry || entry.type !== 'api') return false
  try {
    if (!normalizeApiKey(entry.key)) return false
    const connection = entry.solarConnection as Partial<CredentialConnection> | undefined
    if (connection !== undefined) return connection?.version === 1 && connection.provider === provider && typeof connection.endpoint === 'string' && canonicalApiEndpoint(connection.endpoint,provider) === canonicalApiEndpoint(endpoint,provider)
    return legacyEndpoint !== undefined && canonicalApiEndpoint(legacyEndpoint,provider) === canonicalApiEndpoint(endpoint,provider)
  } catch { return false }
}
