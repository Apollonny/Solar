import type { ModelCatalogItem, ModelProviderId, ReasoningEffort } from './types'

/** User-facing choices, ordered from most to least reasoning. */
export const REASONING_EFFORT_CHOICES: { value: Exclude<ReasoningEffort, 'default'>; label: string }[] = [
  { value: 'max', label: 'Max' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]

const EFFORT_ORDER = REASONING_EFFORT_CHOICES.map(({ value }) => value)
const LOW_MEDIUM_HIGH: Exclude<ReasoningEffort, 'default'>[] = ['low', 'medium', 'high']

/** Five distinct budgets between OpenRouter's practical 1K floor and a model's limit. */
export function openRouterReasoningBudget(maxBudget: number, effort: Exclude<ReasoningEffort, 'default'>): number {
  const ceiling = Math.max(1028, Math.min(31999, Math.floor(maxBudget)))
  const step = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }[effort]
  return Math.floor(1024 + (ceiling - 1024) * step / 4)
}

function gemini25Budget(model: string, effort: Exclude<ReasoningEffort, 'default'>): number {
  return {
    low: 1024,
    medium: 4096,
    high: 8192,
    xhigh: 16000,
    max: model.startsWith('gemini-2.5-pro') ? 32768 : 24576
  }[effort]
}

function catalogEfforts(item?: ModelCatalogItem): ReasoningEffort[] | null | undefined {
  if (!item) return undefined
  if (item.reasoningEfforts !== undefined && item.reasoningEfforts !== null) return item.reasoningEfforts
  if (item.supportsReasoning === false) return []
  return undefined
}

function openRouterUnderlying(modelId: string): { provider: ModelProviderId; model: string } | null {
  const slash = modelId.indexOf('/')
  if (slash < 1) return null
  const owner = modelId.slice(0, slash).toLowerCase()
  const provider: ModelProviderId | undefined =
    owner === 'openai' ? 'openai'
      : owner === 'anthropic' ? 'anthropic'
        : owner === 'google' ? 'gemini'
          : owner === 'x-ai' || owner === 'xai' ? 'xai'
            : owner === 'nvidia' ? 'nvidia'
              : undefined
  return provider ? { provider, model: modelId.slice(slash + 1) } : null
}

