import { app } from 'electron'
import { join } from 'node:path'
import { writeAtomic } from './json-file'
import type { ProductionRole } from '../../shared/production'
import { validateRoleSkills } from './production-role-config'
import { assetReceiptKey, type AssetSelectionReceipt, type TaskSelectionPolicy } from '../../shared/ai-task-selection'
export { controlledAgentConfig } from './production-role-config'

interface SessionPolicy { role: ProductionRole; skills: string[]; runId: string; projectPath: string; readPaths: string[]; toolAllowlist?: string[]; selection?:TaskSelectionPolicy; sessionId:string }
interface LegacyPolicy extends Omit<SessionPolicy,'role'> {role:'legacy-developer'}
const sessions = new Map<string, SessionPolicy>()
const legacy = new Map<string,LegacyPolicy>()
const selectedAssets = new Map<string,Map<string,AssetSelectionReceipt>>()
const loadedSkills = new Map<string, Set<string>>()
let writes: Promise<void> = Promise.resolve()
export function productionPolicyPath(): string { return join(app.getPath('userData'), 'production', 'execution-policy.json') }
function persist(): Promise<void> {
  const contents = JSON.stringify({schemaVersion:1,sessions:Object.fromEntries([...sessions,...legacy])})
  writes = writes.catch(() => {}).then(() => writeAtomic(productionPolicyPath(), contents))
  return writes
}
export async function registerProductionSession(id: string, runId: string, role: ProductionRole, skills: string[], projectPath: string, readPaths: string[] = [], toolAllowlist?: string[], selection?:TaskSelectionPolicy): Promise<void> {
  validateRoleSkills(role, skills, selection)
  if (sessions.has(id)) throw new Error('This executor session already has a lease.')
  sessions.set(id,{sessionId:id,runId,role,skills:[...skills],projectPath,readPaths:[...readPaths],toolAllowlist:toolAllowlist?[...toolAllowlist]:undefined,selection})
  loadedSkills.set(id, new Set())
  try { await persist() }
  catch (error) { sessions.delete(id); loadedSkills.delete(id); await persist().catch(() => {}); throw error }
}
export function recordProductionSkill(id: string, name: string): void { if (sessions.get(id)?.skills.includes(name)) loadedSkills.get(id)?.add(name) }
export function productionSkillsLoaded(id: string): string[] { return [...(loadedSkills.get(id) ?? [])] }
export async function unregisterProductionSession(id: string): Promise<void> { sessions.delete(id); loadedSkills.delete(id); selectedAssets.delete(id); await persist() }
export function getProductionSession(id: string): SessionPolicy | undefined { return sessions.get(id) }
export function getReferenceSession(id:string):SessionPolicy|LegacyPolicy|undefined {return sessions.get(id)??legacy.get(id)}
export async function registerLegacySession(id:string,runId:string,projectPath:string,skills:string[],selection:TaskSelectionPolicy):Promise<void> {
  if(sessions.has(id))throw new Error('A managed session cannot become a regular chat session.')
  legacy.set(id,{sessionId:id,role:'legacy-developer',runId,projectPath,skills:[...skills],readPaths:[],selection})
  selectedAssets.delete(id)
  try {await persist()}catch(error){legacy.delete(id);throw error}
}
export async function unregisterLegacySession(id:string):Promise<void> {legacy.delete(id);selectedAssets.delete(id);await persist()}
export async function clearLegacySessions():Promise<void> {legacy.clear();for(const id of selectedAssets.keys())if(!sessions.has(id))selectedAssets.delete(id);await persist()}
export function recordAssetSelections(id:string,receipts:AssetSelectionReceipt[]):void {
  if(!getReferenceSession(id))throw new Error('Asset recommendations belong to an expired task session.')
  const current=new Map(selectedAssets.get(id)??[])
  for(const receipt of receipts)current.set(assetReceiptKey(receipt.packId,receipt.path,receipt.sha256,receipt.preset),structuredClone(receipt))
  if(current.size>128)throw new Error('Too many asset variants for this task. Narrow the recommendation query.')
  selectedAssets.set(id,current)
}
export function productionAssetSelections(id:string):AssetSelectionReceipt[] {return [...(selectedAssets.get(id)?.values()??[])].map(receipt=>structuredClone(receipt))}
