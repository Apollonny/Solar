import { getSetupStatus, inspectModelKeyQuota, listModelIds } from './opencode-setup'
import { productionModelBlockers, type ModelAccess } from '../../shared/production-preflight'
import type { ModelCatalogRequest } from '../../shared/types'
import { isConnectionFailure } from '../../shared/connection-recovery'

/** Confirm only configured production endpoints; no generation or config writes. */
export async function inspectProductionModels(signal?: AbortSignal): Promise<{ready:boolean;reasons:string[];chat:ModelAccess;vision:ModelAccess}> {
  signal?.throwIfAborted()
  const setup=await getSetupStatus()
  const inspect=async(slot:'medium'|'image'):Promise<ModelAccess>=>{
    const info=slot==='medium'?setup.chat:setup.image
    const request:ModelCatalogRequest={slot,provider:info.provider,endpoint:info.endpoint,apiKey:''}
    if(!info.configured)return {configured:false,model:info.model,catalog:null,quota:{state:'unknown',remaining:null}}
    let connectionError: string | undefined
    const [catalog,quota]=await Promise.all([listModelIds(request,signal).catch(error=>{
      signal?.throwIfAborted()
      if(isConnectionFailure(error))throw error
      connectionError=error instanceof Error?error.message:'The provider connection could not be verified.'
      return null
    }),inspectModelKeyQuota(request,signal)])
    return {configured:true,model:info.model,catalog,quota,connectionError}
  }
  const [chat,vision]=await Promise.all([inspect('medium'),inspect('image')])
  signal?.throwIfAborted()
  const reasons=productionModelBlockers(chat,vision)
  // Only selected public model metadata crosses this boundary, not a whole catalog.
  chat.catalog=chat.catalog?.filter(item=>item.id===chat.model)??null
  vision.catalog=vision.catalog?.filter(item=>item.id===vision.model)??null
  return {ready:reasons.length===0,reasons,chat,vision}
}