function knownEfforts(provider: ModelProviderId, rawModelId: string): Exclude<ReasoningEffort, 'default'>[] | null {
  const model = rawModelId.trim().toLowerCase().replace(/^models\//, '')
  if (!model) return null

  if (provider === 'openrouter') {
    if (/^deepseek\/deepseek-v4-(?:pro|flash)(?:-|$)/.test(model)) return ['xhigh', 'high']
    if (/^z-ai\/glm-5\.2(?:-|$)/.test(model)) return ['xhigh', 'high']
    const underlying = openRouterUnderlying(model)
    // A provider's native budget control does not automatically become an
    // OpenRouter effort enum. Use only confirmed OpenRouter model mappings.
    return underlying && underlying.provider !== 'nvidia'
      ? knownEfforts(underlying.provider, underlying.model)
      : null
  }

  if (provider === 'openai' || provider === 'custom') {
    if (/^gpt-6(?:[-.]|$)/.test(model)) return [...EFFORT_ORDER]
    if (/^gpt-5\.6(?:[-.]|$)/.test(model)) return [...EFFORT_ORDER]
    if (/^gpt-5\.(?:2|4|5)-pro(?:[-.]|$)/.test(model)) return ['xhigh', 'high', 'medium']
    if (/^gpt-5\.(?:4|5)(?:[-.]|$)/.test(model)) return ['xhigh', 'high', 'medium', 'low']
    if (/^gpt-5\.3-codex(?:[-.]|$)/.test(model)) return ['xhigh', 'high', 'medium', 'low']
    if (/^gpt-5\.2(?:[-.]|$)/.test(model)) return ['xhigh', 'high', 'medium', 'low']
    if (/^gpt-5\.1-codex-max(?:[-.]|$)/.test(model)) return ['xhigh', 'high', 'medium', 'low']
    if (/^gpt-5\.1(?:[-.]|$)/.test(model)) return ['high', 'medium', 'low']
    if (/^gpt-5-pro(?:[-.]|$)/.test(model)) return ['high']
    if (/^gpt-5(?:-(?:mini|nano))?(?:[-.]|$)/.test(model)) return ['high', 'medium', 'low']
    if (/^(?:o1|o3|o4)(?:-|$)/.test(model)) return [...LOW_MEDIUM_HIGH].reverse()
    if (/^(?:gpt-3\.5|gpt-4|gpt-4o|chatgpt-4o)(?:-|$)/.test(model)) return []
    return null
  }

  if (provider === 'anthropic') {
    if (/^claude-(?:(?:fable|mythos)-5|mythos-preview)(?:[-.]|$)/.test(model)) return [...EFFORT_ORDER]
    if (/^claude-opus-5(?:[-.]|$)/.test(model)) return [...EFFORT_ORDER]
    if (/^claude-opus-4-(?:8|7)(?:[-.]|$)/.test(model)) return [...EFFORT_ORDER]
    if (/^claude-opus-4-6(?:[-.]|$)/.test(model)) return ['max', 'high', 'medium', 'low']
    if (/^claude-sonnet-5(?:[-.]|$)/.test(model)) return [...EFFORT_ORDER]
    if (/^claude-sonnet-4-6(?:[-.]|$)/.test(model)) return ['max', 'high', 'medium', 'low']
    if (/^claude-opus-4-5(?:[-.]|$)/.test(model)) return [...LOW_MEDIUM_HIGH].reverse()
    if (/^claude-(?:sonnet|haiku)-4-(?:[5-9])(?:[-.]|$)/.test(model)) return ['max', 'high']
    if (/^claude-3-(?:5|7)-/.test(model)) return []
    return null
  }

  if (provider === 'gemini') {
    if (/^gemini-3\.1-flash-lite-image(?:-|$)/.test(model)) return ['high']
    if (/^gemini-3-pro(?:-|$)/.test(model)) return ['high', 'low']
    if (/^gemini-3(?:\.\d+)?-pro(?:-|$)/.test(model)) return ['high', 'medium', 'low']
    if (/^gemini-3(?:\.\d+)?-flash(?:-|$)/.test(model)) return ['high', 'medium', 'low']
    if (/^gemini-2\.5-(?:pro|flash(?:-lite)?)(?:$|-(?!image(?:-|$)))/.test(model)) return [...EFFORT_ORDER]
    if (/^gemini-(?:1\.5|2\.0)(?:-|$)/.test(model)) return []
    return null
  }

  if (provider === 'xai') {
    if (/^grok-4\.(?:6|7|8|9)(?:-|$)/.test(model)) return ['xhigh', 'high', 'medium', 'low']
    if (/^grok-4\.5(?:-|$)/.test(model)) return [...LOW_MEDIUM_HIGH].reverse()
    if (/^grok-(?:2|3)(?:-|$)/.test(model)) return []
    return null
  }

  if (provider === 'nvidia') {
    if (/^nvidia\/nemotron-3\.5-lightning-30b-a3b$/.test(model)) return [...EFFORT_ORDER]
    if (/^nvidia\/nemotron-3-super-120b-a12b$/.test(model)) return [...EFFORT_ORDER]
    if (/^nvidia\/nemotron-3-nano-omni-30b-a3b-reasoning$/.test(model)) return [...EFFORT_ORDER]
    return null
  }

  return null
}

/**
 * Resolve the levels that can be sent for a model. `null` means no trustworthy
 * model capability data is available; an empty list means the model does not
 * expose a reasoning-effort control.
 */
export function reasoningEffortsForModel(
  provider: ModelProviderId,
  modelId: string,
  item?: ModelCatalogItem
): Exclude<ReasoningEffort, 'default'>[] | null {
  // The selected endpoint's current model catalog is more precise than a
  // static family rule, including OpenRouter's per-model supported_efforts.
  const advertised = catalogEfforts(item)
  if (advertised !== undefined) {
    const supported = new Set(advertised)
    return EFFORT_ORDER.filter((effort) => supported.has(effort) &&
      (provider !== 'gemini' || LOW_MEDIUM_HIGH.includes(effort) || item?.reasoningBudgetMax != null))
  }
  const known = knownEfforts(provider, modelId)
  if (known !== null) return known
  // A generic endpoint or model catalog can omit the actual accepted values.
  // Anthropic and NVIDIA also need a verified request shape, not just a level.
  return null
}

/** Request options consumed by OpenCode's provider adapter for this model. */
export function reasoningOptionsForModel(
  provider: ModelProviderId,
  modelId: string,
  effort: Exclude<ReasoningEffort, 'default'>,
  reasoningBudgetMax?: number | null,
  reasoningMode?: ModelCatalogItem['reasoningMode']
): Record<string, unknown> {
  const model = modelId.trim().toLowerCase().replace(/^models\//, '')
  if (provider === 'nvidia') {
    const budget = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }[effort]
    if (model === 'nvidia/nemotron-3.5-lightning-30b-a3b' ||
        model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning') {
      return { reasoning_budget: budget }
    }
    if (model === 'nvidia/nemotron-3-super-120b-a12b') {
      return effort === 'low'
        ? { reasoningEffort: 'low' }
        : { reasoningEffort: 'high', reasoning_budget: budget }
    }
    if (reasoningBudgetMax != null && Number.isFinite(reasoningBudgetMax) && reasoningBudgetMax >= 1028) {
      return { reasoning_budget: openRouterReasoningBudget(reasoningBudgetMax, effort) }
    }
  }
  if (provider === 'openrouter') {
    if (reasoningBudgetMax != null && Number.isFinite(reasoningBudgetMax) && reasoningBudgetMax >= 1028) {
      return { reasoning: { max_tokens: openRouterReasoningBudget(reasoningBudgetMax, effort) } }
    }
    if (model.startsWith('google/gemini-2.5-')) {
      return { reasoning: { max_tokens: gemini25Budget(model.slice('google/'.length), effort) } }
    }
    return { reasoning: { effort } }
  }
  if (provider === 'anthropic') {
    if (reasoningMode === 'adaptive') return { thinking: { type: 'adaptive' }, effort }
    if (reasoningMode === 'effort') return { effort }
    if (reasoningMode === 'budget') return {
      thinking: { type: 'enabled', budgetTokens: openRouterReasoningBudget(reasoningBudgetMax ?? 16000, effort) }
    }
    const adaptive = /^claude-(?:opus-(?:4-(?:6|7|8)|5)|sonnet-(?:4-6|5))/.test(model)
    if (adaptive) return { thinking: { type: 'adaptive' }, effort }
    if (/^claude-(?:fable|mythos)-/.test(model)) return { effort }
    if (/^claude-opus-4-5(?:[-.]|$)/.test(model)) return { effort }
    return { thinking: { type: 'enabled', budgetTokens: effort === 'max' ? 31999 : 16000 } }
  }
  if (provider === 'gemini') {
    return model.startsWith('gemini-2.5')
      ? { thinkingConfig: { includeThoughts: true, thinkingBudget: gemini25Budget(model, effort) } }
      : { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
  }
  return { reasoningEffort: effort }
}

/** Keep a saved selection valid after changing providers or models. */
export function compatibleReasoningEffort(
  value: ReasoningEffort,
  supported: Exclude<ReasoningEffort, 'default'>[] | null
): ReasoningEffort {
  if (value === 'default' || supported?.includes(value)) return value
  if (supported === null) return 'default'
  if (supported.includes('medium')) return 'medium'
  return supported[0] ?? 'default'
}
