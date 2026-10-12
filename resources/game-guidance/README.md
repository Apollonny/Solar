# Solar game guidance bundle

Solar registers these files as native OpenCode skills; `game_guidance` provides
catalog search and read-only supporting examples. They are application resources,
separate from game projects and the user's Codex skills.

- 189 Godot Game Dev Studio guides with their text references/examples.
- Six Solar modules: ECS, 2D, 3D, assets, validation and project memory.
- A generated catalog built from every actual `SKILL.md`; the upstream 96-entry
  `skills_index.json` is preserved for provenance, but does not drive Solar routing.

## Source and attribution

Repository: [bgrenat/godot-game-dev-studio](https://github.com/bgrenat/godot-game-dev-studio).
Pinned commit: `9e2b2beaf0bc7ba2e27a40326d058ff2c7a619a9`.
The upstream distribution was assembled/curated by Powehi and credits Divergent AI,
gamedev-skills, GodotPrompter, Claude-Code-Game-Studios and Don Tnowe. The complete
original [NOTICE](upstream/NOTICE.md) and [LGPL-3.0 license](upstream/LICENSE) are
preserved. The [GPLv3 text](solar/GPL-3.0.txt) is also supplied. The worldmap builder
reference retains its [MIT license](upstream/assets/godot-worldmap-builder/LICENSE.md).
Preserve any file-specific copyright/license notices when adapting code.

Upstream selected text is copied verbatim. Solar adds its own catalog, loader,
instruction modules and adaptation policy. No upstream plugin configuration,
installation hooks, compiled Python cache, repository history or promotional
images are bundled. Worldmap builder code is a reference only: its image assets
are omitted, so it is not an installed or complete game addon. Missing references
are marked `available: false` by the tool.

The source targets Godot 4.7+ patterns. Examples are not verified drop-in code;
Solar's ECS, user choices and actual engine APIs govern adaptation. Files stay
offline and no library script is executed or copied into a game by the loader.

## Maintainer updates

`node scripts/vendor-game-guidance.mjs` fetches only the pinned commit and
regenerates the bundle/catalog. `--source <local-git-repository>` uses that commit
from an existing checkout without network access. Run it after changing Solar
modules so their hashes remain current. Review a new revision before changing
the pinned commit/count in the script. Restart Solar after replacing the bundle.

Normal builds and app startup do not fetch or update this repository.

## Native skill registration

The application produces 195 actual `<name>/SKILL.md` documents under its
userData `native-game-skills/<content-hash>/` cache. Each contains YAML metadata,
the full selected module/skill instructions, Solar adaptation rules and provenance.
Upstream skill names receive a `solar-` prefix; the six Solar module names stay
unchanged. Supporting examples remain in the original bundle and are read through
`game_guidance`, which keeps project access boundaries intact.

The app-owned `solar-skills-plugin.mjs` adds that directory to the resolved
OpenCode `skills.paths` at startup. Existing user/project skill paths, URLs and
plugins are preserved. Registration is limited to the OpenCode process Solar
starts; the user's global configuration and game project folders are not changed.
Cached documents and notices are verified before use and reused across projects.

OpenCode advertises skill names/descriptions to the model, which selects a skill
with the native `skill` tool. This metadata adds prompt context; the core's 6 KB
target does not include that native catalog. Full bodies/examples are not all
injected at once. Live discovery is checked against all 195 expected names during
assistant startup; successful `skill` tool calls record only an allowlisted name.
