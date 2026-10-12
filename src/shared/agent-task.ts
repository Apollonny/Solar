export interface AgentTaskIdentity {
  runId: string
  taskRevision: number
  /** Hash of saved project content; null when a complete snapshot is unavailable. */
  projectRevision: string | null
  eventSeq: number
}

export type ValidationStatus = 'pass' | 'fail' | 'partial' | 'timeout' | 'cancelled' | 'stale' | 'unavailable'
export type ValidationMode = 'project' | 'scripts' | 'resources'
export type DiagnosticCode =
  | 'GD_PARSE_ERROR' | 'MISSING_RESOURCE' | 'MAIN_SCENE_MISSING' | 'AUTOLOAD_INVALID'
  | 'IMPORT_TIMEOUT' | 'VALIDATOR_TIMEOUT' | 'VALIDATOR_UNAVAILABLE' | 'STALE_CONTEXT'
  | 'UNCLASSIFIED_GODOT_ERROR'

export interface ProjectDiagnostic {
  code: DiagnosticCode
  file: string | null
  line: number | null
  column: number | null
  severity: 'error' | 'warning'
  message: string
  source: 'godot' | 'solar'
  engineVersion: string | null
}

export interface ProjectValidationResult {
  schemaVersion: 1
  runId: string | null
  taskRevision: number | null
  projectRevision: string | null
  status: ValidationStatus
  scope: {
    mode: ValidationMode
    files: string[]
    content: 'saved_files'
    runtime: 'not_checked'
    unsavedEditorChanges: 'not_inspected'
    importScope: 'whole_project'
    /** Exact locked addons omitted only from redundant per-file static checks. */
    dependencies?: { directory: string; files: number; sha256: string }[]
    verifiedEditorPlugins?: string[]
  }
  diagnostics: ProjectDiagnostic[]
  durationMs: number
  snapshotMs: number
  truncated: boolean
  cacheStatus: 'hit' | 'miss' | 'partial' | 'bypass'
  checks: { scripts: number; resources: number; cached: number; import: 'completed' | 'not_run' | 'failed' }
  engineVersion: string | null
}
