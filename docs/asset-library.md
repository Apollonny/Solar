# Solar partner asset library

## What is installed

The library has 14 canonical partner sources. The installed cache is shared by
Solar and its legacy profile at `%APPDATA%/Solar/asset-library`; game projects
receive only explicitly selected files and their dependencies. The cache contains
the publisher editions accessible through their download pages, including free,
standard and demo editions. It does not imply access to every paid edition.
An authorized full ZIP/RAR can replace a source edition through **Files → Asset
library → Import archive**. Source archives are discarded after secure extraction;
their hashes, edition metadata and extracted file hashes remain in the inventory.

| Source | Purpose in Solar |
| --- | --- |
| Quaternius Universal Animation Library 1 / 2 | Humanoid animation rigs and measured clip metadata; retargeting required |
| Binbun Explosion FX | Godot effect scenes, shaders and transitive script classes |
| Alenia Atmospheric VFX | Pixel effect frames; explicit clip/grid configuration |
| Quaternius Stylized Nature | glTF props, terrain decoration, measured static bounds |
| JDSherbert Ambiences | Background audio scenes with explicit volume/loop settings |
| Nojoule Pixel Art Shaders | Shader material resources and original uniform defaults |
| Creative Core Grab System | Bounded Godot script/scene reference and dependencies |
| CI 400 Sounds | Short sound effects and non-autoplay audio scenes |
| Rayzn Emergency Medkit | Medical/pickup props |
| Styloo Weapons | Weapon meshes; game logic is implemented separately |
| Ludonauta Weapon System | Curated reference and publisher link; no invented asset files |
| Mana Seed Character | Real character sprites; palettes/guides excluded from runtime choices |
| Poly Haven Import | Explicit project addon install, pinned commit `4d59ae251362c20bca9f21bf02f069baa6103640` |

Creator/source/license metadata is retained in each imported provenance record.
Poly Haven is installed only through its dedicated button while the editor is
closed. Search and recommendations never enable addons or change project settings.

## Mechanism-based AI selection

The existing executor exposes `solar_asset_library`. Microsoft remains the sole
workflow owner. Its skills stage retrieves at most three candidate sources. The
developer may make focused read-only queries for other feature requirements.
The native registry stays installed, but managed system prompts list only the
skills assigned to the current stage. Unselected descriptions are omitted too.
Asset use is optional. Suitable selections can be imported automatically within
the authorized feature; manual pack selection is not required. If nothing fits,
the developer may create original or procedural content.

1. `recommend`: select a mechanic (`movement`, `combat`, `pickup`, `environment`,
   `weather`, `ambience`, `ui`, `custom`), dimension and coherent style.
2. Solar ranks compatible source kinds, then actual installed runtime files.
   Palettes, setup guides and preview images are excluded from preset choices.
3. Results contain exact source path/hash, real PNG dimensions or GLTF animation
   names/static transformed bounds, a suggested preset and deterministic `solarPath`.
   At most three concrete recipes per source are returned.
4. If changing options, query `recommend` again with exact `packId`, `path` and
   the revised `preset`. The resulting `solarPath` changes with the recipe.
5. Microsoft developer submits these selections in `ChangeSet.assetImports`;
   direct import remains denied. Legacy mode can use `action: import` while stopped.
6. Solar resolves dependencies, creates immutable wrappers, checks existing files
   and global script class conflicts, then applies through the authenticated gateway.
7. Validation, runtime interaction, original framebuffers, GdUnit4 and TEA determine
   feature completion. A recommendation or a generated prefab cannot produce PASS.

```json
{
  "action": "recommend",
  "query": "forest rock",
  "mechanic": "environment",
  "dimension": "3d",
  "style": "stylized"
}
```

## Solar-specific Godot derivatives

Source cache bytes are immutable. Presets create additional `.tscn`, `.tres`,
optional script and `.preset.json` files under `assets/library/<pack>/solar/`.
Names include the source hash and versioned recipe hash. Identical presets are
reusable; conflicting existing files block the operation.

- **Sprites:** pixel filtering, measured frame grid and first frame; optional
  explicit `SpriteFrames` animations. Every frame range must fit the real sheet.
  The exact visually checked Mana Seed base sheet has a curated 64×64 grid.
  Pose order is not treated as verified idle/walk/attack animation semantics.
