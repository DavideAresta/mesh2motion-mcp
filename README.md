# Mesh2Motion MCP

An MCP server that lets an AI assistant rig and animate 3D models with [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app), the open source auto-rigging tool (think Mixamo, but for humans, foxes, birds, dragons, horses, spiders, snakes, fish and kaiju).

Load a static model, fit a skeleton template, place the joints, bind the skin, pick from the rig's animation library (178 clips for the human rig), attach props, and export a GLB or FBX. Rendered images with labelled joints and a coordinate grid let the assistant check its work at every step.

<table>
  <tr>
    <td align="center"><img src="docs/edit-front.png" width="300" alt="Front view while placing joints, with labelled joints and a world grid"></td>
    <td align="center"><img src="docs/animation-sheet.png" width="420" alt="Eight frames of a walk animation rendered as a contact sheet"></td>
  </tr>
  <tr>
    <td align="center"><sub><code>screenshot</code> during joint placement</sub></td>
    <td align="center"><sub><code>animation_sheet</code> after binding</sub></td>
  </tr>
</table>

## How it works

Mesh2Motion is a browser app (TypeScript + three.js + WebGL), so the server runs the real app instead of re-implementing it:

```
MCP client ──stdio──▶ mesh2motion-mcp (Node)
                         │  Playwright
                         ▼
                headless Chrome/Chromium
                         │  window.m2m (bridge API)
                         ▼
          Mesh2Motion engine, built from the upstream repo
```

