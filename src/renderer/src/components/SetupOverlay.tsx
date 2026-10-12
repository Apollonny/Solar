import { useEffect, useRef, useState } from 'react'
import type {
  ModelCatalogRequest,
  ModelCatalogItem,
  ModelSlotId,
  ModelSlotRequest,
  ModelSlotStatus,
  ModelProviderId,
  ReasoningEffort,
  SetupStatus,
  ThinkingMode
} from '../../../shared/types'
import { MODEL_PROVIDERS, MODEL_PROVIDER_IDS } from '../../../shared/model-providers'
import { canonicalApiEndpoint, normalizeApiKey } from '../../../shared/provider-connection'
import {
  compatibleReasoningEffort,
  reasoningEffortsForModel,
  REASONING_EFFORT_CHOICES
} from '../../../shared/model-reasoning'
import { SparkIcon, XIcon } from './Icons'

interface Props {
  status: SetupStatus
  onConfigured: (status: SetupStatus) => void
  /** AI setup is optional, so the user can always return to the editor. */
  onClose?: () => void
}

type SetupTab = 'agent' | '2d' | '3d'

const TABS: { id: SetupTab; label: string }[] = [
  { id: 'agent', label: 'Models' },
  { id: '2d', label: '2D Asset Generation (Optional)' },
  { id: '3d', label: '3D Asset Generation (Optional)' }
]

/** Mirrors the main process default for legacy blank endpoint values. */
const OPENROUTER_ENDPOINT = MODEL_PROVIDERS.openrouter.endpoint

/** The visible model slots: one chat model and the optional image helper. */
type SlotId = Exclude<ModelSlotId, 'large'>

/** The single assistant model and the optional image helper model. */
const MODEL_SLOTS: { id: SlotId; title: string; hint: string; modelPlaceholder: string }[] = [
  {
    id: 'medium',
    title: 'Chat model',
    hint: 'The model used for every assistant conversation. Choose its reasoning effort below to control how much work it spends on each response.',
    modelPlaceholder: 'deepseek/deepseek-v4-pro'
  },
  {
    id: 'image',
    title: 'Image model',
    hint: 'Runs the assistant’s image helpers — reading images you attach and play-testing your game with screenshots — so it must accept image input.',
    modelPlaceholder: 'moonshotai/kimi-k2.7-code'
  }
]

/** One model section's editable state (its key input stays hidden until revealed). */
interface SlotState {
  provider: ModelProviderId
  endpoint: string
  model: string
  apiKey: string
  thinking: ThinkingMode
  effort: ReasoningEffort
  /** True once the user asked to change an already-stored key. */
  keyRevealed: boolean
}

function initSlot(stored: ModelSlotStatus, defaultEffort: ReasoningEffort = stored.effort): SlotState {
  // An already-configured credential starts hidden behind a button — the
  // field only appears once the user explicitly asks to change it, so
  // opening the panel and hitting Save can never blank out a stored key.
  return {
    provider: stored.provider,
    endpoint: stored.endpoint,
    model: stored.model,
    apiKey: '',
    thinking: stored.thinking,
    effort: stored.effort === 'default' ? defaultEffort : stored.effort,
    keyRevealed: !stored.configured
  }
}

/**
 * Stands in for a credential input once it's already configured, so a
 * stored key is never blanked out by opening the panel and hitting Save —
 * the actual field only appears once the user asks to change it.
 */
function ConfiguredButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="btn btn-ghost setup-configured-btn" onClick={onClick}>
      Already configured. Click to update.
    </button>
  )
}

/**
 * One model's connection settings: endpoint + model + API key. The chat model
 * also exposes the reasoning effort used for every assistant conversation.
 */