- **Static models:** optional height in Godot units, floor placement and X/Z
  centering. Box collision can be static or a pickup `Area3D`. Bounds incorporate
  GLTF node transforms; animated/skinned geometry requires editor adaptation.
- **Effects:** instance the original effect scene and rebase script/shader references.
- **Animation libraries:** preserve imported rig and named clips, seed animation
  import at 30 FPS without trimming, record the retargeting requirement.
- **Audio:** separate `AudioStreamPlayer` with explicit volume and loop settings.
  Source streams are duplicated before modification; autoplay is disabled.
- **Shaders:** separate `ShaderMaterial`, preserving source shader defaults.
  The imported Nojoule 5×5 helper calls are expanded into the same 25 texture
  samples for Godot 4.7 compatibility; the source cache remains unchanged.
  Renderer and texture requirements need real project verification.

`needs-adaptation` is explicit for unknown sprite layouts, unverified animation
semantics, retargeting, unknown model bounds and shader compatibility. It does not
mean an asset is unusable, and it cannot be treated as completed evidence.

## Safety and distribution

- Archive traversal, symlinks, duplicate portable paths and corrupted ZIP entries
  are rejected. Unsupported executables/OS scripts are excluded.
- Cache reads verify exact size and SHA-256. Signed publisher download URLs and
  API credentials are never persisted in the inventory or provenance.
- Import scope: at most four packs, 24 explicit selections per pack, 120 total
  files including dependencies/derivatives, 64 MB per source and 128 MB total.
- Binary chunks are host generated; model-forged chunk commands are denied.
- Existing user files/import settings are preserved. Godot may generate adjacent
  `.uid`/`.import` metadata; unrelated revision changes still block application.
- Owned earlier Solar gateway overlays can be upgraded only after complete hash
  verification while the editor is closed. Modified addons fail closed.
- Cache acquisition is explicit. Normal application startup does not download
  packs or resolve dependencies. The application package contains the catalog and
  adapters; the shared publisher cache is outside the repository/package.

## Focused checks

`tests/asset-presets.test.ts` covers measured bounds, deterministic recipes,
sprite clipping, shader sample equivalence and mechanism/dimension/style
constraints. Managed role checks cover both the native normalized allowlist and
denial of delegation, direct writing and asset import. A connected MCP server
with denied role tools blocks before a provider request is sent. The asset gateway
fixture applies real cached sprites, mesh/collision, effect and animation rig in a
private project, validates it and captures actual 2D/3D framebuffers on both editor
backends. UI acceptance uses the real IPC/preload and drafts a request without
sending it. Acceptance artifacts are local under `.test-dist/acceptance`.

Run `npm run test:assets` for the focused pure checks. Maintainer acceptance uses
`node scripts/check-asset-library.mjs --library-only`, `--native`, or no flag for
LibGodot. These create disposable projects and never run a paid model request.

Provider acceptance is separate: the selected NVIDIA Nemotron model completed a
controlled OpenCode role, native skill load and structured JSON response using
the authorized desktop key file. A later read-only asset selection passed with a
real `solar_asset_library` call, exact installed Nature source hashes and its
deterministic Godot preset path. That scoped request used 2,740 input tokens;
the earlier unscoped attempt used 37,005. Its trace recorded one tool call, no
failed tools and confirmed cleanup. Main credentials and model settings were
preserved. This does not establish a full live NVIDIA 2D/3D development workflow
or vision/TEA acceptance. Microsoft production preview remains gated until its
separate end-to-end acceptance passes.

The production preflight now checks the selected credentials/catalogs and image
capability without generating content. A real original-framebuffer request on
the selected vision model completed with the smaller vision output budget. A
complete 3D live asset story remains blocked in planning by a truncated NVIDIA
reply after a transient retry; no product files were applied and saved settings
were unchanged. The actual OpenCode HTTP transport was separately checked at a
local endpoint: it preserves the selected reasoning budget. These checks cannot
substitute for a complete live 2D/3D feature gate.

The offline workflow acceptance now includes real native library selection,
hash-locked import and instantiated presets. In 2D, a verified 64x64 single
pose moves and collects a pickup; actual Sprite2D frame properties, the counter,
original screenshot and two GdUnit4 cases are checked. In 3D, a real Nature model
and generated static collider stop a moving CharacterBody3D, with two physics
tests plus actual input/state/framebuffer evidence. Original cache bytes remain
intact. The local deterministic model verifies the integration; it does not
certify live model judgment, animation retargeting or every pack in every game.