`npm run setup` clones the upstream repository into `vendor/mesh2motion-app`, adds one extra page (`mcp-bridge.html`, a copy of the app's create page that boots the engine through [`bridge/McpBridge.ts`](bridge/McpBridge.ts)) and builds it with the app's own Vite toolchain. The bridge calls the engine's steps directly, records the app's error dialogs, and renders captures with temporary cameras. Between tool calls it pauses the app's render loop and preview videos, so an idle server doesn't keep drawing a page nobody sees (with SwiftShader that costs several CPU cores). Nothing in the upstream code is modified, so updating the app is a `git pull` and a rebuild.

## Requirements

- Node.js 20 or newer, npm and git
- A Chromium-based browser. Google Chrome or Microsoft Edge are used when installed. Otherwise Playwright's Chromium is downloaded automatically, once, into `~/.cache/ms-playwright` (about 400 MB on disk). This happens during `npm run setup`, or when the server starts if it is still missing then. On a minimal Linux server Chromium may also need its system libraries: `sudo npx playwright install-deps chromium`.
- WebGL works without a GPU through SwiftShader, so it also runs on servers and over SSH

## Setup

```bash
npm install
npm run setup
```

`setup` compiles the server, clones and builds Mesh2Motion (about 70 MB of assets) and checks for a browser. Then check everything end to end:

```bash
npm run smoke
```

It rigs the sample human, renders a few images and exports a GLB and an FBX into `output/smoke-test/`.

### Claude Code

To make the server available in every project, run this from the mesh2motion-mcp folder:

```bash
claude mcp add --scope user mesh2motion -- node "$PWD/dist/index.js"
```

To enable it for a single project instead, create a `.mcp.json` file in that project's root folder. Use the absolute path of `dist/index.js` on your machine:

```json
{
  "mcpServers": {
    "mesh2motion": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mesh2motion-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Settings from the [environment variables](#environment-variables) table go in `env`, for example `"env": { "M2M_OUTPUT_DIR": "/home/me/exports" }`. Claude Code asks you to approve a project's `.mcp.json` servers the first time it opens the project. Running `claude mcp add --scope project mesh2motion -- node /path/to/mesh2motion-mcp/dist/index.js` from the project folder writes the same file for you. `.mcp.json` holds a path that only exists on your machine, so this repository doesn't ship one and ignores it.

### Claude Desktop and other clients

Add the server to the client's MCP configuration (for Claude Desktop: Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "mesh2motion": {
      "command": "node",
      "args": ["/path/to/mesh2motion-mcp/dist/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `M2M_OUTPUT_DIR` | `./output` | Where relative export and screenshot paths are written |
| `M2M_HEADLESS` | `1` | `0` opens a visible browser window so you can watch the app work; its render loop keeps running between tool calls |
| `M2M_BROWSER_CHANNEL` | auto | Force `chrome`, `msedge` or `chromium` (Playwright's Chromium only). Auto: Playwright Chromium if installed, then Chrome, then Edge, then download Chromium |
| `M2M_AUTO_INSTALL_BROWSER` | `1` | `0` never downloads Chromium; the server reports an error when no browser is found |
| `M2M_APP_DIR` | `./vendor/mesh2motion-app` | Use another Mesh2Motion checkout (setup builds it in place) |
| `M2M_APP_REF` | default branch | Branch, tag or commit to build (setup only) |
| `M2M_APP_REPO` | upstream GitHub | Fork to clone (setup only) |

## Tools

The pipeline is a sequence of steps; tools say which step they need and what to call first when used too early.

| Step | Tool | What it does |
| --- | --- | --- |
| any | `status` | Current step, model, skeleton, animation state, recent app dialogs |
| any | `list_catalog` | Rig types, sample models, hand options, prop ids, export options |
| any | `load_model` | Fresh session + import a `.glb`, `.fbx`, `.zip` (glTF with bin/textures) or a sample model |
| any | `reset` | Reload the app |
| load_skeleton | `transform_model` | Rotate, scale, set height, center, put on the floor (baked into the mesh) |
| load_skeleton+ | `analyze_model` | Mesh slices with solid spans per height, to find crotch, shoulders, neck… |
| load_skeleton | `select_skeleton` | Rig type, hand setup, scale (`"auto"` fits the rig's reference model) with live preview |
| load_skeleton | `confirm_skeleton` | Load the rig and start editing joints |
| edit/animations | `get_bones` | Bones with parent, world joint position and mirror counterpart |
| edit_skeleton | `set_bones` | Absolute positions, offsets or rotations; mirrors left/right; children follow or stay |
| edit_skeleton | `edit_history` | Undo / redo joint edits |
| edit_skeleton | `set_skinning_options` | Head and arm weight corrections (human), weight-paint preview |
| edit_skeleton | `bind_skin` | Compute weights, create the skinned mesh, load the animation library |
| animations | `go_back_to_step` | Back to joints (kept) or to rig selection |
| animations | `list_animations` | Names and durations, with a word filter |
| animations | `play_animation` | Play, or freeze at a time for a screenshot |
| animations | `animation_sheet` | N frames of an animation in one image, fixed camera |
| animations | `set_animation_options` | Mirror all animations, A-pose arm correction (human) |
| animations | `set_props` | Weapons and tools in either hand (human, kaiju) |
| animations | `import_animations` | Add custom `.glb` animations made for the same rig |
| animations | `export` | GLB or FBX (Unreal/Unity preset), mesh or skeleton only, Mixamo bone names (human), per-clip mirroring |
| any | `screenshot` | Front/back/left/right/top/bottom (orthographic, with a world grid) or perspective; joints drawn with names |

Coordinates are world space: Y up, the character faces +Z and its own left side is +X. In screenshots, cyan joints are on the left side, orange on the right, yellow on the center line.

## Example session

> Rig `~/models/knight.glb` as a human, make sure the elbows and knees line up, then export it as FBX for Unity with an idle, a walk, a run and a sword attack.

A typical run:

1. `load_model {path}` → `transform_model {align_to_floor, center_xz}` if needed
2. `select_skeleton {type: "human", scale: "auto"}` → `screenshot {view: "front"}`
3. `confirm_skeleton` → `screenshot` front and left, `analyze_model` → `set_bones` (e.g. `{"name": "lowerarm_l", "position": [0.48, 1.41, -0.03]}`, mirrored to `lowerarm_r`)
4. `set_skinning_options {preview: "weights"}` + `screenshot` to inspect the influence areas
5. `bind_skin` → `list_animations {filter: "sword"}` → `animation_sheet {name: "Sword_Attack"}`
6. `export {output_path: "knight", format: "fbx", fbx_preset: "unity", animations: ["Idle", "Walk", "Run", "Sword_Attack"]}`

## Keeping Mesh2Motion up to date

```bash
npm run setup-app -- --update        # git pull + rebuild
M2M_APP_REF=<tag-or-commit> npm run setup-app -- --update
```

If an upstream change breaks the bridge, the smoke test shows which step fails. Bridge code lives in `bridge/`; after editing it run `npm run rebuild-bridge`.

## Development

```bash
npm run build            # compile the server (src/ → dist/)
npm run rebuild-bridge   # copy bridge/ into the app and rebuild it
npm run smoke            # end-to-end test through an MCP client
npm run inspect          # MCP Inspector UI
node scripts/smoke-test.mjs --model path/to/model.glb --type fox
```

## Limitations

- One session per server process: the app is a single stateful 3D scene, so tool calls are queued.
- Mesh2Motion's separate retargeting page (moving its animations onto an already rigged model) is not exposed yet.
- Exports always contain at least one animation; that is how Mesh2Motion's exporter works.
- Joint placement is not automatic in Mesh2Motion. The assistant places joints from screenshots, `get_bones` and `analyze_model`.

## Credits

[Mesh2Motion](https://mesh2motion.org) by the Mesh2Motion contributors: code under MIT, models, rigs and animations under CC0. This server only automates it; support the project at <https://support.mesh2motion.org/>.
