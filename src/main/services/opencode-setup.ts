import { readFile, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { app, safeStorage } from 'electron'
import { gameTestBudgetInstructions } from '../../shared/agent-budget'
import type {
  LegacyOpenCodeCredential,
  ModelCatalogRequest,
  ModelCatalogItem,
  ModelSlotId,
  ModelSlotRequest,
  ModelSlotStatus,
  ModelProviderId,
  ReasoningEffort,
  SetupRequest,
  SetupStatus,
  ThinkingMode
} from '../../shared/types'
import {
  MODEL_PROVIDERS,
  modelProviderFromRefId,
  modelProviderIdForNpm,
  modelProviderRefId,
  isModelProviderId
} from '../../shared/model-providers'
import { compatibleReasoningEffort, openRouterReasoningBudget, reasoningEffortsForModel, reasoningOptionsForModel } from '../../shared/model-reasoning'
import { getChatModelRefs, setChatModelRefs } from '../state'
import { decodeCredentialJson, encryptCredentialJson } from './credential-vault'
import { loadManagedProviderAuth, prepareManagedProviderAuth, managedAuthSnapshot, runtimeProviderAuth, type ProviderAuthEntry } from './opencode-credentials'
import { isGptImageConfigured, prepareGptImageConfig } from './gptimage'
import { isHy3dConfigured, prepareHy3dCredentials } from './hy3d'
import { restartChatForSettings, isChatBusy } from './opencode'
import { withSetupMutation, waitForSetupUpdate } from './setup-mutations'
import { canonicalApiEndpoint, normalizeApiKey, boundApiCredential, credentialMatchesConnection } from '../../shared/provider-connection'
import type { CredentialUpdate } from './asset-store'
import { isConnectionFailure } from '../../shared/connection-recovery'
import { readJsonForUpdate, writeAtomic } from './json-file'
import { openRouterKeyQuota, type ModelAccess } from '../../shared/production-preflight'

/**
 * Provider setup for the AI chat, which runs as a small agent team over
 * two configurable model slots:
 *
 *  - CHAT — the single model used for every assistant conversation. It is
 *    also the global `model` in the OpenCode config.
 *  - IMAGE — the image-enabled model behind the two subagents declared under
 *    `agent` in the same config:
 *      · image-reader — describes image files (user-uploaded references,
 *        generated art) to the chat agent, which may not see images itself;
 *      · game-tester  — plays the game via the Solar MCP tools and
 *        verifies the screenshots it takes.
 *
 * The chat and image slots have independent endpoints + API keys. Solar stores its keys in
 * its OS-encrypted credential store and supplies them only to its OpenCode
 * process; endpoints + models go into the global OpenCode config. Chat slots on the
 * OpenRouter endpoint maps to OpenCode's built-in `openrouter` provider
 * (keeping models.dev metadata like context limits and reasoning support);
 * other endpoints get an openai-compatible provider entry under the stable
 * legacy id `medium`.
 *
 * The image slot ALWAYS uses its own `image` provider entry — even on
 * OpenRouter, where the chat slots use the built-in provider. Earlier
 * versions derived the image slot's provider from a comparison with the chat
 * endpoint, which aliased both models onto one credential: updating the chat
 * key silently overwrote the image key, and changing the chat endpoint
 * stranded the image credential entirely. A fixed per-slot id makes that
 * impossible. "Leave the key blank to reuse the chat key" still works, but
 * as a COPY into the slot's own credential at save time, never as sharing.
 */

export const DEFAULT_ENDPOINT = MODEL_PROVIDERS.openrouter.endpoint
export const DEFAULT_MEDIUM_MODEL = MODEL_PROVIDERS.openrouter.modelExamples.medium
export const DEFAULT_IMAGE_MODEL = MODEL_PROVIDERS.openrouter.modelExamples.image

/** Provider id OpenCode's built-in OpenRouter support registers under. */
const OPENROUTER_PROVIDER = 'openrouter'
/** Provider id older versions used for a custom main-model endpoint (read for migration only). */
const LEGACY_CUSTOM_PROVIDER = 'custom'
/** Stable per-slot provider ids for models on non-OpenRouter endpoints (chat) / any endpoint (image). */
const MEDIUM_PROVIDER = 'medium'
const LARGE_PROVIDER = 'large'
const IMAGE_PROVIDER = 'image'
const APP_PROVIDER_IDS = new Set([
  OPENROUTER_PROVIDER,
  MEDIUM_PROVIDER,
  LARGE_PROVIDER,
  IMAGE_PROVIDER,
  LEGACY_CUSTOM_PROVIDER
])
for (const slot of ['medium', 'large', 'image'] as const) {
  for (const provider of Object.keys(MODEL_PROVIDERS) as ModelProviderId[]) {
    APP_PROVIDER_IDS.add(modelProviderRefId(slot, provider))
    APP_PROVIDER_IDS.add(`genieengine-${slot}-${provider}`)
  }
}

export const IMAGE_READER_AGENT = 'image-reader'
export const GAME_TESTER_AGENT = 'game-tester'

function configPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json')
}

function authPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'auth.json')
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

interface AuthBackup {
  original: string
  migrated: string
}

const BACKUP_PREFIX = 'opencode-auth-'
const BACKUP_SUFFIX = '.backup.enc'

function authBackupPath(id: string): string {
  if (!/^\d+-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid OpenCode auth backup id.')
  return join(app.getPath('userData'), `${BACKUP_PREFIX}${id}${BACKUP_SUFFIX}`)
}

async function readAuthFile(): Promise<string | null> {
  try {
    return await readFile(authPath(), 'utf8')
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

function apiCredential(entry: unknown): entry is AuthEntry {
  return (
    !!entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).type === 'api' &&
    typeof (entry as Record<string, unknown>).key === 'string' &&
    !!(entry as Record<string, unknown>).key
  )
}

function activeProviderLabels(config: Record<string, unknown>): Map<string, string[]> {
  const providers = new Map<string, string[]>()
  const slots: Array<{ label: string; ref: string }> = [
    { label: 'Chat model', ref: chatModelRef(config) },
    { label: 'Image model', ref: configuredImageModel(config) }
  ]
  for (const slot of slots) {
    const provider = splitModel(slot.ref).provider
    const labels = providers.get(provider) ?? []
    if (!labels.includes(slot.label)) labels.push(slot.label)
    providers.set(provider, labels)
  }
  return providers
}

function sameCredentialPayload(left:AuthEntry,right:AuthEntry):boolean {
  const payload = (entry:AuthEntry):AuthEntry => Object.fromEntries(Object.entries(entry).filter(([key])=>key!=='solarConnection'))
  return isDeepStrictEqual(payload(left),payload(right))
}
function legacyCredentialCandidates(
  config: Record<string, unknown>,
  auth: Record<string, unknown>,
  managedAuth: Record<string, AuthEntry>
): LegacyOpenCodeCredential[] {
  const candidates: LegacyOpenCodeCredential[] = []
  for (const [providerId, slotLabels] of activeProviderLabels(config)) {
    if (!APP_PROVIDER_IDS.has(providerId)) continue
    const legacy = auth[providerId]
    if (!apiCredential(legacy)) continue
    const managed = managedAuth[providerId]
    // Do not offer to remove a shared entry if the app's encrypted copy is a
    // different credential. It may still be needed by another OpenCode user.
    if (managed && !sameCredentialPayload(managed, legacy)) continue
    candidates.push({ providerId, slotLabels })
  }
  return candidates
}

async function latestAuthBackupStatus(): Promise<{ id: string; restorable: boolean } | null> {
  let names: string[]
  try {
    names = await readdir(app.getPath('userData'))
  } catch {
    return null
  }
  const ids = names
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .map((name) => name.slice(BACKUP_PREFIX.length, -BACKUP_SUFFIX.length))
    .filter((id) => /^\d+-[0-9a-f-]{36}$/.test(id))
    .sort((a, b) => Number(b.split('-', 1)[0]) - Number(a.split('-', 1)[0]))
  const id = ids[0]
  if (!id) return null

  try {
    const encrypted = await readFile(authBackupPath(id), 'utf8')
    const backup = decodeCredentialJson<AuthBackup>(encrypted, safeStorage, process.platform).value
    const current = await readAuthFile()
    return { id, restorable: typeof backup.migrated === 'string' && current === backup.migrated }
  } catch {
    return { id, restorable: false }
  }
}

/** Split a stored `provider/model` string into its parts (model may contain '/'). */
function splitModel(full: string): { provider: string; model: string } {
  const slash = full.indexOf('/')
  if (slash === -1) return { provider: OPENROUTER_PROVIDER, model: full }
  return { provider: full.slice(0, slash), model: full.slice(slash + 1) }
}

/** OpenCode's env-var convention for a provider's key, e.g. openrouter → OPENROUTER_API_KEY. */
function providerEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    return canonicalApiEndpoint(endpoint,'openrouter') === canonicalApiEndpoint(DEFAULT_ENDPOINT,'openrouter')
  } catch {
    return false
  }
}

