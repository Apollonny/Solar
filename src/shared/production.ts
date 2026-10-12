export type ProductionRole = 'planner' | 'developer' | 'vision-reviewer' | 'tea-strategy' | 'tea-gate'
export type ProductionPhase = 'planning' | 'prepare' | 'skills' | 'tea_strategy' | 'developing' | 'applying' | 'validating' | 'runtime' | 'tests' | 'quality_review'
export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'STALE' | 'CANCELLED'
export interface SkillContextReceipt { name: string; sha256: string; bytes: number; manifestSha256: string; delivery: 'host-context' }
export interface AcceptanceCriterion { id: string; description: string; evidence: ('validation' | 'test' | 'runtime' | 'screenshot' | 'interaction')[] }
export interface TaskContract {
  schemaVersion: 1; runId: string; storyId: string; taskRevision: number; projectRevision: string
  request: string; scope: 'feature' | 'bugfix' | 'new_game' | 'question'; criteria: AcceptanceCriterion[]
  projectPath: string
  keywords: string[]; tests: string[]; model: { providerID: string; modelID: string }; attachments: string[]
  selection?: import('./ai-task-selection').TaskSelectionPolicy
}
export interface StageExecution {
  runId: string; phase: ProductionPhase; repair: number; projectRevision: string; task: TaskContract
  stageId: string; eventSeq: number; artifacts: Record<string, unknown>; approved: boolean
  role?: ProductionRole; loadedSkills?: string[]; skillContext?: SkillContextReceipt[]
  assetSelections?: import('./ai-task-selection').AssetSelectionReceipt[]
}
export interface StageResult { status: 'ok' | 'fail' | 'blocked' | 'stale' | 'transient' | 'approval_required'; data: unknown; projectRevision?: string; error?: string }
export interface EditorCommand { tool: string; args: Record<string, unknown> }
export interface ChangeSet {
  runId: string; storyId: string; taskRevision: number; stageId: string; eventSeq: number
  schemaVersion: 1; projectRevision: string; commands: EditorCommand[]
  files: { path: string; expectedHash: string | null }[]; summary: string
  assetImports?: import('./asset-library').AssetImport[]
}
export interface EvidenceArtifact {
  schemaVersion: 1; id: string; runId: string; storyId: string; taskRevision: number; projectRevision: string
  kind: 'validation' | 'test' | 'runtime' | 'screenshot' | 'interaction' | 'vision'
  origin: 'solar-validator' | 'gdunit4' | 'godot-ai' | 'vision-reviewer'
  stageId: string; eventSeq: number; file: string; sha256: string; bytes: number; createdAt: string; complete: boolean
}
export interface TestExecutionResult {
  status: 'pass' | 'fail' | 'blocked' | 'cancelled'; exitCode: number | null; selected: string[]
  discovered: number; executed: number; failed: number; skipped: number; report: string | null; truncated: boolean; scopeMatched: boolean
}
export interface GateReport { schemaVersion: 1; status: GateStatus; reasons: string[]; checks: { criterionId: string; passed: boolean; evidenceIds: string[] }[] }
export interface ApprovalRequest { runId: string; storyId: string; taskRevision: number; projectRevision: string; summary: string; operationId: string; files: string[]; operations: string[] }
export interface ProductionState {
  schemaVersion: 1; mode: 'legacy' | 'microsoft'; runId: string; phase: string; status: 'running' | 'reconnecting' | 'approval_required' | 'complete' | 'answered' | 'blocked' | 'fail' | 'stale' | 'cancelled'
  repair: number; eventSeq: number; projectRevision: string; message?: string; approval?: ApprovalRequest; gate?: GateReport
  canResume?: boolean
  projectPath?: string; startedAt?: string; updatedAt?: string
  progress?: { role: ProductionRole; startedAt: string; firstResponse: boolean; toolsStarted: number; toolsFailed: number }
  recovery?: { attempt: number; maxAttempts: number; nextAttemptAt?: string }
  criteria?: Pick<AcceptanceCriterion,'id'|'description'>[]
  evidence?: Pick<EvidenceArtifact,'id'|'kind'>[]
}
export interface ProductionSettings { enabled: boolean; ready: boolean; message: string }
export interface StudioReadiness {
  projectPath: string; checkedAt: string; bundled: boolean
  addons: { status: 'ready' | 'missing' | 'conflict' | 'unavailable'; message: string }
  editor: { status: 'ready' | 'closed' | 'opening' | 'error'; verified: boolean; message: string }
  models: { chat: string; vision: string; configurationId: string; configured: boolean; verified: boolean; reasons: string[] }
  ready: boolean
}
