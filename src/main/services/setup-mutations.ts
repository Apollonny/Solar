let pending: Promise<void> | null = null
let productionBusy = (): boolean => false
export function registerSetupActivityGuard(guard:()=>boolean):void { productionBusy = guard }
export function isSetupUpdating(): boolean { return pending !== null }
export async function waitForSetupUpdate(): Promise<void> { await pending }
/** Hold one settings mutation through preparation, commit and rollback. */
export async function withSetupMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (pending) throw new Error('AI settings are already being updated. Wait for the current save to finish.')
  if (productionBusy()) throw new Error('Stop the active Game Studio task before updating its connection settings.')
  let release!: () => void
  pending = new Promise<void>(resolve => { release = resolve })
  try { return await operation() }
  finally { pending = null; release() }
}
