// App-owned OpenCode hook. Upstream scripts/plugins are never executed.
import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, relative, sep } from 'node:path'

async function lease(sessionID, optional = false) {
  const policyPath = process.env.SOLAR_EXECUTION_POLICY
  if (!policyPath) throw new Error('Microsoft stage policy is unavailable.')
  const info = await lstat(policyPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Invalid Microsoft stage policy.')
  const policy = JSON.parse(await readFile(policyPath, 'utf8'))
  const session = policy.schemaVersion === 1 ? policy.sessions?.[sessionID] : null
  if (!session && !optional) throw new Error('This session has no dispatched task lease.')
  return session
}

export const SolarGameSkills = async () => ({
  config: async (config) => {
    const root = process.env.SOLAR_NATIVE_SKILLS_PATH
    if (!root || !isAbsolute(root)) throw new Error('Solar native skill bundle is not configured.')
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.names) || manifest.names.length < 1 || manifest.names.length > 512 ||
        manifest.names.some((name) => typeof name !== 'string' || name.length > 64 || !/^solar-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
      throw new Error('Solar native skill bundle is incomplete.')
    }
    // This hook runs after config layers merge, so user/global/project skill
    // paths and URLs survive. It mutates only the child process's config.
    config.skills = { ...(config.skills ?? {}), paths: [...new Set([...(config.skills?.paths ?? []), root])] }
    if (process.env.SOLAR_EXECUTION_MODE === 'microsoft') {
      const productionRoot = process.env.SOLAR_PRODUCTION_SKILLS_PATH
      if (!productionRoot || !isAbsolute(productionRoot)) throw new Error('Production skills are unavailable.')
      config.skills.paths.push(productionRoot)
    }
  },
  'chat.params': async (input, output) => {
    if (process.env.SOLAR_EXECUTION_MODE !== 'microsoft') return
    const session = await lease(input.sessionID)
    if (input.agent !== 'solar-production-' + session.role) throw new Error('The model role was not dispatched by Microsoft.')
    const limits = { planner: 8192, developer: 24576, 'vision-reviewer': 1024, 'tea-strategy': 8192, 'tea-gate': 8192 }
    const options = output.options ?? {}
    const budgets = [options.reasoning_budget, options.reasoning?.max_tokens, options.thinking?.budget_tokens, options.thinkingConfig?.thinkingBudget].filter(value => Number.isFinite(value) && value > 0)
    const floor = Math.max(0, ...budgets)
    const ceiling = Number.isFinite(output.maxOutputTokens) ? output.maxOutputTokens : Infinity
    if (!limits[session.role] || ceiling <= floor) throw new Error('The role output budget cannot fit the selected model reasoning budget.')
    // Preserve the chosen reasoning options. Bound ordinary role output while
    // reserving room for an explicitly requested reasoning token budget.
    output.maxOutputTokens = Math.min(ceiling, Math.max(limits[session.role], floor > 0 ? floor + 2048 : 0))
  },
  'experimental.chat.system.transform': async (input, output) => {
    const managed=process.env.SOLAR_EXECUTION_MODE==='microsoft'
    const session=await lease(input.sessionID,!managed)
    const selected = new Set(session?.skills??[]), found = new Set()
    // Keep the native registry intact. OpenCode emits its verbose catalog in
    // the system prompt, so trim that catalog to this session's assigned skills.
    // Loaded skill bodies and user/tool messages are not rewritten.
    for (let index=0; index<output.system.length; index++) output.system[index] = output.system[index].replace(/<available_skills>[\s\S]*?<\/available_skills>/g, catalog => {
      const entries = [...catalog.matchAll(/<skill>[\s\S]*?<\/skill>/g)].map(match => match[0]).filter(entry => {
        const name = entry.match(/<name>([^<]+)<\/name>/)?.[1]?.trim()
        if (!selected.has(name)) return false
        found.add(name); return true
      })
      return '<available_skills>\n' + entries.join('\n') + '\n</available_skills>'
    })
    if (session?.skills.some(name => !found.has(name))) throw new Error('The native skill catalog does not contain every skill assigned to this task.')
  },
  'tool.execute.before': async (input, output) => {
    const managed=process.env.SOLAR_EXECUTION_MODE==='microsoft'
    const session=await lease(input.sessionID,!managed)
    if(!managed&&input.tool==='task'&&!['image-reader','game-tester'].includes(output.args.subagent_type))throw new Error('This helper was not assigned by Solar. Use Game Studio for production agent routing.')
    if(!session) {
      if(['skill','solar_game_guidance','solar_production_guidance','solar_asset_library'].includes(input.tool))throw new Error('This helper has no assigned skill or asset scope. Return to the dispatched Solar task.')
      if(['read','bash'].includes(input.tool)&&/SKILL\.md|native-(?:game|production)-skills|game-guidance[\\/]upstream/i.test(JSON.stringify(output.args)))throw new Error('This helper cannot read unassigned skill documents.')
      return
    }
    if (session.toolAllowlist && !session.toolAllowlist.includes(input.tool)) throw new Error('This tool was not assigned to the current Microsoft stage. Use the provided project facts and submit the requested artifact.')
    if (input.tool === 'skill') {
      if (!session.skills.includes(output.args.name)) throw new Error('This skill is not selected for the current Microsoft stage.')
      return
    }
    if(!managed) {
      if(input.tool==='solar_production_guidance')throw new Error('Production methodology belongs to Microsoft-dispatched roles.')
      if(input.tool.startsWith('solar_'))output.args._solar_session=input.sessionID
      const encoded=JSON.stringify(output.args).replace(/\\\\/g,'/')
      if(['bash','write','edit','apply_patch'].includes(input.tool)&&/assets[\\/]library[\\/]|SOLAR_ASSET_LIBRARY_ROOT|SOLAR_EXECUTION_POLICY|asset-library[\\/]|SKILL\.md|native-(?:game|production)-skills/i.test(encoded))throw new Error('Library sources, presets and task policy are host-managed. Use exact asset_library recommendations/imports; put custom adaptations elsewhere in the project.')
      if(['read','glob','grep','list'].includes(input.tool)) {
        const target=await realpath(resolve(session.projectPath,output.args.filePath??output.args.path??'.')), root=await realpath(session.projectPath), rel=relative(root,target)
        if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`)||/(^|[\\/])(?:\.git|\.opencode|\.claude|\.agents|\.env(?:\..*)?|credentials?|auth\.json)([\\/]|$)/i.test(rel))throw new Error('Read task references through their scoped skill/library tools; project reads must stay in this project.')
      }
      return
    }
    if (input.tool === 'StructuredOutput') return
    // The broker resolves this lease itself. Overwrite any model-supplied value;
    // it is private transport metadata, never part of a reference-tool schema.
    if (input.tool.startsWith('solar_')) output.args._solar_session = input.sessionID
    if (input.tool === 'solar_game_guidance' && output.args.action === 'read') {
      const nativeName = String(output.args.id ?? '').startsWith('solar-') ? output.args.id : `solar-${output.args.id}`
      if (!session.skills.includes(nativeName)) throw new Error('This guide was not selected for the stage.')
      const otherSkill = typeof output.args.file === 'string' ? output.args.file.match(/^upstream\/skills\/([^/]+)\//)?.[1] : null
      if (otherSkill && !session.skills.includes(`solar-${otherSkill}`)) throw new Error('The reference belongs to an unselected skill.')
      const solarModule = typeof output.args.file === 'string' ? output.args.file.match(/^solar\/(2d|3d|assets|ecs|memory|validation)\.md$/)?.[1] : null
      if (solarModule && !session.skills.includes(`solar-${solarModule}`)) throw new Error('The Solar module was not selected.')
    }
    if (input.tool === 'solar_production_guidance' && output.args.action === 'read') {
      const expected = session.role === 'planner' ? 'bmad/' : ['tea-strategy','tea-gate'].includes(session.role) ? 'tea/' : null
      const path = String(output.args.file ?? '')
      const ownSkill = session.skills.some(name => path === `skills/${name}/SKILL.md`)
      if (!expected || !path.startsWith(expected) && !ownSkill) throw new Error('Invalid methodology path for this role. Copy a library-relative file from search results or the assigned skill exactly; repository/version names are not paths. Planner example: bmad/src/workflows/4-production/gds-create-story/template.md. TEA example: tea/src/agents/bmad-tea/resources/knowledge/evidence-integrity.md. Do not repeat this rejected path.')
    }
    if (['read','glob','grep','list'].includes(input.tool)) {
      const target = await realpath(resolve(session.projectPath, output.args.filePath ?? output.args.path ?? '.'))
      const root = await realpath(session.projectPath)
      const rel = relative(root, target)
      const inside = !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
      // The lease already includes exact selected SKILL.md/evidence paths.
      // Granting a whole cache subtree could read unmanifested injected files.
      const evidence = (session.readPaths ?? []).some(path => resolve(path).toLowerCase() === target.toLowerCase())
      if (!inside && !evidence || inside && /(^|[\\/])(?:\.git|\.opencode|\.claude|\.agents|\.env(?:\..*)?|credentials?|auth\.json)([\\/]|$)/i.test(rel)) throw new Error('File read is outside this stage’s project/skill/evidence scope.')
    }
    if (input.tool === 'solar_asset_library' && (session.role !== 'developer' || !['search','inspect','read','recommend'].includes(output.args.action ?? 'search'))) throw new Error('Only the Developer may read task-specific library assets. Submit assetImports in the ChangeSet.')
    if (!['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'solar_game_guidance', 'solar_production_guidance', 'solar_asset_library'].includes(input.tool)) {
      throw new Error('The Microsoft-controlled role is read-only. Submit the requested artifact; Solar owns execution.')
    }
  }
})
