# OpenRive vs. Rive: differences and what changed

Written after reading Rive's own editor documentation (`rive-app/rive-docs`: Data binding, States,
Transitions, Sidebar, Selection and navigation, Stage, Inspector) and the runtime's generated core
headers (`rive-app/rive-runtime`), then comparing them with this repository.

Everything in **Changed** is implemented on this branch and verified (types, lint, 19 test suites,
production build, render checks). Everything in **Still differs** is not done, with the reason.

---

## Changed

### 1. Selection overlay lagged behind the object

`Stage.tsx` had two separate stale-state problems:

- The pointer move handler returned early whenever a drag was active, so **hover never updated during a
  pan or drag** — the outline you saw was the last one from before the drag started.
- Drag math read `doc` from the render closure instead of the store. When a store update lands between the
  handler running and React re-rendering, the scene it measured (and the artboard origin it snapped
  against) is one update behind.

Both now read the live document (`liveDoc()`), so the box, the handles, the rotate origin and the smart
guides are computed from the document that is actually on screen. If you still see the box lag after a
deselect/reselect, that is the engine canvas repainting a frame later than the SVG overlay — tell me and
I will add a requestAnimationFrame sync between the two.

### 2. Data panel (the missing data table)

The sidebar had Layers / Theme / Assets. Data binding values could only be seen inside the state machine
graph. There is now a **Data** tab (third position, matching Rive's sidebar: Hierarchy → Data → … ) with:

- **Properties** — the blueprint: view model name, one row per property with its type icon and inline
  default-value editor, right-click to rename / duplicate / delete.
- **Data table** — Rive's table: one row per property, one column per view model instance, an instance
  picker when a model has more than one, and a footer telling you which instance the preview uses.
- **Six property types**, including **Enum** (see below), with Rive's names and help text.
- A "Create view model" flow when an artboard has none, and the existing deprecated-inputs converter.

Underneath, the format layer grew: `instances()`, `previewInstance()`, `renameInstance()`, `enums()`,
`propertyEnum()`, `addEnum()`, `updateEnum()`, `addEnumProperty()`. Multiple instances now read and write
correctly (values are stored positionally after their instance, not by `parentId`).

### 3. Enum properties

Rive's sixth view-model property type was missing entirely. Now implemented against the runtime's wire
format (`ViewModelPropertyEnumCustom` / `DataEnumCustom` / `DataEnumValue` / `ViewModelInstanceEnum` /
`BindablePropertyEnum` / `TransitionValueEnumComparator`, checked against the generated headers):

- Options live in a `DataEnumCustom` followed by its values in the file-level stream.
- The property references the enum by index (`enumId`), which needed a new `dataEnum` reference space in
  `document.ts` so the id survives import/export.
- Transition conditions compare the option **key**.
- Verified: byte-identical round trip, options and reference resolve after re-import.

### 4. State machine view rebuilt to look like Rive's

The view used to be three side-by-side boxes with section headers. It now follows Rive's arrangement and
proportions, measured off Rive's own editor:

- **Full-bleed canvas** at `#181818` with a dot grid, and the chrome floating over it. The **Inputs** and
  **Listeners** strips are 30px rails down the left edge, label reading upward, each with a chevron; click
  one to unfurl its column and click again to fold it away.
- **Toolbar over the canvas** — play, a zoom percentage you can click to reset, then the layer chips
  (`Layer 1` + add) and Add state on the right, exactly the order Rive uses.
- **Nodes**: 36px tall, 8px radius, 10px inset, 12px glyph, 4px gap, 11px label, width measured from the
  text with a canvas so the chip hugs its name. **Any State** is a solid `#284c76` chip, **Exit** `#562f2f`,
  **Entry** `#446154`; animations and blends are `#333333` with a hairline border. Transitions are 1.25px
  `#7d7d7d` lines with a small arrow head and a hollow badge where conditions/actions hang off the edge.
- **Zoom** with Ctrl/Cmd + scroll; the canvas is drawn through one transform, so rule weights and radii stay
  crisp instead of scaling, and pan/drag/link/hit-testing all account for it.
- **Default layout** mirrors Rive's: Any State and Exit stacked top-left, Entry below them, real states
  flowing right, and "Select an empty state to add" in the middle of an empty layer.
- **Animations list** (timeline panel) is now Rive's single flat column: no section headers, an arrow per
  timeline, a glyph per state machine, the default entry bold, a check on the active one, and the add
  buttons in the header.

Also in the state machine:

- **Randomize exit weights** — each outgoing transition in a state's inspector now has Rive's weight
  field (`randomWeight`), shown with an explanation of when it applies.
- **State Type switch** — a state can be re-typed between Single / 1D blend / Additive after creation,
  keeping its id so transitions stay attached (Rive: "To change a state's type later, select it and change
  Type in the Inspector").
- **Labels aligned with Rive**: "Pause source when exiting", "Allow exit during transition".

### 5. Selection and navigation parity

- **Alt+click select behind** — cycles through the objects stacked under the pointer
  (new `hitTestAll()` in `scene.ts`, mirroring `hitTestShape`).
- **Enter** steps into the selected group and selects its first child; Escape already stepped back out.
- **Shortcut hygiene** — editor commands no longer fire while typing in a field, and a command that is
  currently unavailable no longer swallows its key.

### 6. Docs

MCP tool count corrected to **50** in `README.md` and `docs/architecture.md` (it said 42; the smoke test
asserts 50).

---

## Still differs from Rive

Ordered roughly by how much it would matter to a user.

### Data binding

| Rive | Here | Why |
| --- | --- | --- |
| **Lists** (repeating content via `ArtboardComponentList`) | Not supported | Needs a list property type, `ViewModelInstanceList`, list items, and a component list drawable. The format definitions exist in `core-defs.json`; this is a large feature (~1–2 weeks), not a patch. |
| **Data converters** (map one type to another, e.g. number → enum) | Not supported | `DataConverter*` types are in the schema, but nothing authors or resolves them. |
| **Nested view models**, **property groups** | Not supported | Flat property lists only. |
| Image / Font / Blob / Artboard property types | Not supported | Only Number, Boolean, Trigger, String, Color, Enum. |
| System enums, enum bindings | Custom enums only | No system enum library, no binding an enum to editor properties. |
| **Bind data to objects** (text run, fill color, artboard properties) | Only state machine conditions/listeners | The editor does not yet author `DataBind` on drawables, so a property cannot drive a text value or a fill directly. |
| Global view models, cross-artboard models | One model per artboard | |

### State machine

| Rive | Here |
| --- | --- |
| **Actions** on states, transitions, layers (set property, fire event, focus, …) | Only listener actions and fire-event-from-listener |
| **Captions** on states | Not supported (editor-only metadata; would live in `ui`) |
| Graph **selection box** / multi-select of states and transitions, with align/distribute | One selection at a time |
| **Zoom to fit** and scrollbar in the state machine view | Zoom percentage resets to 100% |
| **Additive blend** authored end to end | State type can be switched to it, but the per-timeline "mix by value / view model / input" editor is not built |
| **Capture Base State** toggle on 1D blends | Not exposed |
| **Input conditions** (`TransitionInputCondition`) for named events/inputs beyond view-model properties | View-model properties are supported; event-driven conditions are partial |
| **Blend state transitions** with exit targets (`BlendStateTransition.exitBlendAnimationId`) | Not exposed |
| Transition **interpolation** editor (cubic curve) | Values exist in the format; no curve UI for transitions |
| Per-state **speed** on blend/additive states | Single states only |

### Editor UI

| Rive | Here |
| --- | --- |
| **Split viewport** (Stage + Script/Agent side by side) | One viewport, Code panel below the stage |
| **AI Agent panel** | Code panel with automation scripts instead |
| **Layout / auto-layout** (`LayoutComponent`, `LayoutNodeStyle`) | Not authored (format understood, no UI) |
| **Components** (reusable artboards) and artboard-as-property | Nested artboards exist in the format; no component workflow |
| Panels draggable between sidebar and viewport, full-height panels | Fixed left rail / right inspector, both resizable |
| **Debug panel** (runtime logs, properties, input watch) | Preview banner + event log only |
| Assets: audio, blob import, folders, per-asset rename UI | Images, SVGs and fonts |
| Text: modifiers (follow path, ranges), rich text runs | Single-style text objects |
| **Nested artboard** data binding paths | Not exposed |
| Solo/active-component picking (`Solo.activeComponentId`) | Supported in the format; no UI affordance |
| 60+ shortcuts with per-user rebinding | Comparable set, already rebindable |

### Stage details

| Rive | Here |
| --- | --- |
| Right-click-drag pans | Right-click opens the context menu (Space-drag and wheel pan) |
| Ctrl/Cmd + scroll to zoom | Works (and trackpad pinch) |
| Separate stage background per mode (Design vs Animate) | Single stage colour |
| Tool overlays toggles (gizmos, bones, targets, motion paths, joysticks, text ranges) | Grid / rulers / guides / smart guides only |

---

## Deliberate differences (not gaps)

- **Inputs**: Rive keeps legacy state machine inputs; OpenRive converts them to view-model properties in
  one step because Rive deprecated them and runtimes warn about them.
- **Themes / theme colours**: Rive has no equivalent; this is an OpenRive extra, stored in editor metadata
  and never written into the `.riv`.
- **Editing model**: every mutation goes through one `commit()` so undo is uniform, and files must
  round-trip byte-identically — the corpus test enforces that for Rive's 437 test files.

---

## Verification run on this branch

| Check | Result |
| --- | --- |
| `bun run check-types` | 10/10 packages |
| `bun run lint` | clean |
| `bun run test` | 19/20 suites; the one failure is `rigging.test.ts` needing Chromium, which CI installs |
| `bun run build` | passes |
| MCP smoke (50 tools, rig + blend + events) | passes |
| CLI `new → export → validate` | byte-identical |
| Data panel render check (jsdom): 6 property types, table view, enum select | passes |
| State machine graph render check (jsdom) | passes |
| Enum round trip + instance values | byte-identical |
