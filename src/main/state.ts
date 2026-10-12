import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ProjectInfo, ReasoningEffort } from '../shared/types'

/**
 * The chat model as a full `provider/model` ref. Legacy tier fields remain
 * readable so upgrading from the old Medium/Large setup keeps its model.
 */
export interface ChatModelRefs {
  chat?: string
  /** Model-specific effort levels learned from the provider catalog, when available. */
  chatReasoningEfforts?: Exclude<ReasoningEffort, 'default'>[] | null
  /** Upper token budget for a catalog model with budget-only reasoning. */
  chatReasoningBudgetMax?: number | null
  chatReasoningMode?: 'adaptive' | 'effort' | 'budget' | null
  /** @deprecated legacy model refs from pre-single-model settings */
  medium?: string
  /** @deprecated legacy model refs from pre-single-model settings */
  large?: string
}

interface SettingsFile {
  godotPath?: string
  opencodePath?: string
  recentProjects: string[]
  /** Whether the ECS viewer, files/git sidebars and console output are shown. */
  advancedMode?: boolean
  chatModels?: ChatModelRefs
  productionWorkflow?: boolean
}

let settings: SettingsFile = { recentProjects: [] }
let currentProject: ProjectInfo | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<SettingsFile> | null
    settings = { recentProjects: [] }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    if (typeof raw.godotPath === 'string') settings.godotPath = raw.godotPath
    if (typeof raw.opencodePath === 'string') settings.opencodePath = raw.opencodePath
    if (typeof raw.advancedMode === 'boolean') settings.advancedMode = raw.advancedMode
    if (typeof raw.productionWorkflow === 'boolean') settings.productionWorkflow = raw.productionWorkflow
    if (Array.isArray(raw.recentProjects)) {
      settings.recentProjects = [...new Set(raw.recentProjects.filter((p) => typeof p === 'string' && p.length > 0))].slice(0, 8)
    }
    const refs = raw.chatModels
    if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
      const clean: ChatModelRefs = {}
      for (const key of ['chat', 'medium', 'large'] as const) {
        if (typeof refs[key] === 'string' && refs[key]?.includes('/')) clean[key] = refs[key]
      }
      if (refs.chatReasoningEfforts === null) clean.chatReasoningEfforts = null
      else if (Array.isArray(refs.chatReasoningEfforts)) {
        const levels = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])
        clean.chatReasoningEfforts = [...new Set(refs.chatReasoningEfforts.filter((level) => typeof level === 'string' && levels.has(level)))]
      }
      if (typeof refs.chatReasoningBudgetMax === 'number' && Number.isFinite(refs.chatReasoningBudgetMax) && refs.chatReasoningBudgetMax > 0) {
        clean.chatReasoningBudgetMax = refs.chatReasoningBudgetMax
      }
      if (refs.chatReasoningMode === 'adaptive' || refs.chatReasoningMode === 'effort' || refs.chatReasoningMode === 'budget') {
        clean.chatReasoningMode = refs.chatReasoningMode
      }
      settings.chatModels = clean
    }
  } catch {
    // First launch (or corrupt file) — start with defaults.
    settings = { recentProjects: [] }
  }
}

export function saveSettings(): void {
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function getSettings(): SettingsFile {
  return settings
}

export function setGodotPath(path: string): void {
  settings.godotPath = path
  saveSettings()
}

export function getChatModelRefs(): ChatModelRefs {
  return settings.chatModels ?? {}
}

export function setChatModelRefs(refs: ChatModelRefs): void {
  const previous = settings.chatModels
  settings.chatModels = refs
  try { saveSettings() }
  catch (error) { settings.chatModels = previous; throw error }
}

export function getAdvancedMode(): boolean {
  return settings.advancedMode ?? false
}

export function getProductionEnabled(): boolean { return settings.productionWorkflow === true }
export function setProductionEnabled(value: boolean): void { settings.productionWorkflow = value; saveSettings() }

export function setAdvancedMode(value: boolean): void {
  settings.advancedMode = value
  saveSettings()
}

export function addRecentProject(path: string): void {
  settings.recentProjects = [path, ...settings.recentProjects.filter((p) => p !== path)].slice(0, 8)
  saveSettings()
}

export function getRecentProjectPaths(): string[] {
  // Drop projects whose folder no longer exists so the welcome screen stays clean.
  return settings.recentProjects.filter((p) => existsSync(join(p, 'project.godot')))
}

export function setCurrentProject(project: ProjectInfo | null): void {
  currentProject = project
}

export function getCurrentProject(): ProjectInfo | null {
  return currentProject
}

export function requireProject(): ProjectInfo {
  if (!currentProject) throw new Error('No project is open')
  return currentProject
}
