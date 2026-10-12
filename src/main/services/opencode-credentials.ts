import { credentialsStore, type CredentialUpdate } from './asset-store'

/** OpenCode authentication records managed by Solar. */
export type ProviderAuthEntry = Record<string, unknown>

const store = credentialsStore<Record<string, string>>('opencode-credentials.json')

function isRecord(value: unknown): value is ProviderAuthEntry {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Read app-owned provider credentials from the OS-encrypted store. */
export async function loadManagedProviderAuth(): Promise<Record<string, ProviderAuthEntry>> {
  const serialized = await store.load()
  return parseManagedAuth(serialized)
}
function parseManagedAuth(serialized:Record<string,string>|null):Record<string,ProviderAuthEntry> {
  if (!serialized) return {}

  const entries: Record<string, ProviderAuthEntry> = {}
  for (const [provider, value] of Object.entries(serialized)) {
    try {
      const entry: unknown = JSON.parse(value)
      if (isRecord(entry)) entries[provider] = entry
    } catch { throw new Error('A stored provider credential is invalid. Re-enter the key in Settings.') }
    if (!entries[provider]) throw new Error('A stored provider credential has invalid fields. Re-enter the key in Settings.')
  }
  return entries
}

export async function managedAuthSnapshot():Promise<{original:string|null;entries:Record<string,ProviderAuthEntry>;error?:unknown}> {
  const snapshot = await store.snapshot()
  if (snapshot.error) return {original:snapshot.original,entries:{},error:snapshot.error}
  try { return {original:snapshot.original,entries:parseManagedAuth(snapshot.value)} }
  catch(error) { return {original:snapshot.original,entries:{},error} }
}
export async function prepareManagedProviderAuth(entries: Record<string, ProviderAuthEntry>, preserveUnreadable = false, expectedOriginal?:string|null): Promise<CredentialUpdate> {
  const serialized: Record<string,string> = {}
  for (const [provider,entry] of Object.entries(entries)) if (isRecord(entry) && Object.keys(entry).length) serialized[provider] = JSON.stringify(entry)
  return store.prepare(serialized,preserveUnreadable,expectedOriginal)
}

/** Write provider auth records as one encrypted, atomic credential-store update. */
export async function saveManagedProviderAuth(entries: Record<string, ProviderAuthEntry>): Promise<void> {
  const serialized: Record<string, string> = {}
  for (const [provider, entry] of Object.entries(entries)) {
    if (isRecord(entry) && Object.keys(entry).length > 0) serialized[provider] = JSON.stringify(entry)
  }
  if (Object.keys(serialized).length === 0) {
    await store.clear()
    return
  }
  await store.save(serialized)
}

/** Create per-child environment overrides for API keys held by Solar. */
export function runtimeProviderAuth(entries: Record<string, ProviderAuthEntry>): {
  environment: Record<string, string>
  config: Record<string, { options: { apiKey: string } }>
} {
  const environment: Record<string, string> = {}
  const config: Record<string, { options: { apiKey: string } }> = {}

  for (const [provider, entry] of Object.entries(entries)) {
    if (entry.type !== 'api' || typeof entry.key !== 'string' || !entry.key) continue

    const envName = `SOLAR_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    environment[envName] = entry.key
    config[provider] = { options: { apiKey: `{env:${envName}}` } }
  }

  return { environment, config }
}
