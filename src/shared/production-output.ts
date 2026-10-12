import type { ProductionRole } from './production'

export interface ArtifactSchema {
  type?: string | string[]; enum?: unknown[]; const?: unknown
  properties?: Record<string, ArtifactSchema>; required?: string[]; additionalProperties?: boolean
  items?: ArtifactSchema; minItems?: number; maxItems?: number
  minLength?: number; maxLength?: number; pattern?: string
}
const str = (maxLength = 30_000): ArtifactSchema => ({ type: 'string', minLength: 1, maxLength })
const list = (items: ArtifactSchema, maxItems: number, minItems = 0): ArtifactSchema => ({ type: 'array', items, maxItems, minItems })
const obj = (properties: Record<string, ArtifactSchema>, required = Object.keys(properties)): ArtifactSchema => ({ type: 'object', properties, required, additionalProperties: false })
const command = obj({ tool: str(120), args: { type: 'object', additionalProperties: true } })
const criterion = obj({ id: { ...str(80), pattern: '^[a-zA-Z0-9_-]+$' }, description: str(2000), evidence: list({ type: 'string', enum: ['validation','test','runtime','screenshot','interaction'] }, 5, 1) })
const suite = { ...str(400), pattern: '^tests/[^\\\\]+\\.gd$' }
export const productionOutputSchemas: Record<ProductionRole, ArtifactSchema> = {
  planner: obj({ scope: { type: 'string', enum: ['question','feature','bugfix','new_game'] }, answer: str(), story: str(), gdd: str(40_000), epics: list(str(400),30), milestones: list(str(400),20), criteria: list(criterion,20,1), keywords: list(str(400),12,1), tests: list(suite,20,1) }, ['scope']),
  'tea-strategy': obj({ risks: list(str(400),30,1), tests: list(suite,20,1), renderTests: { type: 'boolean' }, evidencePlan: str() }),
  developer: obj({ changeSet: obj({ schemaVersion: { const: 1 }, projectRevision: { ...str(64), pattern: '^[a-f0-9]{64}$' }, summary: str(8000), files: list(obj({ path: str(400), expectedHash: { type: ['string','null'], pattern: '^[a-f0-9]{64}$' } }),128), commands: list(command,100,1), assetImports: list(obj({ packId: str(100), files: list(obj({ path: str(500), sha256: { ...str(64), pattern: '^[a-f0-9]{64}$' }, preset: { type: 'object', additionalProperties: true } },['path','sha256']),64,1) }),14) },['schemaVersion','projectRevision','summary','files','commands']), scenario: list(command,100,1) }),
  'vision-reviewer': obj({ passed: { type: 'boolean' }, observations: str(8000), criterionIds: list(str(80),20,1) }),
  'tea-gate': obj({ schemaVersion: { const: 1 }, status: { type: 'string', enum: ['PASS','FAIL','BLOCKED','STALE'] }, reasons: list(str(2000),40), checks: list(obj({ criterionId: str(80), passed: { type: 'boolean' }, evidenceIds: list(str(100),100) }),20) })
}

/** Validate our bounded schema subset again at the host boundary. No coercion. */
export function validateProductionOutput(value: unknown, schema: ArtifactSchema): void {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || encoded.length > 1024 * 1024) throw new Error('The executor returned a missing or oversized structured artifact.')
  const visit = (v: unknown, s: ArtifactSchema, depth: number): void => {
    if (depth > 64) throw new Error('The structured artifact is nested too deeply.')
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
    if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).includes(type) || 'const' in s && v !== s.const || s.enum && !s.enum.includes(v)) throw new Error('The executor artifact does not match the requested JSON schema.')
    if (typeof v === 'string' && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v))) throw new Error('The structured artifact contains invalid text.')
    if (Array.isArray(v)) {
      if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) throw new Error('The structured artifact contains an invalid list.')
      if (s.items) for (const item of v) visit(item, s.items, depth + 1)
    } else if (v && typeof v === 'object') {
      const record = v as Record<string, unknown>
      if (s.required?.some(key => !Object.hasOwn(record,key)) || s.additionalProperties === false && Object.keys(record).some(key => !Object.hasOwn(s.properties ?? {},key))) throw new Error('The structured artifact is missing required fields or contains unexpected fields.')
      for (const [key, child] of Object.entries(s.properties ?? {})) if (Object.hasOwn(record,key)) visit(record[key],child,depth + 1)
    }
  }
  visit(value,schema,0)
}
