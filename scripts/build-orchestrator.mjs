import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = process.env.SOLAR_DOTNET || 'dotnet'
const rid = process.argv.find(x => x.startsWith('--rid='))?.slice(6) || 'win-x64'
if (!['win-x64', 'linux-x64', 'osx-arm64', 'osx-x64'].includes(rid)) throw new Error('Unsupported orchestrator RID.')
const output = join(root, 'vendor', 'orchestrator', rid)
await mkdir(output, { recursive: true })
const result = spawnSync(sdk, ['publish', join(root, 'orchestrator/Solar.Orchestrator/Solar.Orchestrator.csproj'), '-c', 'Release', '-r', rid, '--self-contained', 'true', '-p:RestoreLockedMode=true', '-o', output, '--nologo'], { cwd: join(root, 'orchestrator'), stdio: 'inherit', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const binary = rid.startsWith('win-') ? 'Solar.Orchestrator.exe' : 'Solar.Orchestrator'
const data = await readFile(join(output, binary))
const files = []
async function inventory(part = '') {
  for (const entry of await readdir(join(output, part), { withFileTypes: true })) {
    const path = part ? `${part}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('Linked runtime file.')
    if (entry.isDirectory()) await inventory(path)
    else if (entry.isFile() && path !== 'manifest.json') {
      const bytes = await readFile(join(output, path))
      files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
}
await inventory()
await writeFile(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, workflowVersion: 'solar-production-1', framework: '1.22.0', rid, binary, sha256: createHash('sha256').update(data).digest('hex'), files }, null, 2))