/** A custom-provider entry in the OpenCode config's `provider` map. */
interface ProviderEntry extends Record<string, unknown> {
  npm?: string
  options?: { baseURL?: string; apiKey?: string }
  models?: Record<string, Record<string, unknown>>
}

const THINKING_MODES: ThinkingMode[] = ['default', 'enabled', 'disabled']
const REASONING_EFFORTS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max']

/** Untrusted / stored values → a valid union member ('default' = absent). */
function coerceThinking(value: unknown): ThinkingMode {
  return THINKING_MODES.includes(value as ThinkingMode) ? (value as ThinkingMode) : 'default'
}
function coerceEffort(value: unknown): ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : 'default'
}

function storedEffort(
  provider: ModelProviderId,
  model: string,
  options: Record<string, unknown>,
  reasoningBudgetMax?: number | null
): ReasoningEffort {
  const nestedReasoning = options.reasoning as { effort?: unknown; max_tokens?: unknown } | undefined
  const googleThinking = options.thinkingConfig as { thinkingLevel?: unknown; thinkingBudget?: unknown } | undefined
  const direct = coerceEffort(
    nestedReasoning?.effort ?? options.reasoningEffort ?? options.reasoning_effort ?? options.effort ??
    googleThinking?.thinkingLevel
  )
  if (provider === 'openrouter' && reasoningBudgetMax != null &&
      typeof nestedReasoning?.max_tokens === 'number') {
    const budget = nestedReasoning.max_tokens
    return (['low', 'medium', 'high', 'xhigh', 'max'] as const).reduce((closest, current) =>
      Math.abs(openRouterReasoningBudget(reasoningBudgetMax, current) - budget) <
      Math.abs(openRouterReasoningBudget(reasoningBudgetMax, closest) - budget)
        ? current : closest)
  }
  const geminiBudget = provider === 'gemini' && model.toLowerCase().startsWith('gemini-2.5')
    ? googleThinking?.thinkingBudget
    : provider === 'openrouter' && model.toLowerCase().startsWith('google/gemini-2.5-')
      ? nestedReasoning?.max_tokens
      : undefined
  if (typeof geminiBudget === 'number') {
    const budget = geminiBudget
    if (budget <= 1024) return 'low'
    if (budget <= 4096) return 'medium'
    if (budget <= 8192) return 'high'
    if (budget <= 16000) return 'xhigh'
    return 'max'
  }
  const anthropicBudget = provider === 'anthropic' && options.thinking &&
    typeof options.thinking === 'object' && !Array.isArray(options.thinking)
    ? (options.thinking as Record<string, unknown>).budgetTokens : undefined
  if (typeof anthropicBudget === 'number' && reasoningBudgetMax != null) {
    return (['low', 'medium', 'high', 'xhigh', 'max'] as const).reduce((closest, current) =>
      Math.abs(openRouterReasoningBudget(reasoningBudgetMax, current) - anthropicBudget) <
      Math.abs(openRouterReasoningBudget(reasoningBudgetMax, closest) - anthropicBudget)
        ? current : closest)
  }
  if (provider !== 'nvidia' || typeof options.reasoning_budget !== 'number') return direct
  const budget = options.reasoning_budget
  if (reasoningBudgetMax != null &&
      !['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-super-120b-a12b',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'].includes(model.toLowerCase())) {
    return (['low', 'medium', 'high', 'xhigh', 'max'] as const).reduce((closest, current) =>
      Math.abs(openRouterReasoningBudget(reasoningBudgetMax, current) - budget) <
      Math.abs(openRouterReasoningBudget(reasoningBudgetMax, closest) - budget)
        ? current : closest)
  }
  if (model.toLowerCase() === 'nvidia/nemotron-3-super-120b-a12b' && direct === 'low') return 'low'
  if (budget <= 1024) return 'low'
  if (budget <= 4096) return 'medium'
  if (budget <= 8192) return 'high'
  if (budget <= 16384) return 'xhigh'
  return 'max'
}

/** Map the shared effort scale to each provider's native model option. */
function wireOptions(
  thinking: ThinkingMode,
  effort: ReasoningEffort,
  provider: ModelProviderId,
  model: string,
  reasoningBudgetMax?: number | null,
  reasoningMode?: ModelCatalogItem['reasoningMode']
): Record<string, unknown> | null {
  const options: Record<string, unknown> = {}
  if ((provider === 'openrouter' || provider === 'custom') && thinking !== 'default') {
    options.thinking = { type: thinking }
  }
  if (effort !== 'default') {
    Object.assign(options, reasoningOptionsForModel(provider, model, effort, reasoningBudgetMax, reasoningMode))
  }
  return Object.keys(options).length ? options : null
}

function clearManagedReasoningOptions(options: Record<string, unknown>, provider?: ModelProviderId): void {
  const reasoning = options.reasoning
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const remaining = { ...(reasoning as Record<string, unknown>) }
    delete remaining.effort
    delete remaining.max_tokens
    if (Object.keys(remaining).length) options.reasoning = remaining
    else delete options.reasoning
  } else {
    delete options.reasoning
  }
  for (const key of ['reasoning_budget', 'reasoning_effort', 'reasoningEffort', 'effort', 'thinkingConfig']) {
    delete options[key]
  }
  if (provider === 'anthropic') delete options.thinking
}

function applyWireOptions(options: Record<string, unknown>, wire: Record<string, unknown> | null): void {
  if (!wire) return
  const existing = options.reasoning
  const incoming = wire.reasoning
  Object.assign(options, wire)
  if (existing && incoming && typeof existing === 'object' && typeof incoming === 'object' &&
      !Array.isArray(existing) && !Array.isArray(incoming)) {
    options.reasoning = { ...existing, ...incoming }
  }
}

/** Upgrade reasoning settings saved by older Solar builds to the model's wire format. */
export function normalizeChatReasoningOptions(config: Record<string, unknown>): void {
  const ref = chatModelRef(config)
  const { provider: providerId, model } = splitModel(ref)
  if (providerId !== OPENROUTER_PROVIDER && !modelProviderFromRefId(providerId)) return
  const provider = slotProviderIdForRef('medium', ref, config)
  const declaration = providerEntries(config)[providerId]?.models?.[model]
  if (!declaration?.options || typeof declaration.options !== 'object') return
  const options = declaration.options as Record<string, unknown>
  const refs = getChatModelRefs()
  const saved = refs.chat === ref ? refs : undefined
  const catalog = saved?.chatReasoningEfforts !== undefined
    ? { id: model, supportsImageInput: null, reasoningEfforts: saved.chatReasoningEfforts,
        reasoningBudgetMax: saved.chatReasoningBudgetMax,
        reasoningMode: saved.chatReasoningMode } satisfies ModelCatalogItem
    : undefined
  const budgetMax = saved?.chatReasoningBudgetMax
  const effort = storedEffort(provider, model, options, budgetMax)
  if (effort === 'default') return
  const supported = reasoningEffortsForModel(provider, model, catalog)
  const updated = { ...options }
  clearManagedReasoningOptions(updated, provider)
  if (supported?.includes(effort)) applyWireOptions(updated, wireOptions('default', effort, provider, model, budgetMax, saved?.chatReasoningMode))
  if (Object.keys(updated).length) declaration.options = updated
  else delete declaration.options
}

/** Keep existing scoped xAI entries on the adapter that reads their options. */
export function normalizeManagedProviderAdapters(config: Record<string, unknown>): void {
  for (const [providerId, entry] of Object.entries(providerEntries(config))) {
    if (modelProviderFromRefId(providerId) === 'xai' && entry.npm === '@ai-sdk/xai') {
      entry.npm = MODEL_PROVIDERS.xai.npm
    }
  }
}

function providerEntries(config: Record<string, unknown>): Record<string, ProviderEntry> {
  return (config.provider ?? {}) as Record<string, ProviderEntry>
}

function agentEntries(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (config.agent ?? {}) as Record<string, Record<string, unknown>>
}

/** The `provider/model` currently assigned to the subagents (default when unset). */
export function configuredImageModel(config: Record<string, unknown>): string {
  const current = agentEntries(config)[IMAGE_READER_AGENT]?.model
  return typeof current === 'string' && current
    ? current
    : `${OPENROUTER_PROVIDER}/${DEFAULT_IMAGE_MODEL}`
}

/** Resolve the new single model first, then migrate the old Medium/Large settings. */
function chatModelRef(config: Record<string, unknown>): string {
  const stored = getChatModelRefs()
  if (stored.chat) return stored.chat
  if (stored.medium) return stored.medium
  if (stored.large) return stored.large
  if (typeof config.model === 'string' && config.model) return config.model
  return `${OPENROUTER_PROVIDER}/${DEFAULT_MEDIUM_MODEL}`
}

