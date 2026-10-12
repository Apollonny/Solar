import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, cp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { copyRunProof } from './production-acceptance-proof.mjs'
import { createServer } from 'node:net'
if (!process.env.SOLAR_ACCEPTANCE_PROFILE) throw new Error('Explicit acceptance requires SOLAR_ACCEPTANCE_PROFILE; it uses the configured provider.')
const keyFile = process.argv.find(arg => arg.startsWith('--key-file='))?.slice('--key-file='.length)
if (keyFile) {
  const keys = [...new Set((await readFile(resolve(keyFile), 'utf8')).match(/nvapi-[A-Za-z0-9_-]{16,}/g) ?? [])]
  if (keys.length !== 1) throw new Error('The NVIDIA acceptance file must contain exactly one distinct NVIDIA API key. Its contents were not logged.')
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
if(process.argv.includes('--workflow')) {
  const free=port=>new Promise(done=>{
    const server=createServer();server.once('error',()=>done(false))
    server.listen(port,'127.0.0.1',()=>server.close(()=>done(true)))
  })
  const deadline=Date.now()+60_000
  while(!(await free(8000))||!(await free(9500))) {
    if(Date.now()>deadline)throw new Error('Godot gateway ports are occupied. This acceptance will not interrupt another backend or send model requests.')
    await new Promise(done=>setTimeout(done,500))
  }
}
await build({entryPoints:[join(root,'tests/production-model.acceptance.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(root,'.test-dist/production-model.cjs'),packages:'external'})
const fixture=await mkdtemp(join(tmpdir(),'solar-model-check-'))
const home = join(fixture, 'home'), configPath = join(homedir(), '.config/opencode/opencode.json')
const original = await readFile(configPath), config = JSON.parse(original)
const imageRef = config.agent?.['image-reader']?.model
const override = process.argv.includes('--image-model') ? imageRef : undefined
if (process.argv.includes('--image-model') && (typeof override !== 'string' || !override.includes('/'))) throw new Error('No configured image model is available for this explicitly authorized acceptance.')
// Only provider/model settings enter the fixture. Personal hooks, MCP servers,
// instructions and other projects are never invoked by acceptance runs.
await mkdir(join(home, '.config/opencode'), { recursive: true })
await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({
  provider: config.provider, model: override ?? config.model,
  agent: Object.fromEntries(['image-reader', 'game-tester'].map(name => [name, { model: config.agent?.[name]?.model ?? imageRef }]))
}), { mode: 0o600 })
const sourceProfile = resolve(process.env.SOLAR_ACCEPTANCE_PROFILE)
const protectedFiles = [configPath, ...['settings.json', 'opencode-credentials.json'].map(file => join(sourceProfile, file))]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const before = await Promise.all(protectedFiles.map(async path => hash(await readFile(path))))
let code = 1
try {
  const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, '.test-dist/production-model.cjs')], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: {
      ...process.env, USERPROFILE: home, HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
      OPENCODE_CONFIG: join(home, '.config/opencode/opencode.json'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'),
      SOLAR_ACCEPTANCE_ROOT: root, SOLAR_ACCEPTANCE_PROFILE: sourceProfile, SOLAR_ACCEPTANCE_DIR: fixture,
      ...(keyFile ? { SOLAR_ACCEPTANCE_KEY_FILE: resolve(keyFile) } : {}),
      ...(override ? { SOLAR_ACCEPTANCE_MODEL: override } : {}),
      ...(process.argv.includes('--workflow') ? { SOLAR_ACCEPTANCE_WORKFLOW: '1', SOLAR_LIBGODOT: '1' } : {}),
      ...(process.argv.includes('--3d') ? { SOLAR_ACCEPTANCE_3D: '1' } : {}),
      ...(process.argv.includes('--startup') ? { SOLAR_ACCEPTANCE_STARTUP_ONLY: '1' } : {})
      ,...(process.argv.includes('--preflight') ? { SOLAR_ACCEPTANCE_PREFLIGHT:'1' } : {})
      ,...(process.argv.includes('--vision') ? { SOLAR_ACCEPTANCE_VISION:'1' } : {})
      ,...(process.argv.includes('--assets') ? { SOLAR_ACCEPTANCE_ASSETS:'1',SOLAR_ASSET_LIBRARY_ROOT:join(process.env.APPDATA,'Solar/asset-library') } : {})
    }
  })
  code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', value => done(value ?? 1)) })
} finally {
  // Keep run/evidence/attempt diagnostics, including failures, but never archive
  // Local State, credentials, execution-policy tokens or provider configuration.
  const proof = join(root, '.test-dist/acceptance', fixture.split(/[\\/]/).at(-1))
  await mkdir(proof, { recursive: true })
  const runs = join(fixture, 'profile/production/runs')
  await copyRunProof(runs, join(proof, 'runs'))
  await cp(join(fixture,'preflight.json'),join(proof,'preflight.json')).catch(error=>{if(error.code!=='ENOENT')throw error})
  const files = []
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await inventory(path)
      else if (entry.isFile()) files.push({ path: relative(proof, path).replaceAll('\\', '/'), sha256: hash(await readFile(path)) })
      else throw new Error('Acceptance proof contains an unsupported link.')
    }
  }
  await inventory(proof)
  const unchanged = await Promise.all(protectedFiles.map(async (path, index) => hash(await readFile(path)) === before[index]))
  await writeFile(join(proof, 'summary.json'), JSON.stringify({ exitCode: code, acceptanceType: process.argv.includes('--vision') ? 'vision-capability' : process.argv.includes('--preflight') ? 'preflight' : process.argv.includes('--startup') ? 'startup' : process.argv.includes('--workflow') ? process.argv.includes('--assets') ? 'asset-workflow' : 'workflow' : process.argv.includes('--assets') ? 'asset-selection' : 'role', modelOverride: override ?? null, dimensions: process.argv.includes('--3d') || process.argv.includes('--vision') || process.argv.includes('--assets') && !process.argv.includes('--workflow') ? '3d' : '2d', protectedSettingsUnchanged: unchanged.every(Boolean), files }, null, 2))
  console.log('Acceptance diagnostics:', proof)
  if (unchanged.some(value => !value)) throw new Error('A protected provider/settings file changed during acceptance.')
  const target=resolve(fixture)
  if(dirname(target)!==resolve(tmpdir()) || !target.split(/[\\/]/).at(-1).startsWith('solar-model-check-'))throw new Error('Unsafe acceptance cleanup.')
  await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:300})
}
process.exitCode = code
