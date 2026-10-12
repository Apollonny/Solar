/** Preserve window preferences when upgrading from Solar to Solar. */
export function readSolarStorage(key: string): string | null {
  const current = localStorage.getItem(`solar:${key}`)
  if (current !== null) return current
  const legacy = localStorage.getItem(`genieengine:${key}`)
  if (legacy !== null) localStorage.setItem(`solar:${key}`, legacy)
  return legacy
}

export function writeSolarStorage(key: string, value: string): void {
  localStorage.setItem(`solar:${key}`, value)
}