function slotProviderIdForRef(slot: ModelSlotId, ref: string, config: Record<string, unknown>): ModelProviderId {
  const { provider } = splitModel(ref)
  const configured = providerEntries(config)[provider]
  const managedIdProvider = modelProviderFromRefId(provider)
  if (managedIdProvider) return managedIdProvider
  if (provider === OPENROUTER_PROVIDER) return 'openrouter'
  const endpoint = configured?.options?.baseURL
  // Previous versions gave the image slot its own OpenAI-compatible provider
  // id even when it pointed at OpenRouter. Keep that setup recognizable.
  if (slot === 'image' && provider === IMAGE_PROVIDER && typeof endpoint === 'string' && isOpenRouterEndpoint(endpoint)) {
    return 'openrouter'
  }
  const adapterProvider = modelProviderIdForNpm(configured?.npm)
  if (adapterProvider) return adapterProvider
  if (provider === 'openai' || provider === 'anthropic' || provider === 'google' || provider === 'xai') {
    return provider === 'google' ? 'gemini' : provider
  }
  return 'custom'
}

function slotEndpointForRef(
  ref: string,
  provider: ModelProviderId,
  config: Record<string, unknown>
): string {
  const { provider: providerId } = splitModel(ref)
  const configured = providerEntries(config)[providerId]
  return configured?.options?.baseURL || MODEL_PROVIDERS[provider].endpoint
}

const MODEL_CATALOG_MAX_BYTES = 5 * 1024 * 1024
const MODEL_CATALOG_MAX_IDS = 1000

function modelCatalogProviderId(slot: ModelSlotId, provider: ModelProviderId, endpoint: string): string {
  // Keep this in sync with saveSetup's OpenRouter built-in-provider rule.
  if (slot !== 'image' && provider === 'openrouter' && isOpenRouterEndpoint(endpoint)) return OPENROUTER_PROVIDER
  return modelProviderRefId(slot, provider)
}

function normalizedEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.hash = ''
  return url.href
}

function catalogEndpoint(value: string, provider: ModelProviderId): URL {
  return new URL(canonicalApiEndpoint(value,provider))
}

function providerCredentialAliases(provider: ModelProviderId): string[] {
  switch (provider) {
    case 'openai': return ['openai']
    case 'anthropic': return ['anthropic']
    case 'gemini': return ['google', 'gemini']
    case 'xai': return ['xai']
    case 'nvidia': return ['nvidia']
    case 'openrouter': return [OPENROUTER_PROVIDER]
    case 'custom': return []
  }
}

function credentialCandidates(slot: ModelSlotId, provider: ModelProviderId, endpoint: string, config: Record<string,unknown>): Map<string,string | undefined> {
  const candidates = new Map<string,string | undefined>([[modelCatalogProviderId(slot,provider,endpoint),undefined]])
  for (const [currentSlot,ref] of [['medium',chatModelRef(config)],['image',configuredImageModel(config)]] as [ModelSlotId,string][]) {
    if (slotProviderIdForRef(currentSlot,ref,config) !== provider) continue
    try {
      const currentEndpoint = canonicalApiEndpoint(slotEndpointForRef(ref,provider,config),provider)
      if (currentEndpoint === canonicalApiEndpoint(endpoint,provider)) candidates.set(splitModel(ref).provider,currentEndpoint)
    } catch { /* A broken inactive connection cannot authorize credential reuse. */ }
  }
  if (canonicalApiEndpoint(endpoint,provider) === canonicalApiEndpoint(MODEL_PROVIDERS[provider].endpoint,provider)) {
    for (const id of providerCredentialAliases(provider)) {
      const declared = providerEntries(config)[id]?.options?.baseURL ?? MODEL_PROVIDERS[provider].endpoint
      try { if (canonicalApiEndpoint(declared,provider) === canonicalApiEndpoint(endpoint,provider)) candidates.set(id,declared) } catch { /* Ignore a damaged alias. */ }
    }
  }
  return candidates
}
function connectionCredential(slot: ModelSlotId, provider: ModelProviderId, endpoint: string, config: Record<string,unknown>, managed: Record<string,ProviderAuthEntry>, auth: Record<string,unknown>): AuthEntry | undefined {
  try { canonicalApiEndpoint(endpoint,provider) } catch { return undefined }
  const candidates = credentialCandidates(slot,provider,endpoint,config)
  for (const [id,legacyEndpoint] of candidates) {
    for (const entry of [managed[id],auth[id]]) if (apiCredential(entry) && credentialMatchesConnection(entry,provider,endpoint,legacyEndpoint)) return entry
  }
  const names = new Set([...candidates].filter(([,legacyEndpoint])=>legacyEndpoint!==undefined).map(([id])=>providerEnvVar(id)))
  if (provider === 'gemini' && canonicalApiEndpoint(endpoint,provider) === canonicalApiEndpoint(MODEL_PROVIDERS.gemini.endpoint,provider)) for (const name of ['GOOGLE_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','GEMINI_API_KEY']) names.add(name)
  for (const name of names) {
    try { const key = normalizeApiKey(process.env[name] ?? ''); if (key) return boundApiCredential(key,provider,endpoint) }
    catch { /* An invalid inherited key must not make Settings inaccessible. */ }
  }
  return undefined
}
async function resolveCatalogCredential(request: ModelCatalogRequest, endpoint: URL): Promise<string> {
  const typedKey = normalizeApiKey(request.apiKey)
  if (typedKey) return typedKey
  await waitForSetupUpdate()
  const config = await readJson(configPath())
  const [managedAuth, auth] = await Promise.all([loadManagedProviderAuth(), readJson(authPath())])
  const entry = connectionCredential(request.slot,request.provider,endpoint.href,config,managedAuth,auth)
  if (entry) return normalizeApiKey(entry.key)
  throw new Error('Enter an API key for this provider and API base URL. A saved key for a different connection will not be sent.')
}

/** Resolve active credentials with the same connection rules as Settings. */
export async function runtimeSetupAuth(): Promise<ReturnType<typeof runtimeProviderAuth>> {
  await waitForSetupUpdate()
  const [config,managed,auth] = await Promise.all([readJson(configPath()),loadManagedProviderAuth(),readJson(authPath())])
  const selected: Record<string,ProviderAuthEntry> = {}, ids: string[] = []
  for (const [slot,ref] of [['medium',chatModelRef(config)],['image',configuredImageModel(config)]] as [ModelSlotId,string][]) {
    const id = splitModel(ref).provider, provider = slotProviderIdForRef(slot,ref,config), endpoint = slotEndpointForRef(ref,provider,config)
    ids.push(id)
    const entry = connectionCredential(slot,provider,endpoint,config,managed,auth)
    if (entry) selected[id] = entry
  }
  const result = runtimeProviderAuth(selected)
  for (const id of ids) if (!result.config[id]) result.config[id] = {options:{apiKey:''}}
  return result
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MODEL_CATALOG_MAX_BYTES) {
    throw new Error('The provider model catalog is too large to load.')
  }
  if (!response.body) throw new Error('The provider returned an empty model catalog.')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MODEL_CATALOG_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('The provider model catalog is too large to load.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))) as unknown
  } catch {
    throw new Error('The provider returned an invalid model catalog.')
  }
}

function imageInputSupport(model: Record<string, unknown>): boolean | null {
  const directModalities = model.input_modalities
  const architecture = model.architecture
  const architectureModalities = architecture && typeof architecture === 'object' && !Array.isArray(architecture)
    ? (architecture as Record<string, unknown>).input_modalities
    : undefined
  const modalities = Array.isArray(directModalities) ? directModalities : architectureModalities
  if (Array.isArray(modalities) && modalities.length > 0 && modalities.every((item) => typeof item === 'string')) {
    return modalities.includes('image')
  }

  const capabilities = model.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null
  const imageInput = (capabilities as Record<string, unknown>).image_input
  if (!imageInput || typeof imageInput !== 'object' || Array.isArray(imageInput)) return null
  const supported = (imageInput as Record<string, unknown>).supported
  return typeof supported === 'boolean' ? supported : null
}

