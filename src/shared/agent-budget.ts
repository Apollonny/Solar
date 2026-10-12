/** Runtime enforcement and agent-facing instructions share these limits. */
export const AGENT_BUDGET = Object.freeze({
  gameTest: { calls: 40, ms: 8 * 60_000, warnCalls: 30, warnMs: 6 * 60_000 },
  guidance: {
    searchLimit: 8,
    pageLines: 160,
    maxPageLines: 240,
    pageChars: 12_000,
    catalogBytes: 2 * 1024 * 1024,
    fileBytes: 1024 * 1024
  },
  validation: {
    scriptMs: 15_000,
    importMs: 60_000,
    resourceMs: 60_000,
    totalMs: 180_000,
    snapshotMs: 30_000,
    maxFiles: 10_000,
    maxBytes: 512 * 1024 * 1024,
    sourceTextBytes: 16 * 1024 * 1024,
    maxUnits: 256,
    outputBytes: 256 * 1024,
    maxDiagnostics: 200,
    cacheBytes: 10 * 1024 * 1024
  },
  metricsBytes: 15 * 1024 * 1024
})

export function gameTestBudgetInstructions(): string {
  const { calls, ms, warnCalls, warnMs } = AGENT_BUDGET.gameTest
  return `Each game test run allows ${calls} game tool calls or ${ms / 60_000} minutes. ` +
    `Warnings begin after ${warnCalls} calls or ${warnMs / 60_000} minutes. ` +
    'Use a short list of specific checks; stop_game_test and game_logs remain available to finish the report.'
}
