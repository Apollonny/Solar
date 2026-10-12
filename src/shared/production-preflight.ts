import type { ModelCatalogItem } from './types'

export interface ModelAccess {
  configured: boolean; model: string; catalog: ModelCatalogItem[] | null
  connectionError?: string
  quota: { state: 'available' | 'exhausted' | 'unknown'; remaining: number | null }
}
export function productionModelBlockers(chat: ModelAccess, vision: ModelAccess): string[] {
  const reasons: string[]=[]
  for(const [role,access] of [['Developer',chat],['Vision reviewer',vision]] as const) {
    if(!access.configured) { reasons.push(`${role}: an API credential is missing.`); continue }
    if(access.catalog===null)reasons.push(`${role}: ${access.connectionError??'the provider model catalog could not be verified.'}`)
    else {
      const entry=access.catalog.find(item=>item.id===access.model)
      if(!entry)reasons.push(`${role}: the selected model is absent from the provider catalog.`)
      else if(role==='Vision reviewer'&&entry.supportsImageInput!==true)reasons.push(`${role}: image input is not confirmed by the provider catalog.`)
    }
    if(access.quota.state==='exhausted')reasons.push(`${role}: the API key credit limit is exhausted.`)
  }
  return reasons
}
/** The key endpoint reports a per-key cap, not the account balance. */
export function openRouterKeyQuota(value: unknown): ModelAccess['quota'] {
  const data=value&&typeof value==='object'?(value as {data?:Record<string,unknown>}).data:undefined
  const remaining=data?.limit_remaining
  if(typeof remaining!=='number'||!Number.isFinite(remaining))return {state:'unknown',remaining:null}
  return {state:remaining<=0?'exhausted':'available',remaining}
}