function reasoningSupport(model: Record<string, unknown>, provider: ModelProviderId): {
  reasoningEfforts: Exclude<ReasoningEffort, 'default'>[] | null
  supportsReasoning: boolean | null
  reasoningBudgetMax?: number
  reasoningMode?: ModelCatalogItem['reasoningMode']
} {
  const capabilities = model.capabilities
  const capabilityRecord = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? capabilities as Record<string, unknown>
    : undefined
  if (provider === 'anthropic' && capabilityRecord) {
    const effort = capabilityRecord.effort
    const effortRecord = effort && typeof effort === 'object' && !Array.isArray(effort)
      ? effort as Record<string, unknown> : undefined
    const thinking = capabilityRecord.thinking
    const thinkingRecord = thinking && typeof thinking === 'object' && !Array.isArray(thinking)
      ? thinking as Record<string, unknown> : undefined
    const types = thinkingRecord?.types
    const typeRecord = types && typeof types === 'object' && !Array.isArray(types)
      ? types as Record<string, unknown> : undefined
    const isSupported = (value: unknown): boolean =>
      !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).supported === true
    const adaptive = isSupported(typeRecord?.adaptive)
    const enabled = isSupported(typeRecord?.enabled)
    if (effortRecord) {
      const levels = (['max', 'xhigh', 'high', 'medium', 'low'] as const)
        .filter((level) => isSupported(effortRecord[level]))
      return {
        reasoningEfforts: levels,
        supportsReasoning: levels.length > 0,
        reasoningMode: adaptive ? 'adaptive' : 'effort'
      }
    }
    if (enabled) {
      const maxTokens = model.max_tokens
      const ceiling = typeof maxTokens === 'number' && Number.isFinite(maxTokens)
        ? Math.min(16000, Math.floor(maxTokens) - 1024) : 16000
      if (ceiling >= 5128) return {
        reasoningEfforts: ['max', 'xhigh', 'high', 'medium', 'low'],
        supportsReasoning: true,
        reasoningBudgetMax: ceiling,
        reasoningMode: 'budget'
      }
    }
    if (thinkingRecord?.supported === false) {
      return { reasoningEfforts: [], supportsReasoning: false }
    }
  }
  if (provider === 'openrouter' && model.reasoning && typeof model.reasoning === 'object' &&
      !Array.isArray(model.reasoning)) {
    const reasoning = model.reasoning as Record<string, unknown>
    const values = reasoning.supported_efforts
    const advertised = Array.isArray(values) && values.every((item) => typeof item === 'string')
      ? (['max', 'xhigh', 'high', 'medium', 'low'] as const)
        .filter((item) => values.some((value) => String(value).toLowerCase() === item))
      : values === null
        ? (['max', 'xhigh', 'high', 'medium', 'low'] as const)
        : null
    if (advertised && advertised.length > 0) {
      return { reasoningEfforts: [...advertised], supportsReasoning: true }
    }
    if (reasoning.supports_max_tokens === true) {
      const topProvider = model.top_provider && typeof model.top_provider === 'object' && !Array.isArray(model.top_provider)
        ? model.top_provider as Record<string, unknown>
        : undefined
      const outputLimit = topProvider?.max_completion_tokens ?? model.max_completion_tokens
      const maxBudget = typeof outputLimit === 'number' && Number.isFinite(outputLimit)
        ? Math.min(28000, Math.floor(outputLimit) - 4096)
        : 4096
      if (maxBudget >= 1028) {
        return {
          reasoningEfforts: ['max', 'xhigh', 'high', 'medium', 'low'],
          supportsReasoning: true,
          reasoningBudgetMax: maxBudget
        }
      }
    }
    return { reasoningEfforts: [], supportsReasoning: false }
  }
  const advertised = capabilityRecord?.reasoning_effort ?? model.reasoning_effort ?? model.reasoningEffort
  if (Array.isArray(advertised) && advertised.every((item) => typeof item === 'string')) {
    const allowed = new Set(advertised.map((item) => item.toLowerCase()))
    const values = (['max', 'xhigh', 'high', 'medium', 'low'] as const).filter((item) => allowed.has(item))
    return { reasoningEfforts: [...values], supportsReasoning: values.length > 0 }
  }

  const supportedParameters = model.supported_parameters
  if (Array.isArray(supportedParameters) && supportedParameters.every((item) => typeof item === 'string')) {
    const supportsReasoning = supportedParameters.some((item) =>
      ['reasoning', 'reasoning_effort', 'reasoning_budget'].includes(item.toLowerCase())
    )
    if (provider === 'nvidia' && supportedParameters.some((item) => item.toLowerCase() === 'reasoning_budget')) {
      const range = capabilityRecord?.reasoning_budget ?? model.reasoning_budget
      const maximum = range && typeof range === 'object' && !Array.isArray(range)
        ? (range as Record<string, unknown>).maximum ?? (range as Record<string, unknown>).max
        : undefined
      const maxBudget = typeof maximum === 'number' && Number.isFinite(maximum)
        ? Math.min(31999, Math.floor(maximum))
        : 16000
      if (maxBudget >= 1028) return {
        reasoningEfforts: ['max', 'xhigh', 'high', 'medium', 'low'],
        supportsReasoning: true,
        reasoningBudgetMax: maxBudget
      }
    }
    return { reasoningEfforts: null, supportsReasoning }
  }
  return { reasoningEfforts: null, supportsReasoning: null }
}

function parseModelCatalog(payload: unknown, provider: ModelProviderId): ModelCatalogItem[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const body = payload as Record<string, unknown>
  const rows = provider === 'gemini' || provider === 'xai'
    ? (Array.isArray(body.models) ? body.models : body.data)
    : (Array.isArray(body.data) ? body.data : body.models)
  if (!Array.isArray(rows)) return []

  const models = new Map<string, ModelCatalogItem>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const model = row as Record<string, unknown>
    if (
      provider === 'gemini' &&
      (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes('generateContent'))
    ) continue
    const rawId = typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : ''
    const id = provider === 'gemini' ? rawId.replace(/^models\//, '') : rawId
    if (id.trim()) {
      const normalizedId = id.trim()
      const item: ModelCatalogItem = {
        id: normalizedId,
        supportsImageInput: imageInputSupport(model),
        ...reasoningSupport(model, provider)
      }
      models.set(normalizedId, item)
      if (provider === 'xai' && Array.isArray(model.aliases)) {
        for (const alias of model.aliases) {
          if (typeof alias === 'string' && alias.trim() && !models.has(alias.trim())) {
            models.set(alias.trim(), { ...item, id: alias.trim() })
          }
        }
      }
    }
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MODEL_CATALOG_MAX_IDS)
}

class CatalogConnectionError extends Error {
  readonly code = 'PROVIDER_CATALOG_ERROR'
  constructor(message:string,readonly status?:number) { super(message) }
}
async function catalogJson(endpoint:URL,headers:Record<string,string>,signal?:AbortSignal):Promise<unknown> {
  for(let attempt=0;attempt<3;attempt++) {
    signal?.throwIfAborted()
    try {
      const response = await fetch(endpoint,{method:'GET',headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)})
      if (!response.ok) {
        await response.body?.cancel().catch(()=>{})
        if(response.status===401||response.status===403)throw new CatalogConnectionError('The provider rejected the API key or its permissions. Check the key and API provider.',response.status)
        throw new CatalogConnectionError(`Could not load provider data (HTTP ${response.status}). Check the provider and API base URL.`,response.status)
      }
      return await readLimitedJson(response)
    } catch(error) {
      signal?.throwIfAborted()
      if(attempt===2||error instanceof CatalogConnectionError && [501,505].includes(error.status??0)||!isConnectionFailure(error)) {
        if(error instanceof CatalogConnectionError)throw error
        throw new Error(isConnectionFailure(error)?'Provider connection is still unavailable after reconnect attempts. Settings and keys were not changed.':error instanceof Error&&/catalog/.test(error.message)?error.message:'The provider connection failed. Check the API URL and key.')
      }
      await new Promise<void>((resolve,reject)=>{
        const aborted=():void=>{clearTimeout(timer);reject(new Error('Provider check cancelled.'))}
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',aborted);resolve()},1000*(attempt+1))
        signal?.addEventListener('abort',aborted,{once:true})
        if(signal?.aborted)aborted()
      })
    }
  }
  throw new Error('The provider connection is unavailable.')
}

/** Catalog reads do not prove generation access. OpenRouter's key endpoint
 * separately verifies authentication because its model catalog may be public. */
