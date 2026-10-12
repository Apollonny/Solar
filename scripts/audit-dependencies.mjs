#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const npmCli = process.env.npm_execpath
if (!npmCli) {
  console.error('Run this audit through `npm run audit:dependencies`.')
  process.exit(1)
}

const audit = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true
})

if (audit.error) {
  console.error(`Could not run npm audit: ${audit.error.message}`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(audit.stdout)
} catch {
  console.error(audit.stderr || 'npm audit returned invalid JSON.')
  process.exit(1)
}

const reportedVulnerabilities = report.vulnerabilities ?? {}
if (
  report.error ||
  audit.status === null ||
  (audit.status !== 0 && audit.status !== 1) ||
  (audit.status === 1 && Object.keys(reportedVulnerabilities).length === 0)
) {
  console.error(report.error?.summary || audit.stderr || `npm audit failed with exit code ${audit.status}.`)
  process.exit(1)
}

const lockfile = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'))
const electronVersion = lockfile.packages?.['node_modules/electron']?.version
const extractZipVersion = lockfile.packages?.['node_modules/extract-zip']?.version
const vulnerabilities = Object.values(reportedVulnerabilities)
const blocked = []
const exceptions = []

for (const vulnerability of vulnerabilities) {
  if (
    vulnerability.name === 'electron' &&
    electronVersion === '33.4.11' &&
    vulnerability.severity === 'high'
  ) {
    exceptions.push(
      `electron@${electronVersion}: high; retained to preserve macOS 11 support, which Electron 38 removed.`
    )
    continue
  }

  if (vulnerability.name === 'extract-zip' && extractZipVersion === '2.0.1') {
    const advisoryIds = (vulnerability.via ?? [])
      .filter((item) => typeof item === 'object')
      .map((item) => item.source)
      .sort((a, b) => a - b)
    if (advisoryIds.length === 2 && advisoryIds[0] === 1139346 && advisoryIds[1] === 1193685) {
      exceptions.push(
        `extract-zip@${extractZipVersion}: upstream has not published a patched release for the two reported advisories.`
      )
      continue
    }
  }

  blocked.push(vulnerability)
}

for (const exception of exceptions) console.warn(`Known dependency exception: ${exception}`)

if (blocked.length > 0) {
  console.error('Unapproved dependency vulnerabilities:')
  for (const vulnerability of blocked) {
    console.error(`- ${vulnerability.name}: ${vulnerability.severity} (${vulnerability.range})`)
  }
  process.exit(1)
}

console.log(`Dependency audit passed (${exceptions.length} documented exception${exceptions.length === 1 ? '' : 's'}).`)