function ModelSection(props: {
  title: string
  hint: string
  provider: ModelProviderId
  onProvider: (v: ModelProviderId) => void
  endpoint: string
  onEndpoint: (v: string) => void
  model: string
  onModel: (v: string) => void
  modelPlaceholder: string
  slot: SlotId
  availableModels: ModelCatalogItem[]
  loadingModels: boolean
  catalogNotice: string
  onLoadModels: () => void
  effort: ReasoningEffort
  reasoningEfforts: Exclude<ReasoningEffort, 'default'>[] | null
  onEffort: (v: ReasoningEffort) => void
  showEffort: boolean
  apiKey: string
  onApiKey: (v: string) => void
  keyPlaceholder: string
  /** True while a stored key stays hidden behind the "already configured" button. */
  keyHidden: boolean
  /** Focus the key input when it appears (i.e. right after the reveal click). */
  keyAutoFocus?: boolean
  onRevealKey: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const selectedCatalogModel = props.availableModels.find((item) => item.id === props.model.trim())
  const supportedEfforts = props.reasoningEfforts
  const effortChoices = REASONING_EFFORT_CHOICES.filter(({ value }) => supportedEfforts?.includes(value))
  const currentEffort = compatibleReasoningEffort(props.effort, supportedEfforts)

  return (
    <div className="setup-section">
      <div>
        <span className="setup-section-title">{props.title}</span>
        <p className="setup-hint">{props.hint}</p>
      </div>

      <label className="setup-field">
        <span className="setup-label">API provider</span>
        <select
          className="setup-select"
          value={props.provider}
          onChange={(e) => props.onProvider(e.target.value as ModelProviderId)}
        >
          {MODEL_PROVIDER_IDS.map((provider) => (
            <option key={provider} value={provider}>
              {MODEL_PROVIDERS[provider].label}
            </option>
          ))}
        </select>
      </label>

      <label className="setup-field">
        <span className="setup-label">API base URL</span>
        <input
          className="text-input"
          value={props.endpoint}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => props.onEndpoint(e.target.value)}
          placeholder={MODEL_PROVIDERS[props.provider].endpoint || OPENROUTER_ENDPOINT}
        />
      </label>

      <div className="setup-field">
        <span className="setup-label">Model</span>
        <div className="setup-model-row">
          <input
            className="text-input"
            value={props.model}
            list={`genie-models-${props.slot}`}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => props.onModel(e.target.value)}
            placeholder={props.modelPlaceholder}
          />
          <button
            type="button"
            className="btn btn-ghost setup-model-load"
            onClick={props.onLoadModels}
            disabled={props.loadingModels}
            title="Verify the provider connection and load available model IDs"
          >
            {props.loadingModels ? 'Checking…' : 'Check & load'}
          </button>
        </div>
        <datalist id={`genie-models-${props.slot}`}>
          {props.availableModels.map(({ id }) => <option key={id} value={id} />)}
        </datalist>
        {props.catalogNotice && <p className="setup-hint" role="status">{props.catalogNotice}</p>}
        {props.slot === 'image' && props.availableModels.length > 0 && (
          <p
            className={`setup-hint setup-capability${selectedCatalogModel?.supportsImageInput === true
              ? ' supported'
              : selectedCatalogModel?.supportsImageInput === false
                ? ' unsupported'
                : ''}`}
            role="status"
          >
            {selectedCatalogModel?.supportsImageInput === true
              ? 'Image input is supported by this model.'
              : selectedCatalogModel?.supportsImageInput === false
                ? 'This model does not advertise image input. The image helpers may not work.'
                : 'Image-input support is unverified for this model. Check the provider’s model documentation.'}
          </p>
        )}
      </div>

      {props.showEffort && effortChoices.length > 0 && <label
        className="setup-field"
        title="Controls how much reasoning effort the model spends on a response. The available levels follow this model's capabilities."
      >
        <span className="setup-label">Reasoning effort</span>
        <select
          className="setup-select"
          value={currentEffort}
          onChange={(e) => props.onEffort(e.target.value as ReasoningEffort)}
        >
          <option value="default">Model default</option>
          {effortChoices.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <p className="setup-hint">
          Higher effort can improve complex tasks and use more time or tokens.
          {` Available for this model: ${effortChoices.map(({ label }) => label).join(', ')}.`}
        </p>
      </label>}
      {props.showEffort && effortChoices.length === 0 && (
        <p className="setup-hint setup-capability unsupported" role="status">
          {supportedEfforts === null
            ? 'Reasoning levels are unverified for this model. The provider default will be used.'
            : 'This model does not expose an adjustable reasoning effort. The provider default will be used.'}
        </p>
      )}

      <div className="setup-field">
        <span className="setup-label">API key</span>
        {props.keyHidden ? (
          <ConfiguredButton onClick={props.onRevealKey} />
        ) : (
          <input
            className="text-input"
            type="password"
            value={props.apiKey}
            spellCheck={false}
            autoComplete="off"
            autoFocus={props.keyAutoFocus}
            onChange={(e) => props.onApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && props.onSubmit()}
            placeholder={props.keyPlaceholder}
          />
        )}
        {MODEL_PROVIDERS[props.provider].apiKeyHelpUrl && (
          <p className="setup-hint">
            Create an API key at{' '}
            <a href={MODEL_PROVIDERS[props.provider].apiKeyHelpUrl} target="_blank" rel="noreferrer">
              NVIDIA Build
            </a>.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * AI provider setup, shown over a darkened chat until the assistant is
 * connected (and reopenable later from the sidebar gear). Three tabs:
 * one chat model and the image-enabled model behind the image-reader and game-tester
 * subagents), optional 2D asset generation (OpenAI gpt-image-1.5) and
 * optional 3D asset generation (Tencent HY 3D).
 */
export function SetupOverlay({ status, onConfigured, onClose }: Props): React.JSX.Element {
  const [tab, setTab] = useState<SetupTab>('agent')
  const [slots, setSlots] = useState<Record<SlotId, SlotState>>(() => ({
    medium: initSlot(status.chat),
    image: initSlot(status.image)
  }))
  const [tencentId, setTencentId] = useState('')
  const [tencentKey, setTencentKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null)
  const [legacySelection, setLegacySelection] = useState<string[]>([])
  const [availableModels, setAvailableModels] = useState<Record<SlotId, ModelCatalogItem[]>>({ medium: [], image: [] })
  const [loadingModels, setLoadingModels] = useState<Record<SlotId, boolean>>({ medium: false, image: false })
  const [catalogNotice, setCatalogNotice] = useState<Record<SlotId, string>>({ medium: '', image: '' })
  const catalogGeneration = useRef<Record<SlotId, number>>({ medium: 0, image: 0 })
  const mutationPending = useRef(false)

  const [tencentRevealed, setTencentRevealed] = useState(!status.hy3dConfigured)
  const [openaiKeyRevealed, setOpenaiKeyRevealed] = useState(!status.gptImageConfigured)

  useEffect(() => {
    const available = new Set(status.legacyOpenCodeCredentials.map((credential) => credential.providerId))
    setLegacySelection((selected) => selected.filter((providerId) => available.has(providerId)))
  }, [status.legacyOpenCodeCredentials])

  const updateSlot = (id: SlotId, patch: Partial<SlotState>): void =>
    { if (!mutationPending.current) setSlots((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } })) }

  const statusSlots: Record<SlotId, ModelSlotStatus> = { medium: status.chat, image: status.image }

  const catalogForSlot = (id: SlotId, model = slots[id].model): ModelCatalogItem | undefined => {
    const item = availableModels[id].find((candidate) => candidate.id === model.trim())
    if (item) return item
    const stored = statusSlots[id]
    return stored.provider === slots[id].provider && stored.model === model.trim() &&
      norm(stored.endpoint, stored.provider) === norm(slots[id].endpoint, slots[id].provider)
      ? { id: model.trim(), supportsImageInput: null, reasoningEfforts: stored.reasoningEfforts,
          reasoningBudgetMax: stored.reasoningBudgetMax, reasoningMode: stored.reasoningMode }
      : undefined
  }

  const reasoningForSlot = (id: SlotId, model = slots[id].model): Exclude<ReasoningEffort, 'default'>[] | null =>
    reasoningEffortsForModel(slots[id].provider, model, catalogForSlot(id, model))

  const resetModelCatalog = (id: SlotId): void => {
    catalogGeneration.current[id] += 1
    setAvailableModels((prev) => ({ ...prev, [id]: [] }))
    setLoadingModels((prev) => ({ ...prev, [id]: false }))
    setCatalogNotice((prev) => ({ ...prev, [id]: '' }))
  }

  const norm = (endpoint: string, provider: ModelProviderId): string => {
    try { return canonicalApiEndpoint(endpoint,provider) }
    catch { return endpoint.trim() || MODEL_PROVIDERS[provider].endpoint }
  }

  const updateProvider = (id: SlotId, provider: ModelProviderId): void => {
    if (mutationPending.current) return
    for (const {id:slotId} of MODEL_SLOTS) resetModelCatalog(slotId)
    setSlots((prev) => {
      const current = prev[id]
      if (current.provider === provider) return prev
      const isSuggestedModel = MODEL_PROVIDER_IDS.some((knownProvider) =>
        Object.values(MODEL_PROVIDERS[knownProvider].modelExamples).includes(current.model)
      )
      const usedDefaultEndpoint = norm(current.endpoint, current.provider) === norm('', current.provider)
      const model = isSuggestedModel ? MODEL_PROVIDERS[provider].modelExamples[id] : current.model
      return {
        ...prev,
        [id]: {
          ...current,
          provider,
          endpoint: usedDefaultEndpoint ? MODEL_PROVIDERS[provider].endpoint : current.endpoint,
          model,
          effort: compatibleReasoningEffort(current.effort, reasoningEffortsForModel(provider, model)),
          // A key belongs to a provider family. Reveal the field when changing
          // providers so a previous provider's key is never sent by accident.
          apiKey: '',
          keyRevealed: true
        }
      }
    })
  }

  const loadModelIds = async (id: SlotId): Promise<void> => {
    if (mutationPending.current) return
    const generation = ++catalogGeneration.current[id]
    const slot = slots[id]
    const donor = MODEL_SLOTS.find(
      (candidate) => candidate.id !== id &&
        slots[candidate.id].provider === slot.provider &&
        norm(slots[candidate.id].endpoint, slot.provider) === norm(slot.endpoint, slot.provider) &&
        !!slots[candidate.id].apiKey.trim()
    )
    const request: ModelCatalogRequest = {
      slot: id,
      provider: slot.provider,
      endpoint: slot.endpoint,
      apiKey: slot.apiKey.trim() || (!hasOwnKey(id) && donor ? slots[donor.id].apiKey : '')
    }
    setLoadingModels((prev) => ({ ...prev, [id]: true }))
    setCatalogNotice((prev) => ({ ...prev, [id]: '' }))
    try {
      const result = await window.api.listModelIds(request)
      if (generation !== catalogGeneration.current[id]) return
      if (!result.ok) {
        setAvailableModels((prev) => ({ ...prev, [id]: [] }))
        setCatalogNotice((prev) => ({ ...prev, [id]: result.error }))
      } else {
        setAvailableModels((prev) => ({ ...prev, [id]: result.data }))
        setSlots((prev) => {
          const current = prev[id]
          if (current.provider !== slot.provider ||
              norm(current.endpoint, current.provider) !== norm(slot.endpoint, slot.provider)) return prev
          const item = result.data.find((candidate) => candidate.id === current.model.trim())
          if (!item) return prev
          const effort = compatibleReasoningEffort(current.effort,
            reasoningEffortsForModel(current.provider, current.model, item))
          return effort === current.effort ? prev : { ...prev, [id]: { ...current, effort } }
        })
        setCatalogNotice((prev) => ({ ...prev, [id]: `Catalog loaded · ${result.data.length} models available. This does not verify generation access to the selected model.` }))
      }
    } catch (err) {
      if (generation === catalogGeneration.current[id]) {
        setAvailableModels((prev) => ({ ...prev, [id]: [] }))
        setCatalogNotice((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }))
      }
    } finally {
      if (generation === catalogGeneration.current[id]) {
        setLoadingModels((prev) => ({ ...prev, [id]: false }))
      }
    }
  }

  useEffect(() => {
    if (status.chat.configured) void loadModelIds('medium')
    return () => { catalogGeneration.current.medium++; catalogGeneration.current.image++ }
    // Refresh the active model's catalog once when settings opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A key can be reused only while its provider and endpoint still match.
  const hasOwnKey = (id: SlotId): boolean =>
    !!slots[id].apiKey.trim() ||
    (statusSlots[id].configured &&
      slots[id].provider === statusSlots[id].provider &&
      norm(slots[id].endpoint, slots[id].provider) === norm(statusSlots[id].endpoint, statusSlots[id].provider))

  const keyPlaceholder = (id: SlotId): string => {
    if (
      statusSlots[id].configured &&
      slots[id].provider === statusSlots[id].provider &&
      norm(slots[id].endpoint, slots[id].provider) === norm(statusSlots[id].endpoint, statusSlots[id].provider)
    ) {
      return 'Leave blank to keep the stored key'
    }
    const donor = MODEL_SLOTS.find(
      (other) =>
        other.id !== id &&
        slots[other.id].provider === slots[id].provider &&
        norm(slots[other.id].endpoint, slots[other.id].provider) === norm(slots[id].endpoint, slots[id].provider) &&
        hasOwnKey(other.id)
    )
    if (donor) {
      return `Leave blank to reuse a matching key or copy the ${donor.title} key`
    }
    return id === 'medium' && !status.chat.configured ? 'Your API key' : `API key for ${MODEL_PROVIDERS[slots[id].provider].label}`
  }

  // Save applies every tab at once, so a validation error may concern a tab
  // the user isn't looking at — switch to it so the message makes sense.
  const fail = (message: string, where: SetupTab): void => {
    setError(message)
    setTab(where)
  }
  const beginMutation = (): boolean => {
    if (mutationPending.current) return false
    mutationPending.current = true
    for (const {id} of MODEL_SLOTS) resetModelCatalog(id)
    setBusy(true);setError(null)
    return true
  }
  const acceptStatus = (next:SetupStatus):void => {
    setSlots({medium:initSlot(next.chat),image:initSlot(next.image)})
    setTencentId('');setTencentKey('');setOpenaiKey('')
    setTencentRevealed(!next.hy3dConfigured);setOpenaiKeyRevealed(!next.gptImageConfigured)
    onConfigured(next)
  }

  const migrateLegacyCredentials = async (): Promise<void> => {
    if (legacySelection.length === 0 || !beginMutation()) return
    setMigrationNotice(null)
    try {
      const result = await window.api.migrateLegacyOpenCodeCredentials(legacySelection)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onConfigured(result.data)
      setLegacySelection([])
      setMigrationNotice('Selected credentials were moved. An encrypted restore backup is available below.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      mutationPending.current = false
      setBusy(false)
    }
  }

  const restoreLegacyAuth = async (): Promise<void> => {
    const backup = status.latestOpenCodeAuthBackup
    if (!backup?.restorable || !beginMutation()) return
    setMigrationNotice(null)
    try {
      const result = await window.api.restoreLegacyOpenCodeAuthBackup(backup.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onConfigured(result.data)
      setMigrationNotice('OpenCode auth.json was restored from its encrypted backup.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      mutationPending.current = false
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (mutationPending.current) return
    for (const { id, title } of MODEL_SLOTS) {
      try { normalizeApiKey(slots[id].apiKey);canonicalApiEndpoint(slots[id].endpoint,slots[id].provider) }
      catch(err) { fail(`${title}: ${err instanceof Error?err.message:'Invalid connection settings.'}`,'agent');return }
      if (!slots[id].model.trim() || slots[id].model.startsWith('provider/')) {
        fail(`Enter a valid model ID for "${title}".`, 'agent')
        return
      }
    }
    try { normalizeApiKey(openaiKey) }
    catch(err) { fail(`OpenAI image key: ${err instanceof Error?err.message:'Invalid key.'}`,'2d');return }
    try { normalizeApiKey(tencentId,'Tencent SecretId');normalizeApiKey(tencentKey,'Tencent SecretKey') }
    catch(err) { fail(err instanceof Error?err.message:'Invalid Tencent credentials.','3d');return }
    if (!!tencentId.trim() !== !!tencentKey.trim()) {
      fail('Enter both the Tencent SecretId and SecretKey (or leave both blank).', '3d')
      return
    }
    if (!beginMutation()) return
    const slotRequest = (id: SlotId): ModelSlotRequest => ({
      provider: slots[id].provider,
      endpoint: slots[id].endpoint,
      model: slots[id].model,
      apiKey: slots[id].apiKey,
      thinking: id === 'medium' ? 'default' : slots[id].thinking,
      effort: compatibleReasoningEffort(slots[id].effort, reasoningForSlot(id)),
      reasoningEfforts: reasoningForSlot(id),
      reasoningBudgetMax: catalogForSlot(id)?.reasoningBudgetMax ?? null,
      reasoningMode: catalogForSlot(id)?.reasoningMode ?? null
    })
    try {
      const result = await window.api.saveSetup({
        chat: slotRequest('medium'),
        image: slotRequest('image'),
        tencentSecretId: tencentId,
        tencentSecretKey: tencentKey,
        openaiApiKey: openaiKey
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      acceptStatus(result.data)
      onClose?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      mutationPending.current = false
      setBusy(false)
    }
  }

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        {onClose && (
          <button className="icon-btn setup-close" onClick={onClose} title="Close" disabled={busy}>
            <XIcon size={12} />
          </button>
        )}
        <div className="setup-head">
          <span className="setup-icon">
            <SparkIcon size={18} />
          </span>
          <div>
            <h2 className="setup-title">{status.configured ? 'AI settings' : 'Connect your AI assistant'}</h2>
            <p className="setup-sub">
              Solar's assistant uses one chat model for every conversation, with adjustable
              reasoning effort, plus image-enabled helpers that read your images and play-test your game.
            </p>
          </div>
        </div>

        <fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0,display:'flex',flexDirection:'column',gap:14}}>
        <p className="setup-hint">
          New model keys entered here are encrypted with your operating system’s secure storage and
          supplied to Solar’s OpenCode process. Existing OpenCode credentials remain untouched;
          re-enter a saved key here to store it in Solar’s vault. Asset-generation keys are
          encrypted too, and credentials are not added to your game files. Model slots with the same
          provider and base URL can reuse a key by copying it into the image helper's encrypted slot.
          Newly entered model keys are checked before saving. A loaded catalog does not guarantee
          access to generate with a particular model.
        </p>

        {status.credentialStoreError && (
          <div className="error-banner small" role="alert">
            {status.credentialStoreError}
          </div>
        )}
        {status.credentialStoreError?.includes('OpenCode credentials:') && /decrypt|invalid|unsupported format/i.test(status.credentialStoreError) && (
          <p className="setup-hint">Enter a new Chat model key to rebuild the unreadable provider vault.
            Solar keeps an encrypted backup; keys for other providers may need to be entered again.</p>
        )}

        {(status.legacyOpenCodeCredentials.length > 0 || status.latestOpenCodeAuthBackup) && (
          <div className="setup-section">
            {status.legacyOpenCodeCredentials.length > 0 && (
              <>
                <div>
                  <span className="setup-section-title">Move legacy OpenCode credentials</span>
                  <p className="setup-hint">
                    Selected API keys will be encrypted in Solar’s vault and removed from the shared
                    OpenCode auth.json. Other provider entries stay untouched. This can affect other
                    OpenCode installs using the same provider key; an encrypted rollback backup is created.
                  </p>
                </div>
                <div className="setup-migration-list">
                  {status.legacyOpenCodeCredentials.map(({ providerId, slotLabels }) => (
                    <label className="setup-migration-item" key={providerId}>
                      <input
                        type="checkbox"
                        checked={legacySelection.includes(providerId)}
                        disabled={busy}
                        onChange={(event) =>
                          setLegacySelection((selected) =>
                            event.target.checked
                              ? [...selected, providerId]
                              : selected.filter((id) => id !== providerId)
                          )
                        }
                      />
                      <span>
                        {providerId} <span className="setup-hint">({slotLabels.join(', ')})</span>
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost setup-migration-button"
                  disabled={busy || legacySelection.length === 0}
                  onClick={() => void migrateLegacyCredentials()}
                >
                  {busy ? 'Working…' : 'Move selected credentials'}
                </button>
              </>
            )}
            {status.latestOpenCodeAuthBackup && (
              <div>
                <p className="setup-hint">
                  {status.latestOpenCodeAuthBackup.restorable
                    ? 'An encrypted backup is ready. Restore is available while auth.json has not changed.'
                    : 'The encrypted backup is retained, but auth.json has changed since it was created; automatic restore is disabled.'}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost setup-migration-button"
                  disabled={busy || !status.latestOpenCodeAuthBackup.restorable}
                  onClick={() => void restoreLegacyAuth()}
                >
                  Restore shared auth.json backup
                </button>
              </div>
            )}
          </div>
        )}

        {migrationNotice && <div className="setup-hint">{migrationNotice}</div>}

        <div className="setup-tabs" role="tablist">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`setup-tab${tab === id ? ' active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'agent' && (
          <>
            {MODEL_SLOTS.map(({ id, title, hint, modelPlaceholder }) => (
              <ModelSection
                key={id}
                title={title}
                hint={hint}
                provider={slots[id].provider}
                onProvider={(provider) => updateProvider(id, provider)}
                endpoint={slots[id].endpoint}
                onEndpoint={(v) => {
                  if (mutationPending.current) return
                  for (const {id:slotId} of MODEL_SLOTS) resetModelCatalog(slotId)
                  const changed = norm(v,slots[id].provider) !== norm(slots[id].endpoint,slots[id].provider)
                  updateSlot(id, { endpoint: v, ...(changed?{apiKey:'',keyRevealed:true}:{}) })
                }}
                model={slots[id].model}
                onModel={(v) => {
                  const supported = reasoningForSlot(id, v)
                  updateSlot(id, {
                    model: v,
                    ...(id === 'medium'
                      ? { effort: compatibleReasoningEffort(slots[id].effort, supported) }
                      : {})
                  })
                }}
                modelPlaceholder={MODEL_PROVIDERS[slots[id].provider].modelExamples[id] || modelPlaceholder}
                slot={id}
                availableModels={availableModels[id]}
                loadingModels={loadingModels[id]}
                catalogNotice={catalogNotice[id]}
                onLoadModels={() => void loadModelIds(id)}
                effort={slots[id].effort}
                onEffort={(v) => updateSlot(id, { effort: v })}
                reasoningEfforts={reasoningForSlot(id)}
                showEffort={id === 'medium'}
                apiKey={slots[id].apiKey}
                onApiKey={(v) => {
                  if (mutationPending.current) return
                  for (const {id:slotId} of MODEL_SLOTS) resetModelCatalog(slotId)
                  updateSlot(id,{apiKey:v})
                }}
                keyPlaceholder={keyPlaceholder(id)}
                keyHidden={statusSlots[id].configured && !slots[id].keyRevealed}
                keyAutoFocus={statusSlots[id].configured}
                onRevealKey={() => updateSlot(id, { keyRevealed: true })}
                onSubmit={() => void save()}
              />
            ))}
          </>
        )}

        {tab === '2d' && (
          <>
            <span className="setup-hint">
              Add an OpenAI API key to let the assistant generate 2D art — sprites, icons, UI — as
              transparent 1024×1024 PNGs saved into your game's assets folder. Only OpenAI's
              gpt-image-1.5 model is supported right now.
            </span>

            <div className="setup-field">
              <span className="setup-label">OpenAI API key</span>
              {status.gptImageConfigured && !openaiKeyRevealed ? (
                <ConfiguredButton onClick={() => setOpenaiKeyRevealed(true)} />
              ) : (
                <input
                  className="text-input"
                  type="password"
                  value={openaiKey}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus={status.gptImageConfigured}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void save()}
                  placeholder={status.gptImageConfigured ? 'Leave blank to keep the stored key' : 'sk-…'}
                />
              )}
            </div>
          </>
        )}

        {tab === '3d' && (
          <>
            <span className="setup-hint">
              Add Tencent Cloud credentials to let the assistant generate 3D models saved into your
              game's assets folder. Only Tencent's HY 3D model is supported right now.
            </span>

            {status.hy3dConfigured && !tencentRevealed ? (
              <div className="setup-field">
                <span className="setup-label">Tencent credentials</span>
                <ConfiguredButton onClick={() => setTencentRevealed(true)} />
              </div>
            ) : (
              <>
                <label className="setup-field">
                  <span className="setup-label">Tencent SecretId</span>
                  <input
                    className="text-input"
                    value={tencentId}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoFocus={status.hy3dConfigured}
                    onChange={(e) => setTencentId(e.target.value)}
                    placeholder={status.hy3dConfigured ? 'Leave blank to keep the stored value' : 'AKID…'}
                  />
                </label>

                <label className="setup-field">
                  <span className="setup-label">Tencent SecretKey</span>
                  <input
                    className="text-input"
                    type="password"
                    value={tencentKey}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setTencentKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void save()}
                    placeholder={status.hy3dConfigured ? 'Leave blank to keep the stored value' : 'Your Tencent Cloud SecretKey'}
                  />
                </label>
              </>
            )}
          </>
        )}

        {error && <div className="error-banner small">{error}</div>}

        <button className="btn btn-primary setup-connect" disabled={busy} onClick={() => void save()}>
          {busy ? 'Checking & saving…' : 'Save settings'}
        </button>
        </fieldset>
      </div>
    </div>
  )
}