export async function listModelIds(request: ModelCatalogRequest, signal?: AbortSignal): Promise<ModelCatalogItem[]> {
  if (!request || !isModelProviderId(request.provider)) throw new Error('Unsupported API provider.')
  if (typeof request.endpoint !== 'string' || typeof request.apiKey !== 'string') {
    throw new Error('Model catalog request has invalid connection settings.')
  }
  if (!['medium', 'image'].includes(request.slot)) throw new Error('Unsupported model slot.')
  const provider = request.provider
  const endpoint = catalogEndpoint(request.endpoint, provider)
  const apiKey = await resolveCatalogCredential(request, endpoint)
  const path = provider === 'xai' ? 'language-models' : 'models'
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${path}`
  endpoint.hash = ''
  if (provider === 'gemini') endpoint.searchParams.set('pageSize', '1000')
  if (provider === 'anthropic') endpoint.searchParams.set('limit', '1000')
  if (provider === 'openrouter' && request.slot === 'image') {
    endpoint.searchParams.set('input_modalities', 'text,image')
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (provider === 'gemini') {
    headers['x-goog-api-key'] = apiKey
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }

  if(provider==='openrouter'&&isOpenRouterEndpoint(request.endpoint.trim()||MODEL_PROVIDERS.openrouter.endpoint)) {
    const keyStatus=await catalogJson(new URL('https://openrouter.ai/api/v1/key'),headers,signal)
    if(!keyStatus||typeof keyStatus!=='object'||Array.isArray(keyStatus)||!(keyStatus as Record<string,unknown>).data||typeof (keyStatus as Record<string,unknown>).data!=='object'||Array.isArray((keyStatus as Record<string,unknown>).data))throw new Error('The provider returned an invalid key verification response.')
  }
  const ids = parseModelCatalog(await catalogJson(endpoint,headers,signal), provider)
  if (ids.length === 0) throw new Error('The provider returned no compatible model IDs.')
  return ids
}

/** Read-only quota introspection. Never persist or return the key/label/provider body. */
export async function inspectModelKeyQuota(request: ModelCatalogRequest, signal?: AbortSignal): Promise<ModelAccess['quota']> {
  if(request.provider!=='openrouter')return {state:'unknown',remaining:null}
  const endpoint=catalogEndpoint(request.endpoint,request.provider)
  // Only the official API offers this contract. Do not send a credential to a
  // guessed endpoint or follow redirects from a custom proxy.
  if(endpoint.origin!=='https://openrouter.ai'||endpoint.pathname.replace(/\/+$/,'')!=='/api/v1')return {state:'unknown',remaining:null}
  const key=await resolveCatalogCredential(request,endpoint)
  endpoint.pathname='/api/v1/key';endpoint.search=''
  try {
    const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)})
    if(!response.ok)return {state:'unknown',remaining:null}
    return openRouterKeyQuota(await readLimitedJson(response))
  } catch {return {state:'unknown',remaining:null}}
}

/**
 * The model a chat turn should run on, as the message API wants it. Resolved
 * per send (not cached) so a settings save applies to the very next message.
 */
export async function resolveChatModel(): Promise<{ providerID: string; modelID: string }> {
  const { provider, model } = splitModel(chatModelRef(await readJson(configPath())))
  return { providerID: provider, modelID: model }
}

/**
 * (Re)writes Solar's agent team into an OpenCode config object: the two
 * image-enabled subagents the main coding agent delegates to. Called on every
 * setup save AND at app startup (so app updates refresh prompts/tools without
 * the user re-running setup — see ensureOpencodeConfig). Agents under other
 * names are the user's own and are left alone.
 *
 * Both subagents get the image model: their whole value over the main agent
 * is that they can actually see — the read tool returns image files as
 * attachments, and game_screenshot returns the rendered frame.
 */
export function applyAgentConfig(config: Record<string, unknown>, imageModelRef: string): void {
  const agents = agentEntries(config)

  agents[IMAGE_READER_AGENT] = {
    description:
      'Views image files and reports their contents in detail: user-attached references ' +
      '(saved under .solar/attachments/), game screenshots (saved under ' +
      '.solar/test-shots/), generated art, or any image in the project. ' +
      'Give it the image path(s) and the questions you need answered.',
    mode: 'subagent',
    model: imageModelRef,
    prompt:
      'You are the image-analysis specialist inside Solar, an AI game engine. Another ' +
      'agent that may not be able to see images delegates image questions to you. Open every ' +
      'image path you were given with the read tool, look carefully, and answer with a ' +
      'precise, complete description — the caller cannot see the image, so your words are ' +
      'all it gets.\n\n' +
      'Always cover, when relevant:\n' +
      '- Subject and composition: what is depicted, layout, camera/perspective (top-down, ' +
      'side view, isometric, ...).\n' +
      '- Art style: pixel art / vector / hand-drawn / 3D render, outline weight, shading, ' +
      'level of detail.\n' +
      '- Colors: the dominant palette with approximate hex values; whether the background ' +
      'is transparent.\n' +
      '- For game screenshots: apparent genre, HUD elements and their positions, visible ' +
      'mechanics, menus, and all text transcribed exactly.\n' +
      "- The caller's specific questions, answered directly.\n\n" +
      'If a path does not exist or is not an image, say so plainly. You only look and ' +
      'report — never modify anything.',
    // Look-and-report only: no editing, no shell, no game control, and no
    // question tool (subagent questions have no UI and would hang the turn).
    tools: {
      write: false,
      edit: false,
      patch: false,
      bash: false,
      task: false,
      question: false,
      todowrite: false,
      todoread: false,
      webfetch: false,
      websearch: false,
      'solar*': false,
      'genieengine*': false
    }
  }

  agents[GAME_TESTER_AGENT] = {
    description:
      'Plays and verifies the current game end-to-end: launches it (off-screen on macOS, in ' +
      'a separate window on Windows/Linux), sends scripted input, inspects scene tree / ' +
      'state / logs, and checks screenshots it can actually see. Use it after gameplay or ' +
      'visual changes instead of testing yourself; tell it what changed and what to verify, ' +
      'and it reports what works and what is broken.',
    mode: 'subagent',
    model: imageModelRef,
    prompt:
      'You are the game-testing specialist inside Solar, an AI game engine for Godot 4 ' +
      'games. You verify that the current project actually works by playing it with the ' +
      'Solar MCP tools, then report your findings. You never edit files — you test and ' +
      'report so the coding agent can fix.\n\n' +
      'Test procedure:\n' +
      '1. run_game_test — start the game (full engine, real rendering; off-screen on macOS, ' +
      'in its own visible window on Windows/Linux — the tools work the same either way).\n' +
      '2. game_logs — check for script errors right away; a broken launch is the most ' +
      'important finding of all.\n' +
      '3. game_scene_tree — discover node paths; game_state evaluates a GDScript expression ' +
      '(e.g. get_node("/root/Main/Score").text) to assert state cheaply.\n' +
      '4. game_input — drive the game with scripted keys/mouse (DOM-style key names like ' +
      '"ArrowLeft", "Space", "Enter"; mouse coordinates in game-view points from the ' +
      'top-left).\n' +
      '5. game_screenshot — capture and LOOK at the rendered frame: verify sprites and art ' +
      'actually display (no missing textures), the layout and HUD are right, and the visuals ' +
      'match what was asked. You can see images — use screenshots as real evidence.\n' +
      '6. Re-check game_logs after interacting, then ALWAYS stop_game_test when finished, ' +
      'even after failures.\n\n' +
      "Focus on what the caller asked you to verify, but always report launch errors. Read " +
      'the project source when you need to know which keys, nodes, or mechanics to ' +
      'exercise.\n\n' +
      'Budget: ' + gameTestBudgetInstructions() + ' Every screenshot makes ' +
      'later steps slower — a good test pass finishes in 10-20 tool calls with 2-4 ' +
      'screenshots. Be decisive: check each behavior once (twice at most for something ' +
      'flaky), and the moment a tool result shows a budget warning, stop probing, call ' +
      'stop_game_test, and write your report from the evidence you have. A finding you ' +
      'cannot fully pin down still belongs in the report — describe what you observed; ' +
      'do not keep re-testing it.\n\n' +
      'Report format: a one-line verdict first (works / broken), then evidence per checked ' +
      'item — the state values you probed, what the screenshots show, and any log errors ' +
      'verbatim. Give concrete reproduction steps for every failure. Do not speculate about ' +
      'fixes; describe precisely what is wrong.',
    // Test-and-report only: reading code is fine, changing it is the main
    // agent's job. Asset generation stays with the main agent too, and the
    // question tool would hang (no UI for subagent questions).
    tools: {
      write: false,
      edit: false,
      patch: false,
      bash: false,
      task: false,
      question: false,
      'solar_generate*': false,
      'genieengine_generate*': false
    }
  }

  config.agent = agents
}

export async function getSetupStatus(): Promise<SetupStatus> {
  await waitForSetupUpdate()
  const config = await readJson(configPath())
  const providers = providerEntries(config)
  const credentialStoreErrors: string[] = []
  const reportStoreError = (label: string, err: unknown): void => {
    const detail = err instanceof Error ? err.message : String(err)
    credentialStoreErrors.push(`${label}: ${detail}`)
  }

  // Configured if Solar has a secure credential, OpenCode has an existing
  // credential, or the provider's environment variable is set.
  const [auth, managedAuth, authBackup] = await Promise.all([
    readJson(authPath()),
    loadManagedProviderAuth().catch((err) => {
      reportStoreError('OpenCode credentials', err)
      return {} as Record<string, ProviderAuthEntry>
    }),
    latestAuthBackupStatus()
  ])
  const savedChatRefs = getChatModelRefs()
  const slotStatus = (slot: ModelSlotId, ref: string): ModelSlotStatus => {
    const { provider: providerId, model } = splitModel(ref)
    const provider = slotProviderIdForRef(slot, ref, config)
    // Thinking/effort live on the model declaration for adapters that accept
    // the generic values. Absence means 'default'.
    const options = (providers[providerId]?.models?.[model]?.options ?? {}) as Record<string, unknown>
    const saved = slot === 'medium' && savedChatRefs.chat === ref ? savedChatRefs : undefined
    const catalog = saved?.chatReasoningEfforts !== undefined
      ? { id: model, supportsImageInput: null, reasoningEfforts: saved.chatReasoningEfforts,
          reasoningBudgetMax: saved.chatReasoningBudgetMax,
          reasoningMode: saved.chatReasoningMode } satisfies ModelCatalogItem
      : undefined
    const supported = reasoningEffortsForModel(provider, model, catalog)
    const effort = storedEffort(provider, model, options, saved?.chatReasoningBudgetMax)
    return {
      provider,
      endpoint: slotEndpointForRef(ref, provider, config),
      model,
      configured: !!connectionCredential(slot,provider,slotEndpointForRef(ref,provider,config),config,managedAuth,auth),
      thinking: coerceThinking((options.thinking as { type?: unknown } | undefined)?.type),
      effort: effort === 'default' || supported?.includes(effort) ? effort : 'default',
      reasoningEfforts: supported,
      reasoningBudgetMax: saved?.chatReasoningBudgetMax ?? null,
      reasoningMode: saved?.chatReasoningMode ?? null
    }
  }

  const chatRef = chatModelRef(config)
  const chat = slotStatus('medium', chatRef)
  const image = slotStatus('image', configuredImageModel(config))
  const [hy3dConfigured, gptImageConfigured] = await Promise.all([
    isHy3dConfigured().catch((err) => {
      reportStoreError('Tencent credentials', err)
      return false
    }),
    isGptImageConfigured().catch((err) => {
      reportStoreError('OpenAI image credentials', err)
      return false
    })
  ])

  return {
    configured: chat.configured,
    chat,
    image,
    hy3dConfigured,
    gptImageConfigured,
    legacyOpenCodeCredentials: legacyCredentialCandidates(config, auth, managedAuth),
    latestOpenCodeAuthBackup: authBackup,
    ...(credentialStoreErrors.length ? { credentialStoreError: credentialStoreErrors.join('\n') } : {})
  }
}

/** Move explicitly selected active API keys out of the shared auth.json file. */
export function migrateLegacyOpenCodeCredentials(providerIds: string[]): Promise<void> {
  return mutateSetup(()=>migrateLegacyCredentials(providerIds))
}
async function migrateLegacyCredentials(providerIds: string[]): Promise<void> {
  if (!Array.isArray(providerIds) || providerIds.length > 64 || providerIds.some(id=>typeof id !== 'string' || id.length>100)) throw new Error('Invalid credential migration selection.')
  const selected = [...new Set(providerIds)]
  if (selected.length === 0) throw new Error('Select at least one credential to migrate.')

  const original = await readAuthFile()
  if (original === null) throw new Error('OpenCode auth.json was not found.')
  let parsed: unknown
  try {
    parsed = JSON.parse(original)
  } catch {
    throw new Error('OpenCode auth.json is not valid JSON; no credentials were changed.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode auth.json has an unsupported format; no credentials were changed.')
  }

  const auth = parsed as Record<string, unknown>
  const config = await readJson(configPath())
  const managedSnapshot = await managedAuthSnapshot()
  if (managedSnapshot.error) throw managedSnapshot.error
  const managedAuth = managedSnapshot.entries
  const candidates = new Map(
    legacyCredentialCandidates(config, auth, managedAuth).map((item) => [item.providerId, item])
  )
  for (const providerId of selected) {
    if (!candidates.has(providerId) || !apiCredential(auth[providerId])) {
      throw new Error(`The ${providerId} credential is no longer eligible for migration. Refresh settings and try again.`)
    }
  }

  const nextAuth = { ...auth }
  for (const providerId of selected) {
    const entry = auth[providerId] as AuthEntry
    const existing = managedAuth[providerId]
    if (existing && !sameCredentialPayload(existing, entry)) {
      throw new Error(`The encrypted ${providerId} credential differs from auth.json; the shared entry was preserved.`)
    }
    const active = ([['medium',chatModelRef(config)],['image',configuredImageModel(config)]] as [ModelSlotId,string][]).find(([,ref])=>splitModel(ref).provider===providerId)
    if (!active) throw new Error('The credential no longer belongs to an active model connection.')
    const provider = slotProviderIdForRef(active[0],active[1],config)
    managedAuth[providerId] = {...entry,solarConnection:boundApiCredential(normalizeApiKey(entry.key),provider,slotEndpointForRef(active[1],provider,config)).solarConnection}
    delete nextAuth[providerId]
  }

  const migrated = JSON.stringify(nextAuth, null, 2)
  const backupId = `${Date.now()}-${randomUUID()}`
  // Save the encrypted app copy and encrypted rollback snapshot before touching
  // the shared OpenCode file. Roll back the vault if any preparation step fails.
  const update = await prepareManagedProviderAuth(managedAuth,false,managedSnapshot.original)
  let committed = false
  try {
    await update.commit(); committed = true
    await writeAtomic(
      authBackupPath(backupId),
      encryptCredentialJson<AuthBackup>({ original, migrated }, safeStorage, process.platform)
    )
    await writeAtomic(authPath(), migrated, original)
  } catch (err) {
    if (committed) await update.rollback().catch(()=>{ throw new Error('Credential migration failed and its vault rollback could not finish. Newer credentials were preserved; reopen Settings.') })
    await rm(authBackupPath(backupId), { force: true }).catch(() => {})
    if (err instanceof Error && err.message.includes('file changed')) {
      throw new Error('OpenCode auth.json changed during migration. Its latest contents were preserved; retry the migration.')
    }
    throw err
  }
  restartChatForSettings()
}

/** Restore a migration snapshot only when auth.json has not changed afterward. */
export function restoreLegacyOpenCodeAuthBackup(backupId: string): Promise<void> {
  return mutateSetup(()=>restoreLegacyAuth(backupId))
}
async function restoreLegacyAuth(backupId: string): Promise<void> {
  const encrypted = await readFile(authBackupPath(backupId), 'utf8')
  const backup = decodeCredentialJson<AuthBackup>(encrypted, safeStorage, process.platform).value
  if (typeof backup.original !== 'string' || typeof backup.migrated !== 'string') {
    throw new Error('The OpenCode auth backup has an invalid format.')
  }
  try {
    await writeAtomic(authPath(), backup.original, backup.migrated)
  } catch (err) {
    if (err instanceof Error && err.message.includes('file changed')) {
      throw new Error('OpenCode auth.json has changed since migration. It was left untouched to protect newer credentials.')
    }
    throw err
  }
  restartChatForSettings()
}

/** One model slot's settings resolved against defaults and stored state. */
interface ResolvedSlot {
  id: 'medium' | 'image'
  title: string
  provider: ModelProviderId
  endpoint: string
  model: string
  /** The stable provider id this slot writes to from now on. */
  providerId: string
  /** Where the slot's credential lived before this save (for migration). */
  prevProviderId: string
  prevProvider: ModelProviderId
  /** The model the slot pointed at before this save (for option cleanup). */
  prevModel: string
  typedKey: string
  thinking: ThinkingMode
  effort: ReasoningEffort
  reasoningEfforts: Exclude<ReasoningEffort, 'default'>[] | null
  reasoningBudgetMax: number | null
  reasoningMode: ModelCatalogItem['reasoningMode']
}

/** An OpenCode auth entry, copied verbatim when a credential moves or is shared. */
type AuthEntry = ProviderAuthEntry

function mutateSetup(operation:()=>Promise<void>):Promise<void> {
  return withSetupMutation(async()=>{
    if (isChatBusy()) throw new Error('Stop the active AI task before updating its connection settings.')
    await operation()
  })
}
export function saveSetup(request: SetupRequest): Promise<void> { return mutateSetup(()=>saveSetupTransaction(request)) }
async function saveSetupTransaction(request: SetupRequest): Promise<void> {
  if (!request || typeof request !== 'object') throw new Error('Invalid AI settings request.')
  const tencentId = normalizeApiKey(request.tencentSecretId ?? '','Tencent SecretId')
  const tencentKey = normalizeApiKey(request.tencentSecretKey ?? '','Tencent SecretKey')
  const imageKey = normalizeApiKey(request.openaiApiKey ?? '')
  if (!!tencentId !== !!tencentKey) throw new Error('Both the Tencent SecretId and SecretKey are required.')
  const configFile = configPath()
  const { value: config, original: originalConfig } = await readJsonForUpdate(configFile)

  const resolve = (
    id: ResolvedSlot['id'],
    title: string,
    req: ModelSlotRequest,
    prevRef: string
  ): ResolvedSlot => {
    if (!req || !isModelProviderId(req.provider)) throw new Error(`Unsupported API provider for ${title}.`)
    if (typeof req.endpoint !== 'string' || req.endpoint.length > 2048 || typeof req.model !== 'string' || typeof req.apiKey !== 'string') throw new Error(`Invalid connection fields for ${title}.`)
    const provider = req.provider
    const endpoint = normalizedEndpoint(catalogEndpoint(req.endpoint, provider).href)
    const previous = splitModel(prevRef)
    const model = req.model.trim() || MODEL_PROVIDERS[provider].modelExamples[id]
    if (!model || model.length>256 || /\s|[\x00-\x1f\x7f]/.test(model) || /^(?:__proto__|constructor|prototype)$/.test(model) || model.startsWith('provider/')) throw new Error(`Enter a valid model ID for ${title}.`)
    if (req.reasoningEfforts !== undefined && req.reasoningEfforts !== null && (!Array.isArray(req.reasoningEfforts) || req.reasoningEfforts.length>5 || req.reasoningEfforts.some(level=>!['low','medium','high','xhigh','max'].includes(level)))) throw new Error('Invalid model capability data.')
    const reasoningBudgetMax = typeof req.reasoningBudgetMax === 'number' &&
      Number.isFinite(req.reasoningBudgetMax) && req.reasoningBudgetMax >= 1028 && req.reasoningBudgetMax <= 31999 &&
      (provider === 'openrouter' || provider === 'nvidia' || provider === 'anthropic')
      ? Math.floor(req.reasoningBudgetMax) : null
    const reasoningMode = provider === 'anthropic' &&
      ['adaptive', 'effort', 'budget'].includes(req.reasoningMode ?? '')
      ? req.reasoningMode : null
    const catalog = req.reasoningEfforts !== undefined
      ? { id: model, supportsImageInput: null, reasoningEfforts: req.reasoningEfforts,
          reasoningBudgetMax, reasoningMode } satisfies ModelCatalogItem
      : undefined
    const modelReasoningEfforts = reasoningEffortsForModel(provider, model, catalog)
    const requestedEffort = coerceEffort(req.effort)
    if (requestedEffort !== 'default' && !modelReasoningEfforts?.includes(requestedEffort)) {
      throw new Error(`${requestedEffort} reasoning effort is not available for ${model}.`)
    }
    return {
      id,
      title,
      provider,
      endpoint,
      model,
      // OpenRouter's native provider gives chat models catalog metadata and a
      // single shared credential. Other combinations use a slot + provider
      // scoped ID so switching vendors never reuses the wrong key or protocol.
      providerId:
        id !== 'image' && provider === 'openrouter' && isOpenRouterEndpoint(endpoint)
          ? OPENROUTER_PROVIDER
          : modelProviderRefId(id, provider),
      prevProviderId: previous.provider,
      prevProvider: slotProviderIdForRef(id, prevRef, config),
      prevModel: previous.model,
      typedKey: normalizeApiKey(req.apiKey),
      thinking: coerceThinking(req.thinking),
      reasoningEfforts: modelReasoningEfforts,
      reasoningBudgetMax,
      reasoningMode,
      effort: compatibleReasoningEffort(requestedEffort, modelReasoningEfforts)
    }
  }
  // Order matters twice below: auth writes (first typed key into a shared
  // provider wins) and key sharing (earlier slots donate to later ones).
  const slots = [
    resolve('medium', 'Chat model endpoint', request.chat, chatModelRef(config)),
    resolve('image', 'Image model endpoint', request.image, configuredImageModel(config))
  ]
  const [chatModel, image] = slots

  // OpenRouter's built-in provider has one shared credential entry. Refuse
  // conflicting per-slot keys rather than silently discarding the later one.
  const typedKeys = new Map<string, { key: string; title: string }>()
  for (const slot of slots) {
    if (!slot.typedKey) continue
    const previous = typedKeys.get(slot.providerId)
    if (previous && previous.key !== slot.typedKey) {
      throw new Error(`${previous.title} and ${slot.title} use one shared provider credential; enter the same API key for both.`)
    }
    typedKeys.set(slot.providerId, { key: slot.typedKey, title: slot.title })
  }
  // 1. Credentials → Solar's encrypted store. Existing auth.json entries
  //    remain available as a fallback for credentials created outside the app.
  //    Each slot resolves to its OWN entry so no
  //    save can clobber another slot's key (the old shared-slot scheme let a
  //    chat-key update wipe the image credential):
  //     a. a key typed this save wins (first writer for a shared chat id);
  //     b. else an entry already stored under the slot's id is kept as-is;
  //     c. else the entry under the slot's PREVIOUS id is copied over only if
  //        both provider family and endpoint still match;
  //     d. else a same-provider, same-endpoint slot's entry is copied — the
  //        "leave blank to use another model slot's key" flow, as a copy.
  const auth = await readJson(authPath())
  let recoveringAuth = false
  const authSnapshot = await managedAuthSnapshot()
  if (authSnapshot.error) {
    if (!chatModel.typedKey) throw authSnapshot.error
    recoveringAuth = true
  }
  const managedAuth = authSnapshot.entries
  const pendingAuth = new Map<string, AuthEntry>()
  const entryFor = (providerId: string): AuthEntry | undefined =>
    pendingAuth.get(providerId) ??
    (apiCredential(managedAuth[providerId]) ? managedAuth[providerId] : undefined) ??
    (apiCredential(auth[providerId]) ? auth[providerId] as AuthEntry : undefined)
  const envEntry = (providerId: string): AuthEntry | undefined => {
    try { const key = normalizeApiKey(process.env[providerEnvVar(providerId)] ?? ''); return key ? { type: 'api', key } : undefined }
    catch { return undefined }
  }
  // What a provider id served BEFORE this save (the entries are rebuilt below).
  const endpointBefore = (slot: ResolvedSlot): string =>
    slotEndpointForRef(`${slot.prevProviderId}/${slot.prevModel}`, slot.prevProvider, config)

  const validEntries = new Map<ResolvedSlot['id'], AuthEntry>()
  for (const slot of slots) {
    if (slot.typedKey) {
      const entry = boundApiCredential(slot.typedKey,slot.provider,slot.endpoint)
      pendingAuth.set(slot.providerId, entry)
      validEntries.set(slot.id, entry)
      continue
    }
    let sameConnection = false
    try {
      sameConnection = slot.prevProvider === slot.provider &&
        normalizedEndpoint(endpointBefore(slot)) === slot.endpoint
    } catch {
      // A damaged old endpoint must not make it impossible to save a new one.
    }
    const bound = entryFor(slot.providerId)
    const newDonor = slots.some(candidate=>candidate!==slot && candidate.typedKey && candidate.provider===slot.provider && candidate.endpoint===slot.endpoint)
    if (bound && credentialMatchesConnection(bound,slot.provider,slot.endpoint) && (sameConnection || !newDonor)) {
      validEntries.set(slot.id,bound); continue
    }
    if (!sameConnection) continue
    const previous = entryFor(slot.prevProviderId) ?? envEntry(slot.prevProviderId)
    if (!previous) continue
    if (!credentialMatchesConnection(previous,slot.provider,slot.endpoint,endpointBefore(slot))) continue
    validEntries.set(slot.id, previous)
    pendingAuth.set(slot.providerId,boundApiCredential(normalizeApiKey(previous.key),slot.provider,slot.endpoint))
  }
  for (const slot of slots) {
    if (validEntries.has(slot.id)) continue
    const donor = slots.find((candidate) => candidate !== slot &&
      candidate.provider === slot.provider && candidate.endpoint === slot.endpoint && validEntries.has(candidate.id))
    const donated = donor ? validEntries.get(donor.id) : undefined
    if (donated) {
      const entry = boundApiCredential(normalizeApiKey(donated.key),slot.provider,slot.endpoint)
      pendingAuth.set(slot.providerId, entry)
      validEntries.set(slot.id, entry)
    }
  }
  for (const slot of slots) {
    if (validEntries.has(slot.id)) continue
    const existing = connectionCredential(slot.id,slot.provider,slot.endpoint,config,managedAuth,auth)
    if (existing) {
      const entry = boundApiCredential(normalizeApiKey(existing.key),slot.provider,slot.endpoint)
      pendingAuth.set(slot.providerId,entry); validEntries.set(slot.id,entry); continue
    }
    if (slot.id === 'medium' || entryFor(slot.providerId)) {
      throw new Error(`Enter an API key for ${slot.title} after changing its provider or API base URL.`)
    }
  }
  if (pendingAuth.size) {
    for (const [providerId, entry] of pendingAuth) managedAuth[providerId] = entry
  }

  // 2. Endpoints + models + agents → global OpenCode config (preserving mcp
  //    etc.). config.model tracks Solar's one chat model so OpenCode runs
  //    outside the app use the same model as the in-app assistant.
  config.model = `${chatModel.providerId}/${chatModel.model}`

  const providers = providerEntries(config)
  // Rebuild our provider entries from scratch so stale adapters can't shadow
  // the newly selected API family. OpenRouter chat on its default endpoint
  // uses the built-in provider; other slots receive isolated custom IDs.
  delete providers[LEGACY_CUSTOM_PROVIDER]
  delete providers[MEDIUM_PROVIDER]
  delete providers[LARGE_PROVIDER]
  delete providers[IMAGE_PROVIDER]
  for (const slotId of ['medium', 'large', 'image'] as const) {
    for (const provider of Object.keys(MODEL_PROVIDERS) as ModelProviderId[]) {
      delete providers[modelProviderRefId(slotId, provider)]
      delete providers[`genieengine-${slotId}-${provider}`]
    }
  }
  for (const slot of slots) {
    if (slot.providerId === OPENROUTER_PROVIDER) continue
    const options = wireOptions(slot.thinking, slot.effort, slot.provider, slot.model, slot.reasoningBudgetMax, slot.reasoningMode)
    const npm = slot.provider === 'openrouter'
      ? MODEL_PROVIDERS.openrouter.npm
      : MODEL_PROVIDERS[slot.provider].npm
    providers[slot.providerId] = {
      npm,
      name: `${MODEL_PROVIDERS[slot.provider].label} — ${slot.title}`,
      options: { baseURL: slot.endpoint },
      // Models on openai-compatible entries aren't in models.dev, so they
      // must be declared. The image model additionally declares image input —
      // without it OpenCode assumes an unknown model can't see and strips
      // image parts before they ever reach the subagents.
      models: {
        [slot.model]: {
          name: slot.model,
          ...(slot.id === 'image'
            ? { attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } }
            : {}),
          ...(options ? { options } : {})
        }
      }
    }
  }

  // Chat model on the built-in `openrouter` provider carries its
  // thinking/effort options on a partial provider entry merged over the
  // built-in one. The entry may hold the user's own customizations, so only
  // the managed keys of models our slots point (or pointed) at are touched:
  // strip them first, then write the current chat model's choices.
  const managedModels = new Set<string>()
  for (const slot of slots) {
    if (slot.prevProviderId === OPENROUTER_PROVIDER) managedModels.add(slot.prevModel)
    if (slot.providerId === OPENROUTER_PROVIDER) managedModels.add(slot.model)
  }
  const previousRefs = getChatModelRefs()
  for (const ref of [previousRefs.medium, previousRefs.large]) {
    if (typeof ref !== 'string') continue
    const previous = splitModel(ref)
    if (previous.provider === OPENROUTER_PROVIDER) managedModels.add(previous.model)
  }
  const openrouterModels = providers[OPENROUTER_PROVIDER]?.models
  if (openrouterModels) {
    for (const modelId of managedModels) {
      const declaration = openrouterModels[modelId]
      const options = declaration?.options as Record<string, unknown> | undefined
      if (!options) continue
      delete options.thinking
      clearManagedReasoningOptions(options)
      if (!Object.keys(options).length) delete declaration.options
      if (!Object.keys(declaration).length) delete openrouterModels[modelId]
    }
    if (!Object.keys(openrouterModels).length) delete providers[OPENROUTER_PROVIDER]?.models
    if (!Object.keys(providers[OPENROUTER_PROVIDER] ?? { keep: 1 }).length) delete providers[OPENROUTER_PROVIDER]
  }
  for (const slot of slots) {
    if (slot.providerId !== OPENROUTER_PROVIDER) continue
    const native = (providers[OPENROUTER_PROVIDER] ??= {})
    native.options = {...native.options,baseURL:slot.endpoint}
    const options = wireOptions(slot.thinking, slot.effort, 'openrouter', slot.model, slot.reasoningBudgetMax, slot.reasoningMode)
    if (!options) continue
    const entry = (providers[OPENROUTER_PROVIDER] ??= {})
    const models = (entry.models ??= {})
    const declaration = (models[slot.model] ??= {})
    const updated = { ...(declaration.options as Record<string, unknown> | undefined) }
    applyWireOptions(updated, options)
    declaration.options = updated
  }

  if (Object.keys(providers).length) config.provider = providers
  else delete config.provider

  applyAgentConfig(config, `${image.providerId}/${image.model}`)

  if (!config.$schema) config.$schema = 'https://opencode.ai/config.json'
  // Prepare every encrypted write before committing any setting. Roll back
  // exact committed bytes on ordinary failures; never overwrite a newer file.
  const updates: CredentialUpdate[] = []
  if (pendingAuth.size) updates.push(await prepareManagedProviderAuth(managedAuth,recoveringAuth,authSnapshot.original))
  const imageUpdate = await prepareGptImageConfig(imageKey)
  const hy3dUpdate = await prepareHy3dCredentials(tencentId,tencentKey)
  if (imageUpdate) updates.push(imageUpdate)
  if (hy3dUpdate) updates.push(hy3dUpdate)
  // Check new model keys without paid generation after capturing every file
  // precondition. Catalogs do not prove model access; auth failures block save.
  // A custom gateway may legitimately omit /models.
  const checking = new AbortController()
  try { await Promise.all(slots.filter(slot=>pendingAuth.has(slot.providerId)).map(async slot=>{
    try {
      const catalog = await listModelIds({slot:slot.id,provider:slot.provider,endpoint:slot.endpoint,apiKey:normalizeApiKey(validEntries.get(slot.id)?.key)},checking.signal)
      const model = catalog.find(item=>item.id===slot.model)
      if (slot.id==='image' && model?.supportsImageInput===false) throw new Error('The selected image model does not support image input. Choose an image-capable model.')
    } catch(error) {
      if (slot.provider==='custom' && error instanceof CatalogConnectionError && [404,405,501].includes(error.status??0)) return
      throw new Error(`${slot.title}: ${error instanceof Error?error.message:'Provider check failed.'}`)
    }
  })) } catch(error) { checking.abort(); throw error }
  const contents = JSON.stringify(config,null,2)
  let configSaved = false
  try {
    for (const update of updates) await update.commit()
    await writeAtomic(configFile,contents,originalConfig); configSaved = true
    setChatModelRefs({
      chat: `${chatModel.providerId}/${chatModel.model}`,
      chatReasoningEfforts: chatModel.reasoningEfforts,
      chatReasoningBudgetMax: chatModel.reasoningBudgetMax,
      chatReasoningMode: chatModel.reasoningMode
    })
  } catch (err) {
    const failures: unknown[] = []
    if (configSaved) {
      try {
        if (originalConfig !== null) await writeAtomic(configFile,originalConfig,contents)
        else { if (await readFile(configFile,'utf8') !== contents) throw new Error('A newer configuration was preserved.'); await rm(configFile,{force:true}) }
      } catch (error) { failures.push(error) }
    }
    for (const update of [...updates].reverse()) try { await update.rollback() } catch (error) { failures.push(error) }
    if (failures.length) throw new Error('The settings save failed and some files could not be restored. Newer files were preserved. Reopen Settings before trying again.')
    if (err instanceof Error && err.message.includes('file changed')) {
      throw new Error('OpenCode config changed while settings were being saved. Its latest contents were preserved; retry the save.')
    }
    throw err
  }

  // 3. Drop the stale chat server so the next message picks up the new config.
  restartChatForSettings()
}

/** Update only the active chat model's reasoning option from the composer. */
export function setChatReasoningEffort(value: ReasoningEffort): Promise<void> { return mutateSetup(()=>saveChatReasoningEffort(value)) }
async function saveChatReasoningEffort(value: ReasoningEffort): Promise<void> {
  const effort = coerceEffort(value)
  if (effort !== value) throw new Error('Unsupported reasoning effort.')

  const configFile = configPath()
  const { value: config, original } = await readJsonForUpdate(configFile)
  const ref = chatModelRef(config)
  const { provider: providerId, model } = splitModel(ref)
  const provider = slotProviderIdForRef('medium', ref, config)
  const refs = getChatModelRefs()
  const saved = refs.chat === ref ? refs : undefined
  const catalog = saved?.chatReasoningEfforts !== undefined
    ? { id: model, supportsImageInput: null, reasoningEfforts: saved.chatReasoningEfforts,
        reasoningBudgetMax: saved.chatReasoningBudgetMax,
        reasoningMode: saved.chatReasoningMode } satisfies ModelCatalogItem
    : undefined
  const supported = reasoningEffortsForModel(provider, model, catalog)
  if (effort !== 'default' && !supported?.includes(effort)) {
    throw new Error(`${effort} reasoning effort is not available for ${model}.`)
  }

  const providers = providerEntries(config)
  const entry = (providers[providerId] ??= {})
  const models = (entry.models ??= {})
  const declaration = (models[model] ??= { name: model })
  const options = { ...(declaration.options as Record<string, unknown> | undefined) }
  clearManagedReasoningOptions(options, provider)
  applyWireOptions(options, wireOptions('default', effort, provider, model, saved?.chatReasoningBudgetMax, saved?.chatReasoningMode))
  if (Object.keys(options).length) declaration.options = options
  else delete declaration.options

  if (Object.keys(providers).length) config.provider = providers
  else delete config.provider
  await writeAtomic(configFile, JSON.stringify(config, null, 2), original)
  restartChatForSettings()
}
