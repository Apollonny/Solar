import type { ModelProviderId, ModelSlotId } from './types'

export interface ModelProviderDefinition {
  label: string
  endpoint: string
  apiKeyHelpUrl?: string
  /** Official AI SDK package used by OpenCode's custom-provider adapter. */
  npm: string
  modelExamples: Record<ModelSlotId, string>
}

/** Defaults shared by the setup UI and OpenCode config writer. */
export const MODEL_PROVIDERS: Record<ModelProviderId, ModelProviderDefinition> = {
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    npm: '@ai-sdk/openai-compatible',
    modelExamples: {
      medium: 'deepseek/deepseek-v4-pro',
      large: 'z-ai/glm-5.2',
      image: 'moonshotai/kimi-k2.7-code'
    }
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    npm: '@ai-sdk/openai',
    modelExamples: { medium: 'gpt-5.6-terra', large: 'gpt-5.6-sol', image: 'gpt-5.6-sol' }
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    npm: '@ai-sdk/anthropic',
    modelExamples: {
      medium: 'claude-sonnet-4-6',
      large: 'claude-opus-4-8',
      image: 'claude-sonnet-4-6'
    }
  },
  gemini: {
    label: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    npm: '@ai-sdk/google',
    modelExamples: { medium: 'gemini-3.8-flash', large: 'gemini-3.1-pro-preview', image: 'gemini-3.8-flash' }
  },
  xai: {
    label: 'xAI',
    endpoint: 'https://api.x.ai/v1',
    // Solar's scoped provider IDs need an adapter that reads options under
    // that ID; xAI's native SDK expects the fixed `xai` options namespace.
    npm: '@ai-sdk/openai-compatible',
    modelExamples: { medium: 'grok-4.6', large: 'grok-4.7', image: 'grok-4.6' }
  },
  nvidia: {
    label: 'NVIDIA',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    apiKeyHelpUrl: 'https://build.nvidia.com/',
    npm: '@ai-sdk/openai-compatible',
    modelExamples: {
      medium: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      large: 'nvidia/nemotron-3-super-120b-a12b',
      image: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
    }
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    endpoint: 'https://openrouter.ai/api/v1',
    npm: '@ai-sdk/openai-compatible',
    modelExamples: { medium: 'provider/model-id', large: 'provider/model-id', image: 'provider/vision-model-id' }
  }
}

export const MODEL_PROVIDER_IDS = Object.keys(MODEL_PROVIDERS) as ModelProviderId[]

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === 'string' && Object.hasOwn(MODEL_PROVIDERS, value)
}

export function modelProviderIdForNpm(npm: unknown): ModelProviderId | undefined {
  if (typeof npm !== 'string') return undefined
  const matches = MODEL_PROVIDER_IDS.filter(
    (provider) => provider !== 'openrouter' && MODEL_PROVIDERS[provider].npm === npm
  )
  // A shared OpenAI-compatible adapter does not identify its provider family.
  // Managed slot IDs carry that distinction; unknown entries remain Custom.
  return matches.length === 1 ? matches[0] : undefined
}

export function modelProviderRefId(slot: ModelSlotId, provider: ModelProviderId): string {
  return `solar-${slot}-${provider}`
}

export function modelProviderFromRefId(value: string): ModelProviderId | undefined {
  const match = /^(?:solar|genieengine)-(?:medium|large|image)-(openrouter|openai|anthropic|gemini|xai|nvidia|custom)$/.exec(value)
  return match?.[1] as ModelProviderId | undefined
}
