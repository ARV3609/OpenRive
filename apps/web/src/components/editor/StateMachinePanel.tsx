'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowRight,
  Asterisk,
  Braces,
  ChevronDown,
  CornerDownRight,
  Hash,
  MousePointerClick,
  Palette,
  Play,
  Plus,
  Square,
  ToggleLeft,
  Trash2,
  Layers,
  Type,
  Zap,
  Radio,
} from 'lucide-react';
import { ArtboardDoc, CoreObj, RiveDoc } from '@openrive/rive/document';
import { newLayer, obj } from '@openrive/rive/factory';
import { findArtboard, findObj } from '@openrive/rive/ops';
import { prop } from '@openrive/rive/scene';
import { addBlendState as createBlendState, addEvent as addArtboardEvent, removeEvent, renameEvent } from '@openrive/rive/api';
import { isA } from '@openrive/rive/schema';
import {
  addProperty,
  convertInputsToProperties,
  artboardViewModel,
  decodePath,
  properties as dataProperties,
  PropertyDoc,
  PropertyType,
  propertyValue,
  propertyListenerAction,
  propertyCondition,
  removeProperty,
  renameProperty,
  renameViewModel,
  setPropertyValue,
  usesInputs,
} from '@openrive/rive/databind';
import { toast } from '@/lib/client/toast';
import { useActiveArtboard, useEditor } from '@/lib/store/editor';
import { promptDialog, TabStrip } from '@openrive/ui';
import { NumberField, Row, Select, TextField } from './controls';
import { displayName } from './Hierarchy';
import { engineRef } from './engineRef';
import { MenuItem, openContextMenu, sep } from './ContextMenu';

// Rive's graph nodes are compact rounded chips. Measured off Rive's editor at 100%:
// 36px tall, 8px radius, 10px inset, 12px icon, 4px gap, 11px label. A special
// state (Any State, Exit, Entry) is a solid tinted chip with no border; an animation
// or blend state is a #333333 chip with a subtle border.
const NODE_H = 36;
const NODE_ICON = 12;
const NODE_GAP = 4;
const NODE_PAD = 10;
/** what a node is worth before any label */
const NODE_CHROME = NODE_PAD + NODE_ICON + NODE_GAP + NODE_PAD;
const NODE_MIN_W = 44;
const NODE_MAX_W = 200;
const EMPTY_HINT = 'Select an empty state to add';

type StateKind = 'entry' | 'any' | 'exit' | 'animation' | 'blend';

/** Sampled from Rive's editor: special states are solid tinted chips. */
const STATE_TINTS: Record<StateKind, string> = {
  entry: '#446154',
  any: '#284c76',
  exit: '#562f2f',
  animation: '#333333',
  blend: '#3d3550',
};

/** Entry, Any State and Exit are drawn differently from an animation state. */
function stateKind(st: CoreObj): StateKind {
  if (st.type === 'EntryState') return 'entry';
  if (st.type === 'AnyState') return 'any';
  if (st.type === 'ExitState') return 'exit';
  const name = String(st.props.name ?? '');
  const blend = isA(st.type, 'BlendState') || isA(st.type, 'BlendAnimation') || name.startsWith('Blend');
  return blend ? 'blend' : 'animation';
}

/**
 * A node label, measured with a canvas so the chip hugs its text exactly the way
 * Rive's does. Falling back to a per-character estimate keeps this usable in
 * tests and during server rendering, where no canvas exists.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function labelWidth(text: string) {
  const font = '11px "IBM Plex Sans", system-ui, sans-serif';
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  return text.length * 5.7;
}

/** Half the visual footprint of a node, per state, in graph units. */
function nodeSize(st: CoreObj, ab: ArtboardDoc) {
  const text = stateLabel(ab, st);
  const width = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, Math.round(labelWidth(text) + NODE_CHROME)));
  return { width, height: NODE_H, cx: width / 2, cy: NODE_H / 2 };
}

function useSM() {
  const ab = useActiveArtboard();
  const smId = useEditor((s) => s.stateMachineId);
  const layerId = useEditor((s) => s.layerId);
  const sm = ab?.stateMachines.find((m) => m.id === smId);
  const layers = (sm?.children ?? []).filter((c) => isA(c.type, 'StateMachineLayer'));
  const layer = layers.find((l) => l.id === layerId) ?? layers[0];
  return { ab, sm, layers, layer };
}

/** Mutates the current state machine inside a commit. */
function editSM(abId: string, smId: string, fn: (sm: CoreObj, ab: ArtboardDoc, doc: RiveDoc) => void) {
  useEditor.getState().commit((d) => {
    const ab = findArtboard(d, abId);
    const sm = ab?.stateMachines.find((m) => m.id === smId);
    if (ab && sm) fn(sm, ab, d);
  });
}

const PROPERTY_ICONS: Record<PropertyType, React.ReactNode> = {
  number: <Hash size={13} />,
  enum: <Braces size={13} />,
  boolean: <ToggleLeft size={13} />,
  trigger: <Zap size={13} />,
  string: <Type size={13} />,
  color: <Palette size={13} />,
};

/**
 * Re-types a state, keeping its id so transitions keep pointing at it — Rive
 * lets you change a state between Single, 1D and Additive after creating it.
 * Children that only make sense for the old type (blend animations) are dropped.
 */
const STATE_TYPES: Record<string, string> = {
  single: 'AnimationState',
  blend1d: 'BlendState1DInput',
  blendDirect: 'BlendStateDirect',
};

function retypeState(state: CoreObj, kind: string, ab: ArtboardDoc): boolean {
  const next = STATE_TYPES[kind];
  if (!next || state.type === next) return false;
  state.type = next;
  if (next === 'AnimationState') {
    if (state.props.inputId !== undefined) delete state.props.inputId;
    if (state.props.animationId === undefined) {
      const first = ab.animations[0];
      if (first) state.props.animationId = first.id;
    }
    state.children = (state.children ?? []).filter((c) => !isA(c.type, 'BlendAnimation'));
  } else if (next === 'BlendState1DInput') {
    // 1D blends need at least one timeline entry to show anything
    const keep = (state.children ?? []).filter((c) => isA(c.type, 'BlendAnimation'));
    state.children = keep.length
      ? keep
      : ab.animations.slice(0, 1).map((a, i) => obj('BlendAnimation1D', { animationId: a.id, value: i * 100 }));
  } else {
    const keep = (state.children ?? []).filter((c) => isA(c.type, 'BlendAnimation'));
    state.children = keep.length
      ? keep
      : ab.animations.slice(0, 2).map((a) => obj('BlendAnimationDirect', { animationId: a.id, mixValue: 100, blendSource: 0 }));
  }
  return true;
}

function stateLabel(ab: ArtboardDoc, st: CoreObj) {
  if (st.type === 'EntryState') return 'Entry';
  if (st.type === 'AnyState') return 'Any State';
  if (st.type === 'ExitState') return 'Exit';
  if (st.type === 'AnimationState') {
    const a = ab.animations.find((x) => x.id === st.props.animationId);
    return a ? String(a.props.name ?? 'Timeline') : 'No timeline';
  }
  if (st.type === 'BlendState1DInput') return '1D Blend';
  return st.type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function defaultPos(st: CoreObj, i: number, states: CoreObj[]): { x: number; y: number } {
  // Rive's default layout: Any State and Exit stack in a column on the left, Entry
  // sits just below them and feeds the first real state, and the rest flow right.
  if (st.type === 'AnyState') return { x: 30, y: 52 };
  if (st.type === 'ExitState') return { x: 30, y: 96 };
  if (st.type === 'EntryState') return { x: 30, y: 150 };
  const k = states.filter((s, j) => j < i && !['AnyState', 'EntryState', 'ExitState'].includes(s.type)).length;
  return { x: 150 + (k % 3) * 150, y: 93 + Math.floor(k / 3) * 66 };
}

function usePreviewInputs() {
  return useSyncExternalStore(
    (cb) => {
      const e = engineRef.current;
      if (!e) return () => {};
      const off = e.subscribe(cb);
      return () => {
        off();
      };
    },
    () => engineRef.current?.inputs ?? EMPTY,
    () => EMPTY,
  );
}
const EMPTY: never[] = [];

/**
 * A collapsed panel in Rive's state machine view is a thin vertical strip with a
 * chevron, the label reading upward and a dot when the panel has entries. Clicking
 * it unfurls the column; clicking again folds it away.
 */
function RailButton({
  label,
  open,
  count,
  onToggle,
  icon,
}: {
  label: string;
  open: boolean;
  count: number;
  onToggle: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      className={`w-[30px] shrink-0 flex flex-col items-center pt-2.5 gap-2 border-r border-line ${open ? 'bg-[#1e1e1e] text-t0' : 'bg-[#181818] text-t1 hover:text-t0'}`}
      title={`${open ? 'Hide' : 'Show'} ${label.toLowerCase()} (${count})`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-90' : '-rotate-90'}`} />
      <span className="[writing-mode:vertical-rl] text-[11px] tracking-wide">{label}</span>
      {icon}
      {count > 0 && !open && <span className="w-1.5 h-1.5 rounded-full bg-editor-accent" />}
    </button>
  );
}

/** The empty state's placeholder chip, from Rive's "Select an empty state to add". */
function EmptyHint() {
  return (
    <div className="absolute inset-0 grid place-items-center pointer-events-none">
      <span className="flex items-center gap-1.5 text-t3 text-[11px]">
        <CornerDownRight size={11} /> {EMPTY_HINT}
      </span>
    </div>
  );
}

export function StateMachineGraph() {
  const { ab, sm, layers, layer } = useSM();
  const previewing = useEditor((s) => s.previewing);
  const readOnly = useEditor((s) => s.readOnly);
  const smSelection = useEditor((s) => s.smSelection);
  const [panelOpen, setPanelOpen] = useState<'data' | 'listeners' | 'events' | null>('data');
  const [addMenu, setAddMenu] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const graphRef = useRef<HTMLDivElement>(null);
  const liveInputs = usePreviewInputs();
  const doc = useEditor((st) => st.doc);
  const s = useEditor.getState();

  const togglePanel = (which: 'data' | 'listeners' | 'events') => setPanelOpen((open) => (open === which ? null : which));
  useEffect(() => {
    const close = () => setAddMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const states = useMemo(() => (layer?.children ?? []).filter((c) => isA(c.type, 'LayerState')), [layer]);
  const posOf = (st: CoreObj, i: number) => ({ ...defaultPos(st, i, states), ...(st.ui as { x?: number; y?: number }) }) as { x: number; y: number };

  if (!ab || !sm) return null;
  const inputs = (sm.children ?? []).filter((c) => isA(c.type, 'StateMachineInput'));
  const listeners = (sm.children ?? []).filter((c) => isA(c.type, 'StateMachineListener'));

  const addInput = (type: 'StateMachineNumber' | 'StateMachineBool' | 'StateMachineTrigger') => {
    const base = type === 'StateMachineNumber' ? 'Number' : type === 'StateMachineBool' ? 'Boolean' : 'Trigger';
    let n = 1;
    while (inputs.some((i) => i.props.name === `${base} ${n}`)) n++;
    const input = obj(type, { name: `${base} ${n}` });
    editSM(ab.id, sm.id, (m) => {
      m.children ??= [];
      // inputs are listed before layers
      const firstLayer = m.children.findIndex((c) => !isA(c.type, 'StateMachineInput'));
      if (firstLayer < 0) m.children.push(input);
      else m.children.splice(firstLayer, 0, input);
    });
    s.set('smSelection', { kind: 'input', id: input.id });
  };

  const props = ab && doc ? dataProperties(doc, ab) : [];
  const viewModel = ab && doc ? artboardViewModel(doc, ab) : undefined;
  const events = ab?.objects.filter((o) => o.type === 'Event') ?? [];
  const legacyInputs = ab ? usesInputs(ab) : false;

  /** Runs an edit against the live document and this artboard, as one undo step. */
  const editData = (fn: (d: RiveDoc, artboard: ArtboardDoc) => void) => {
    if (!ab) return;
    s.commit((d) => {
      const target = findArtboard(d, ab.id);
      if (target) fn(d, target);
    });
  };

  const addDataProperty = (type: PropertyType) => {
    const base = type[0]!.toUpperCase() + type.slice(1);
    let n = 1;
    while (props.some((x) => x.name === `${base} ${n}`)) n++;
    editData((d, artboard) => {
      addProperty(d, artboard, { name: `${base} ${n}`, type, value: type === 'trigger' ? undefined : type === 'string' ? '' : 0 });
    });
  };

  const createEvent = () => {
    if (!ab || !doc) return;
    let n = 1;
    while (events.some((e) => e.props.name === `Event ${n}`)) n++;
    try {
      s.commit((d) => { addArtboardEvent(d, { artboard: ab.id, name: `Event ${n}` }); });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not add event');
    }
  };

  const addEventProperty = (eventId: string, type: 'CustomPropertyNumber' | 'CustomPropertyBoolean' | 'CustomPropertyString' | 'CustomPropertyColor') => {
    if (!ab) return;
    const base = type === 'CustomPropertyBoolean' ? 'Boolean' : type === 'CustomPropertyNumber' ? 'Number' : type === 'CustomPropertyColor' ? 'Color' : 'String';
    const current = ab.objects.filter((item) => item.props.parentId === eventId && isA(item.type, 'CustomProperty'));
    let n = 1;
    while (current.some((item) => item.props.name === `${base} ${n}`)) n++;
    s.commit((d) => {
      const artboard = findArtboard(d, ab.id);
      if (artboard) artboard.objects.push(obj(type, {
        name: `${base} ${n}`,
        parentId: eventId,
        ...(type === 'CustomPropertyNumber' ? { propertyValue: 0 } : {}),
        ...(type === 'CustomPropertyBoolean' ? { propertyValue: false } : {}),
        ...(type === 'CustomPropertyString' ? { propertyValue: '' } : {}),
        ...(type === 'CustomPropertyColor' ? { propertyValue: 0xffffffff } : {}),
      }));
    });
  };

  const convert = () => {
    let summary = '';
    editData((d, artboard) => {
      const r = convertInputsToProperties(d, artboard);
      summary =
        `Converted ${r.properties.length} input${r.properties.length === 1 ? '' : 's'} to data binding` +
        (r.kept.length ? ` — kept ${r.kept.map((k) => `"${k.name}" (${k.reason})`).join(', ')}` : '');
    });
    if (summary) toast(summary, 6000);
  };

  const addListener = () => {
    const target = s.selection.find((id) => findObj(ab, id)?.type === 'Shape') ?? ab.objects.find((o) => o.type === 'Shape')?.id;
    const l = obj('StateMachineListenerSingle', { name: 'Listener', listenerTypeValue: 2, ...(target ? { targetId: target } : {}) }, []);
    editSM(ab.id, sm.id, (m) => {
      m.children ??= [];
      m.children.push(l);
    });
    s.set('smSelection', { kind: 'listener', id: l.id });
  };

  const addState = (animationId: string | null, at?: { x: number; y: number }) => {
    if (!layer) return;
    const st = obj('AnimationState', { animationId: animationId ?? '' }, []);
    st.ui = at ?? { x: 240 + (states.length % 3) * 170, y: 40 + Math.floor(states.length / 3) * 70 };
    editSM(ab.id, sm.id, (m) => {
      const l = m.children?.find((c) => c.id === layer.id);
      l?.children?.push(st);
    });
    s.set('smSelection', { kind: 'state', id: st.id });
  };

  const addBlendState = () => {
    if (!layer) return;
    let stateId = '';
    editSM(ab.id, sm.id, (_m, _artboard, doc) => {
      const state = createBlendState(doc, {
        artboard: ab.id,
        stateMachine: sm.id,
        layer: layer.id,
        animations: ab.animations.map((animation, index) => ({ animation: animation.id, value: index })),
        x: 240 + (states.length % 3) * 170,
        y: 40 + Math.floor(states.length / 3) * 70,
      });
      stateId = state.id;
    });
    if (stateId) s.set('smSelection', { kind: 'state', id: stateId });
  };

  const addLayer = () => {
    const l = newLayer(`Layer ${layers.length + 1}`);
    editSM(ab.id, sm.id, (m) => {
      m.children ??= [];
      // layers go after inputs
      const lastLayer = m.children.map((c) => isA(c.type, 'StateMachineLayer') || isA(c.type, 'StateMachineInput')).lastIndexOf(true);
      m.children.splice(lastLayer + 1, 0, l);
    });
    s.set('layerId', l.id);
  };

  const graphPoint = (e: { clientX: number; clientY: number }) => {
    const r = graphRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom - pan.x, y: (e.clientY - r.top) / zoom - pan.y };
  };

  const dragNode = (e: React.PointerEvent, st: CoreObj, i: number) => {
    e.stopPropagation();
    s.set('smSelection', { kind: 'state', id: st.id });
    if (readOnly || previewing) return;
    const start = graphPoint(e);
    const p0 = posOf(st, i);
    s.beginGesture();
    const move = (ev: PointerEvent) => {
      const p = graphPoint(ev);
      editSM(ab.id, sm.id, (m) => {
        const l = m.children?.find((c) => c.id === layer!.id);
        const t = l?.children?.find((c) => c.id === st.id);
        if (t) t.ui = { ...t.ui, x: Math.round(p0.x + p.x - start.x), y: Math.round(p0.y + p.y - start.y) };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      s.endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startLink = (e: React.PointerEvent, st: CoreObj) => {
    e.stopPropagation();
    if (readOnly || previewing || st.type === 'ExitState') return;
    const p = graphPoint(e);
    setLinking({ from: st.id, x: p.x, y: p.y });
    const move = (ev: PointerEvent) => {
      const q = graphPoint(ev);
      setLinking((l) => (l ? { ...l, x: q.x, y: q.y } : l));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLinking(null);
      const q = graphPoint(ev);
      const target = states.find((t, i) => {
        const tp = posOf(t, i);
        const size = nodeSize(t, ab);
        return q.x >= tp.x && q.x <= tp.x + size.width && q.y >= tp.y && q.y <= tp.y + size.height;
      });
      if (!target || target.id === st.id || target.type === 'EntryState' || target.type === 'AnyState') return;
      const tr = obj('StateTransition', { stateToId: target.id }, []);
      editSM(ab.id, sm.id, (m) => {
        const l = m.children?.find((c) => c.id === layer!.id);
        const from = l?.children?.find((c) => c.id === st.id);
        if (from) (from.children ??= []).push(tr);
      });
      s.set('smSelection', { kind: 'transition', id: tr.id });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const panGraph = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as Element).closest('svg[data-bg]')) return;
    s.set('smSelection', null);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const p0 = pan;
    const move = (ev: PointerEvent) => setPan({ x: p0.x + ev.clientX - x0, y: p0.y + ev.clientY - y0 });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // transitions
  const edges: { tr: CoreObj; from: CoreObj; to: CoreObj; fi: number; ti: number }[] = [];
  states.forEach((st, fi) => {
    for (const tr of (st.children ?? []).filter((c) => isA(c.type, 'StateTransition'))) {
      const ti = states.findIndex((t) => t.id === tr.props.stateToId);
      if (ti >= 0) edges.push({ tr, from: st, to: states[ti], fi, ti });
    }
  });
  /** Node centre in graph units, using the measured chip width. */
  const center = (st: CoreObj, i: number) => {
    const p = posOf(st, i);
    const size = nodeSize(st, ab);
    return { x: p.x + size.cx, y: p.y + size.cy };
  };
  const togglePreview = () => {
    s.set('previewing', !previewing);
    s.set('playing', false);
  };
  /** Graph zoom, matching Rive's percentage control in the state machine toolbar. */
  const zoomBy = (factor: number) => setZoom((z) => Math.min(2.5, Math.max(0.2, Math.round(z * factor * 100) / 100)));

  // Rive's state machine view is a full-bleed canvas with the chrome floating on top
  // of it: two icon rails on the left (Inputs, Listeners) that open as columns, a
  // toolbar row over the canvas, and an empty-state hint in the middle. The graph
  // itself is measured in graph units and drawn through one transform, so zooming
  // keeps the line weights and corner radii crisp instead of scaling them.
  const panelBody = () => (
    <>

          {panelOpen === 'data' && (
            <>
              {viewModel && (
                <div className="px-2 py-2 mb-1 rounded bg-bg2">
                  <div className="text-t3 text-[10px] uppercase tracking-wide mb-1">Artboard view model</div>
                  <TextField
                    value={viewModel.name}
                    className="h-7"
                    disabled={readOnly}
                    onChange={(name) => editData((d, artboard) => {
                      try { renameViewModel(d, artboard, name); } catch (error) { toast(error instanceof Error ? error.message : 'Could not rename view model'); }
                    })}
                  />
                </div>
              )}
              {props.map((property) => (
                <PropertyRow key={property.obj.id} property={property} readOnly={readOnly} onEdit={editData} />
              ))}
              {!readOnly && (
                <div className="relative mt-1">
                  <button
                    className="btn h-7 w-full"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddMenu(addMenu === 'property' ? null : 'property');
                    }}
                  >
                    <Plus size={13} /> Add property
                  </button>
                  {addMenu === 'property' && (
                    <div className="menu absolute left-0 right-0 top-8">
                      {(['number', 'boolean', 'trigger', 'string', 'color'] as PropertyType[]).map((t) => (
                        <button key={t} className="menu-item capitalize" onClick={() => addDataProperty(t)}>
                          {PROPERTY_ICONS[t]} {t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!props.length && !legacyInputs && (
                <p className="text-t3 text-[11px] mt-2 px-1">
                  Properties drive transitions and are what your code sets at runtime. They replace state machine inputs, which Rive deprecated.
                </p>
              )}
              {legacyInputs && (
                <div className="mt-3 p-2 rounded border border-line bg-bg2">
                  <div className="flex items-center gap-1.5 text-[11px] text-t1">
                    <Braces size={12} /> Deprecated inputs
                  </div>
                  <p className="text-t3 text-[11px] mt-1">Rive deprecated state machine inputs. Converting keeps the behaviour and drops the runtime warnings.</p>
                  {!readOnly && (
                    <button className="btn h-7 w-full mt-2" onClick={convert}>
                      Convert to data binding
                    </button>
                  )}
                </div>
              )}
              {inputs.map((inp) => {
                const live = liveInputs.find((l) => l.name === inp.props.name);
                const sel = smSelection?.kind === 'input' && smSelection.id === inp.id;
                return (
                  <div
                    key={inp.id}
                    className={`flex items-center gap-2 h-8 px-2 rounded ${sel ? 'bg-[#2a4a66]' : 'hover:bg-bg2'}`}
                    onClick={() => s.set('smSelection', { kind: 'input', id: inp.id })}
                  >
                    <span className="text-t2">
                      {inp.type === 'StateMachineNumber' ? <Hash size={13} /> : inp.type === 'StateMachineBool' ? <ToggleLeft size={13} /> : <Zap size={13} />}
                    </span>
                    <span className="flex-1 truncate">{String(inp.props.name ?? '')}</span>
                    {previewing && live && live.type === 'number' && (
                      <div className="w-16" onClick={(e) => e.stopPropagation()}>
                        <NumberField value={Number(live.value)} onChange={(v) => engineRef.current?.setInput(live.name, v)} />
                      </div>
                    )}
                    {previewing && live && live.type === 'bool' && (
                      <input
                        type="checkbox"
                        checked={!!live.value}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => engineRef.current?.setInput(live.name, e.target.checked)}
                      />
                    )}
                    {previewing && live && live.type === 'trigger' && (
                      <button
                        className="btn h-6 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          engineRef.current?.setInput(live.name, true);
                        }}
                      >
                        Fire
                      </button>
                    )}
                    {!previewing && inp.type !== 'StateMachineTrigger' && (
                      <span className="text-t2 text-[11px]">
                        {inp.type === 'StateMachineBool' ? (prop<boolean>(inp, 'value') ? 'true' : 'false') : prop(inp, 'value')}
                      </span>
                    )}
                  </div>
                );
              })}
              {!readOnly && (
                <div className="relative mt-1">
                  <button
                    className="btn h-7 w-full"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddMenu(addMenu === 'input' ? null : 'input');
                    }}
                  >
                    <Plus size={13} /> Add deprecated input
                  </button>
                  {addMenu === 'input' && (
                    <div className="menu absolute left-0 right-0 top-8">
                      <button className="menu-item" onClick={() => addInput('StateMachineNumber')}>
                        <Hash size={13} /> Number
                      </button>
                      <button className="menu-item" onClick={() => addInput('StateMachineBool')}>
                        <ToggleLeft size={13} /> Boolean
                      </button>
                      <button className="menu-item" onClick={() => addInput('StateMachineTrigger')}>
                        <Zap size={13} /> Trigger
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {panelOpen === 'listeners' && (
            <>
              {listeners.map((l) => {
                const sel = smSelection?.kind === 'listener' && smSelection.id === l.id;
                const target = typeof l.props.targetId === 'string' ? findObj(ab, l.props.targetId) : undefined;
                return (
                  <div
                    key={l.id}
                    className={`flex items-center gap-2 h-8 px-2 rounded ${sel ? 'bg-[#2a4a66]' : 'hover:bg-bg2'}`}
                    onClick={() => s.set('smSelection', { kind: 'listener', id: l.id })}
                  >
                    <MousePointerClick size={13} className="text-t2" />
                    <span className="flex-1 truncate">{String(l.props.name || 'Listener')}</span>
                    <span className="text-t2 text-[11px] truncate max-w-[80px]">{target ? displayName(target) : 'no target'}</span>
                  </div>
                );
              })}
              {!readOnly && (
                <button className="btn h-7 w-full mt-1" onClick={addListener}>
                  <Plus size={13} /> Add listener
                </button>
              )}
              <p className="text-t3 text-[11px] mt-2 px-1">Listeners react to pointer events on a target shape and set properties (or inputs). Try them in Preview.</p>
            </>
          )}
          {panelOpen === 'events' && (
            <div className="flex flex-col gap-2">
              <p className="text-t3 text-[11px] px-1">Named events can be fired by listeners and reported by the Rive runtime.</p>
              {events.map((event) => (
                <div key={event.id} className="rounded bg-bg2 p-2">
                  <div className="flex items-center gap-1.5 group">
                    <Radio size={13} className="text-t2 shrink-0" />
                    <TextField
                      value={String(event.props.name ?? 'Event')}
                      className="h-6"
                      disabled={readOnly}
                      onChange={(name) => s.commit((d) => {
                        try { renameEvent(d, event.id, name, ab.id); } catch (error) { toast(error instanceof Error ? error.message : 'Could not rename event'); }
                      })}
                    />
                    {!readOnly && <button className="icon-btn w-5 h-5" title="Delete event" onClick={() => s.commit((d) => { removeEvent(d, event.id, ab.id); })}><Trash2 size={11} /></button>}
                  </div>
                  <div className="mt-1 flex flex-col gap-1">
                    {ab.objects.filter((item) => item.props.parentId === event.id && isA(item.type, 'CustomProperty')).map((field) => (
                      <div key={field.id} className="flex items-center gap-1.5 px-1">
                        <span className="truncate flex-1 text-[11px] text-t2">{String(field.props.name ?? 'Property')}</span>
                        {field.type === 'CustomPropertyNumber' && <div className="w-16"><NumberField value={Number(field.props.propertyValue ?? 0)} disabled={readOnly} onChange={(propertyValue) => s.commit((d) => { const a = findArtboard(d, ab.id); const item = a?.objects.find((o) => o.id === field.id); if (item) item.props.propertyValue = propertyValue; })} /></div>}
                        {field.type === 'CustomPropertyBoolean' && <input type="checkbox" checked={!!field.props.propertyValue} disabled={readOnly} onChange={(e) => s.commit((d) => { const a = findArtboard(d, ab.id); const item = a?.objects.find((o) => o.id === field.id); if (item) item.props.propertyValue = e.target.checked; })} />}
                        {field.type === 'CustomPropertyString' && <div className="w-20"><TextField value={String(field.props.propertyValue ?? '')} disabled={readOnly} onChange={(propertyValue) => s.commit((d) => { const a = findArtboard(d, ab.id); const item = a?.objects.find((o) => o.id === field.id); if (item) item.props.propertyValue = propertyValue; })} /></div>}
                        {field.type === 'CustomPropertyColor' && <input type="color" className="w-8 h-6" value={`#${((Number(field.props.propertyValue ?? 0xffffffff) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`} disabled={readOnly} onChange={(e) => s.commit((d) => { const a = findArtboard(d, ab.id); const item = a?.objects.find((o) => o.id === field.id); if (item) item.props.propertyValue = (0xff000000 | parseInt(e.target.value.slice(1), 16)) >>> 0; })} />}
                        {!readOnly && <button className="icon-btn w-5 h-5" title="Remove property" onClick={() => s.commit((d) => { const a = findArtboard(d, ab.id); if (a) a.objects = a.objects.filter((o) => o.id !== field.id); })}><Trash2 size={10} /></button>}
                      </div>
                    ))}
                    {!readOnly && <Select value="" className="mt-1" options={[{ value: '', label: '+ Add event property…' }, { value: 'CustomPropertyNumber', label: 'Number' }, { value: 'CustomPropertyBoolean', label: 'Boolean' }, { value: 'CustomPropertyString', label: 'String' }, { value: 'CustomPropertyColor', label: 'Color' }]} onChange={(type) => addEventProperty(event.id, type as 'CustomPropertyNumber' | 'CustomPropertyBoolean' | 'CustomPropertyString' | 'CustomPropertyColor')} />}
                  </div>
                </div>
              ))}
              {!readOnly && <button className="btn h-7 w-full" onClick={createEvent}><Plus size={13} /> Add event</button>}
              {!events.length && <div className="text-t3 text-[11px] text-center py-3">No events yet</div>}
            </div>
          )}
    </>
  );

  return (
    <div className="flex-1 flex min-w-0 relative bg-[#181818]">
      {/* icon rails: unfurl a column when clicked, exactly like Rive's Inputs/Listeners */}
      <div className="flex shrink-0 z-20">
        <RailButton
          label="Inputs"
          icon={<Braces size={11} className={panelOpen === 'data' ? 'text-editor-accent' : 'text-t3'} />}
          open={panelOpen === 'data'}
          count={props.length}
          onToggle={() => togglePanel('data')}
        />
        <RailButton
          label="Listeners"
          icon={<MousePointerClick size={11} className={panelOpen === 'listeners' ? 'text-editor-accent' : 'text-t3'} />}
          open={panelOpen === 'listeners'}
          count={listeners.length}
          onToggle={() => togglePanel('listeners')}
        />
      </div>

      {panelOpen && (
        <div className="w-[218px] shrink-0 border-r border-line bg-[#191919] flex flex-col z-10">
          <TabStrip
            className="border-b border-line shrink-0"
            items={[
              { id: 'data', label: 'Inputs' },
              { id: 'listeners', label: 'Listeners' },
              { id: 'events', label: 'Events' },
            ]}
            value={panelOpen}
            onChange={(next) => setPanelOpen(next)}
          />
          <div className="flex-1 overflow-auto p-1.5">{panelBody()}</div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* toolbar over the canvas */}
        <div className="absolute inset-x-0 top-0 h-[34px] z-10 flex items-center gap-1 px-2.5">
          <button
            className="icon-btn w-6 h-6"
            title={previewing ? 'Stop preview' : 'Play the state machine (Preview)'}
            onClick={togglePreview}
          >
            {previewing ? <Square size={11} /> : <Play size={12} />}
          </button>
          <button
            className="flex items-center gap-0.5 h-6 px-1.5 rounded text-t1 text-[11px] hover:bg-bg3 tabular-nums"
            title="Zoom. Click to reset to 100%."
            onClick={() => setZoom(1)}
          >
            <ChevronDown size={10} />
            {Math.round(zoom * 100)}%
          </button>
          <div className="flex-1" />
          <div className="flex items-center h-[26px] rounded-md bg-[#202020] border border-[#2b2b2b] overflow-hidden">
            {layers.map((l) => (
              <button
                key={l.id}
                className={`px-2.5 h-full text-[11px] ${l.id === layer?.id ? 'bg-[#2f2f2f] text-t0' : 'text-t2 hover:text-t0'}`}
                onClick={() => s.set('layerId', l.id)}
                onDoubleClick={async () => {
                  if (readOnly) return;
                  const name = await promptDialog({ title: 'Rename layer', label: 'Layer name', defaultValue: String(l.props.name ?? ''), confirmLabel: 'Rename' });
                  if (name) editSM(ab.id, sm.id, (m) => void (m.children!.find((c) => c.id === l.id)!.props.name = name));
                }}
                title={readOnly ? String(l.props.name ?? 'Layer') : 'Double-click to rename'}
              >
                {String(l.props.name || 'Layer')}
              </button>
            ))}
            {!readOnly && (
              <button className="w-6 h-full grid place-items-center text-t2 hover:text-t0 hover:bg-bg3" onClick={addLayer} title="Add layer">
                <Plus size={12} />
              </button>
            )}
            {layers.length > 1 && layer && !readOnly && (
              <button
                className="w-6 h-full grid place-items-center text-t2 hover:text-danger hover:bg-bg3"
                title="Delete layer"
                onClick={() => {
                  editSM(ab.id, sm.id, (m) => void (m.children = m.children!.filter((c) => c.id !== layer.id)));
                  s.set('layerId', null);
                }}
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
          {!readOnly && (
            <div className="relative">
              <button
                className="btn h-6 px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setAddMenu(addMenu === 'state' ? null : 'state');
                }}
                title="Add a state"
              >
                <Plus size={12} /> State
              </button>
              {addMenu === 'state' && (
                <div className="menu absolute right-0 top-7 max-h-64 overflow-auto">
                  {ab.animations.map((a) => (
                    <button key={a.id} className="menu-item" onClick={() => addState(a.id)}>
                      {String(a.props.name ?? 'Timeline')}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => addState(null)}>
                    Empty state
                  </button>
                  <button className="menu-item" onClick={addBlendState} disabled={!ab.animations.length}>
                    1D blend state
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          ref={graphRef}
          className="flex-1 relative overflow-hidden"
          style={{
            backgroundColor: '#181818',
            backgroundImage: 'radial-gradient(#262626 1px, transparent 1px)',
            backgroundSize: `${16 * zoom}px ${16 * zoom}px`,
            backgroundPosition: `${pan.x * zoom}px ${pan.y * zoom}px`,
          }}
          onPointerDown={panGraph}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
          }}
          onDragOver={(e) => e.preventDefault()}
          onContextMenu={(e) => {
            if ((e.target as Element).closest('[data-state-node]')) return;
            const at = graphPoint(e);
            openContextMenu(e, [
              {
                label: 'Add state',
                disabled: readOnly,
                submenu: [
                  ...ab.animations.map((a): MenuItem => ({ label: String(a.props.name ?? 'Timeline'), run: () => addState(a.id, { x: at.x - 60, y: at.y - NODE_H / 2 }) })),
                  sep,
                  { label: 'Empty state', run: () => addState(null, { x: at.x - 60, y: at.y - NODE_H / 2 }) },
                ],
              },
              { label: 'Add layer', disabled: readOnly, run: addLayer },
              sep,
              { label: previewing ? 'Stop preview' : 'Preview', run: togglePreview },
              { label: 'Reset view', run: () => (setPan({ x: 0, y: 0 }), setZoom(1)) },
            ]);
          }}
        >
          <svg data-bg className="absolute inset-0 w-full h-full" onPointerDown={panGraph}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill="#7d7d7d" />
              </marker>
              <marker id="arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill="#57a5e0" />
              </marker>
            </defs>
            <g transform={`translate(${pan.x * zoom} ${pan.y * zoom}) scale(${zoom})`}>
              {edges.map(({ tr, from, to, fi, ti }) => {
                const a = center(from, fi);
                const b = center(to, ti);
                const sizeA = nodeSize(from, ab);
                const sel = smSelection?.kind === 'transition' && smSelection.id === tr.id;
                if (Math.hypot(b.x - a.x, b.y - a.y) < 1) {
                  // self transition: Rive draws a small hook off the node's bottom-right
                  const top = a.y - sizeA.cy;
                  return (
                    <path
                      key={tr.id}
                      d={`M${a.x - 10} ${top} C${a.x - 22} ${top - 26} ${a.x + 22} ${top - 26} ${a.x + 10} ${top}`}
                      fill="none"
                      stroke={sel ? '#57a5e0' : '#7d7d7d'}
                      strokeWidth={sel ? 1.75 : 1.25}
                      markerEnd={`url(#${sel ? 'arrow-sel' : 'arrow'})`}
                      style={{ cursor: 'pointer' }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        s.set('smSelection', { kind: 'transition', id: tr.id });
                      }}
                    />
                  );
                }
                const twoWay = edges.some((e) => e.from.id === to.id && e.to.id === from.id);
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len;
                const ny = dx / len;
                const off = twoWay ? 5 : 0;
                const sizeB = nodeSize(to, ab);
                // clip the line at the node rectangles
                const clip = (p: { x: number; y: number }, cx: number, cy: number, dir: number) => {
                  const tx = Math.abs(dx) > 1e-6 ? cx / Math.abs(dx) : Infinity;
                  const ty = Math.abs(dy) > 1e-6 ? cy / Math.abs(dy) : Infinity;
                  const t = Math.min(tx, ty);
                  return { x: p.x + dx * t * dir, y: p.y + dy * t * dir };
                };
                const p1 = clip(a, sizeA.cx, sizeA.cy, 1);
                const p2 = clip(b, sizeB.cx, sizeB.cy, -1);
                const hasConditions = (tr.children ?? []).length > 0;
                return (
                  <g
                    key={tr.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      s.set('smSelection', { kind: 'transition', id: tr.id });
                    }}
                    onContextMenu={(e) => {
                      s.set('smSelection', { kind: 'transition', id: tr.id });
                      const disabled = (prop(tr, 'flags') & 1) === 1;
                      openContextMenu(e, [
                        {
                          label: disabled ? 'Enable transition' : 'Disable transition',
                          disabled: readOnly,
                          run: () =>
                            editSM(ab.id, sm.id, (m) => {
                              const walk = (o: CoreObj) => {
                                if (o.id === tr.id) o.props.flags = prop(o, 'flags') ^ 1;
                                o.children?.forEach(walk);
                              };
                              walk(m);
                            }),
                        },
                        sep,
                        { label: 'Delete transition', danger: true, disabled: readOnly, run: () => deleteSmSelection() },
                      ]);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <line x1={p1.x + nx * off} y1={p1.y + ny * off} x2={p2.x + nx * off} y2={p2.y + ny * off} stroke="transparent" strokeWidth={9} />
                    <line
                      x1={p1.x + nx * off}
                      y1={p1.y + ny * off}
                      x2={p2.x + nx * off}
                      y2={p2.y + ny * off}
                      stroke={sel ? '#57a5e0' : '#7d7d7d'}
                      strokeWidth={sel ? 1.75 : 1.25}
                      strokeDasharray={prop(tr, 'flags') & 1 ? '4 3' : undefined}
                      markerEnd={`url(#${sel ? 'arrow-sel' : 'arrow'})`}
                    />
                    {/* Rive's "this transition has conditions/actions" badge */}
                    {hasConditions && (
                      <rect
                        x={(p1.x + p2.x) / 2 + nx * off - 5}
                        y={(p1.y + p2.y) / 2 + ny * off - 4}
                        width={10}
                        height={8}
                        rx={2}
                        fill="#141414"
                        stroke={sel ? '#57a5e0' : '#8a8a8a'}
                        strokeWidth={1}
                      />
                    )}
                  </g>
                );
              })}
              {linking &&
                (() => {
                  const fi = states.findIndex((t) => t.id === linking.from);
                  const a = center(states[fi], fi);
                  return <line x1={a.x} y1={a.y} x2={linking.x} y2={linking.y} stroke="#57a5e0" strokeWidth={1.25} markerEnd="url(#arrow-sel)" />;
                })()}
            </g>
          </svg>

          <div
            className="absolute inset-0"
            style={{ transform: `translate(${pan.x * zoom}px, ${pan.y * zoom}px) scale(${zoom})`, transformOrigin: '0 0' }}
          >
            {states.map((st, i) => {
              const p = posOf(st, i);
              const size = nodeSize(st, ab);
              const sel = smSelection?.kind === 'state' && smSelection.id === st.id;
              const kind = stateKind(st);
              const label = stateLabel(ab, st);
              return (
                <div
                  key={st.id}
                  data-state-node
                  className="absolute group flex items-center select-none"
                  style={{
                    left: p.x,
                    top: p.y,
                    width: size.width,
                    height: NODE_H,
                    paddingLeft: NODE_PAD,
                    paddingRight: NODE_PAD,
                    gap: NODE_GAP,
                    borderRadius: 8,
                    background: STATE_TINTS[kind],
                    border: `1px solid ${sel ? '#57a5e0' : kind === 'animation' || kind === 'blend' ? '#3b3b3b' : 'transparent'}`,
                    boxShadow: sel ? '0 0 0 1px #57a5e0' : undefined,
                    cursor: 'grab',
                  }}
                  onPointerDown={(e) => e.button === 0 && dragNode(e, st, i)}
                  onContextMenu={(e) => {
                    s.set('smSelection', { kind: 'state', id: st.id });
                    const special = ['EntryState', 'AnyState', 'ExitState'].includes(st.type);
                    openContextMenu(e, [
                      ...(st.type === 'AnimationState'
                        ? [
                            {
                              label: 'Timeline',
                              submenu: ab.animations.map(
                                (a): MenuItem => ({
                                  label: String(a.props.name ?? 'Timeline'),
                                  checked: st.props.animationId === a.id,
                                  disabled: readOnly,
                                  run: () =>
                                    editSM(ab.id, sm.id, (m) => {
                                      const walk = (o: CoreObj) => {
                                        if (o.id === st.id) o.props.animationId = a.id;
                                        o.children?.forEach(walk);
                                      };
                                      walk(m);
                                    }),
                                }),
                              ),
                            } as MenuItem,
                            sep,
                          ]
                        : []),
                      { label: 'Delete state', danger: true, disabled: readOnly || special, run: () => deleteSmSelection() },
                    ]);
                  }}
                >
                  <span className="shrink-0 grid place-items-center" style={{ width: NODE_ICON, color: '#c9c9c9' }}>
                    {kind === 'any' ? (
                      <Asterisk size={12} strokeWidth={2.2} />
                    ) : kind === 'blend' ? (
                      <Layers size={11} strokeWidth={2} />
                    ) : (
                      <ArrowRight size={11} strokeWidth={2} />
                    )}
                  </span>
                  <span
                    className="truncate"
                    style={{
                      fontSize: 11,
                      lineHeight: '13px',
                      letterSpacing: 0.1,
                      color: '#e6e6e6',
                    }}
                  >
                    {label}
                  </span>
                  {sel && <span className="ml-0.5 shrink-0 text-[9px] text-[#7fb2e0]">✓</span>}
                  {!readOnly && st.type !== 'ExitState' && (
                    <div
                      className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-editor-accent border border-[#141414] opacity-0 group-hover:opacity-100 cursor-crosshair"
                      title="Drag to another state to add a transition"
                      onPointerDown={(e) => startLink(e, st)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {!states.length && <EmptyHint />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector for the selected state machine element

const OPS = [
  { value: 0, label: '==' },
  { value: 1, label: '!=' },
  { value: 2, label: '<=' },
  { value: 3, label: '>=' },
  { value: 4, label: '<' },
  { value: 5, label: '>' },
];

const LISTENER_TYPES = [
  { value: 2, label: 'Pointer Down' },
  { value: 3, label: 'Pointer Up' },
  { value: 6, label: 'Click' },
  { value: 0, label: 'Pointer Enter' },
  { value: 1, label: 'Pointer Exit' },
  { value: 4, label: 'Pointer Move' },
  { value: 5, label: 'Rive Event' },
];

export function StateMachineInspector() {
  const { ab, sm, layer } = useSM();
  const smSelection = useEditor((s) => s.smSelection);
  const readOnly = useEditor((s) => s.readOnly);
  if (!ab || !sm || !smSelection) return null;
  const s = useEditor.getState();
  const inputs = (sm.children ?? []).filter((c) => isA(c.type, 'StateMachineInput'));
  const events = ab.objects.filter((o) => o.type === 'Event');
  const dataProps = s.doc ? dataProperties(s.doc, ab) : [];

  // locate selected object anywhere in the SM tree
  let target: CoreObj | undefined;
  let parent: CoreObj | undefined;
  const walk = (o: CoreObj, p?: CoreObj) => {
    if (o.id === smSelection.id) {
      target = o;
      parent = p;
    }
    o.children?.forEach((c) => walk(c, o));
  };
  walk(sm);
  if (!target) return <div className="section text-t2">Nothing selected</div>;
  const t = target;
  const set = (values: Record<string, unknown>, transient = false) =>
    s.commit((d) => {
      const a = findArtboard(d, ab.id)!;
      const m = a.stateMachines.find((x) => x.id === sm.id)!;
      const w = (o: CoreObj) => {
        if (o.id === t.id) Object.assign(o.props, values);
        o.children?.forEach(w);
      };
      w(m);
    }, transient);
  const convertStateType = (kind: string) => mutate((state) => void retypeState(state, kind, ab));
  const mutate = (fn: (o: CoreObj) => void) =>
    s.commit((d) => {
      const a = findArtboard(d, ab.id)!;
      const m = a.stateMachines.find((x) => x.id === sm.id)!;
      const w = (o: CoreObj) => {
        if (o.id === t.id) fn(o);
        o.children?.forEach(w);
      };
      w(m);
    });
  const removeSelf = () => deleteSmSelection();
  const canDelete = !readOnly && !['EntryState', 'AnyState', 'ExitState'].includes(t.type);
  const header = (title: string) => (
    <div className="flex items-center mb-2">
      <span className="panel-title flex-1">{title}</span>
      {canDelete && (
        <button className="icon-btn" onClick={removeSelf} title="Delete">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );

  if (isA(t.type, 'StateMachineInput')) {
    return (
      <div className="section flex flex-col gap-2">
        {header(t.type === 'StateMachineNumber' ? 'Number input' : t.type === 'StateMachineBool' ? 'Boolean input' : 'Trigger input')}
        <Row label="Name">
          <TextField value={String(t.props.name ?? '')} onChange={(v) => set({ name: v })} />
        </Row>
        {t.type === 'StateMachineNumber' && (
          <Row label="Default">
            <NumberField value={prop(t, 'value')} onChange={(v, tr) => set({ value: v }, tr)} disabled={readOnly} />
          </Row>
        )}
        {t.type === 'StateMachineBool' && (
          <Row label="Default">
            <input type="checkbox" checked={prop<boolean>(t, 'value')} disabled={readOnly} onChange={(e) => set({ value: e.target.checked })} />
          </Row>
        )}
      </div>
    );
  }

  if (isA(t.type, 'LayerState')) {
    const transitions = (t.children ?? []).filter((c) => isA(c.type, 'StateTransition'));
    return (
      <div className="section flex flex-col gap-2">
        {header(stateLabel(ab, t))}
        {/* Rive's Type switch: a state can be re-typed in the Inspector, keeping its transitions */}
        {!(t.type === 'EntryState' || t.type === 'AnyState' || t.type === 'ExitState') && (
          <Row label="Type">
            <Select
              value={t.type === 'AnimationState' ? 'single' : t.type === 'BlendState1DInput' ? 'blend1d' : 'blendDirect'}
              options={[
                { value: 'single', label: 'Single' },
                { value: 'blend1d', label: '1D blend' },
                { value: 'blendDirect', label: 'Additive blend' },
              ]}
              disabled={readOnly}
              onChange={(kind) => convertStateType(kind)}
            />
          </Row>
        )}
        {t.type === 'AnimationState' && (
          <>
            <Row label="Timeline">
              <Select
                value={String(t.props.animationId ?? '')}
                options={[{ value: '', label: 'None' }, ...ab.animations.map((a) => ({ value: a.id, label: String(a.props.name ?? 'Timeline') }))]}
                onChange={(v) => set({ animationId: v })}
              />
            </Row>
            <Row label="Speed">
              <NumberField value={prop(t, 'speed')} step={0.05} onChange={(v, tr) => set({ speed: v }, tr)} disabled={readOnly} />
            </Row>
          </>
        )}
        {t.type === 'BlendState1DInput' && (
          <>
            <Row label="Parameter">
              <Select
                value={String(t.props.inputId ?? '')}
                options={inputs.filter((input) => input.type === 'StateMachineNumber').map((input) => ({ value: input.id, label: String(input.props.name ?? 'Number') }))}
                disabled={readOnly || !inputs.some((input) => input.type === 'StateMachineNumber')}
                onChange={(inputId) => set({ inputId })}
              />
            </Row>
            <div className="label mt-2">Timelines by parameter value</div>
            {(t.children ?? []).filter((child) => child.type === 'BlendAnimation1D').map((blend) => (
              <div key={blend.id} className="flex items-center gap-1.5 rounded bg-bg2 p-1.5">
                <Select
                  className="min-w-0 flex-1"
                  value={String(blend.props.animationId ?? '')}
                  options={ab.animations.map((animation) => ({ value: animation.id, label: String(animation.props.name ?? 'Timeline') }))}
                  disabled={readOnly}
                  onChange={(animationId) => mutate((state) => {
                    const item = state.children?.find((child) => child.id === blend.id);
                    if (item) item.props.animationId = animationId;
                  })}
                />
                <div className="w-16 shrink-0">
                  <NumberField value={Number(blend.props.value ?? 0)} disabled={readOnly} onChange={(value) => mutate((state) => {
                    const item = state.children?.find((child) => child.id === blend.id);
                    if (item) item.props.value = value;
                  })} />
                </div>
                {!readOnly && <button className="icon-btn w-5 h-5" title="Remove timeline" onClick={() => mutate((state) => { state.children = state.children?.filter((child) => child.id !== blend.id); })}><Trash2 size={11} /></button>}
              </div>
            ))}
            {!readOnly && ab.animations.some((animation) => !(t.children ?? []).some((blend) => blend.props.animationId === animation.id)) && (
              <Select
                value=""
                options={[{ value: '', label: '+ Add timeline…' }, ...ab.animations.filter((animation) => !(t.children ?? []).some((blend) => blend.props.animationId === animation.id)).map((animation) => ({ value: animation.id, label: String(animation.props.name ?? 'Timeline') }))]}
                onChange={(animationId) => animationId && mutate((state) => {
                  const blend = obj('BlendAnimation1D', { animationId, value: (state.children ?? []).length });
                  (state.children ??= []).push(blend);
                })}
              />
            )}
          </>
        )}
        <div className="label mt-1">Transitions out</div>
        {transitions.length === 0 && <div className="text-t3">None. Drag from the blue dot on the state.</div>}
        {transitions.map((tr) => {
          const to = layer?.children?.find((c) => c.id === tr.props.stateToId);
          const weight = prop(tr, 'randomWeight') || 1;
          return (
            <div key={tr.id} className="flex items-center gap-1">
              <button className="text-left flex-1 min-w-0 px-2 py-1 rounded bg-bg2 hover:bg-bg3 truncate" onClick={() => s.set('smSelection', { kind: 'transition', id: tr.id })}>
                → {to ? stateLabel(ab, to) : '?'} {(tr.children ?? []).length ? `(${tr.children!.length} conditions)` : ''}
              </button>
              {/* Rive's Randomize Exit weights: a path with weight 3 is three times as likely to be taken */}
              <div className="w-12 shrink-0" title="Randomize-exit weight (relative chance this path is chosen)">
                <NumberField
                  value={weight}
                  precision={0}
                  min={1}
                  disabled={readOnly}
                  onChange={(v, tr2) => {
                    const next = Math.max(1, Math.round(v));
                    mutate((state) => {
                      const item = state.children?.find((child) => child.id === tr.id);
                      if (item) item.props.randomWeight = next;
                    });
                    void tr2;
                  }}
                />
              </div>
            </div>
          );
        })}
        <p className="text-t3 text-[10px] leading-relaxed mt-1">
          Weights only apply when the layer randomizes its exit; higher numbers make a path more likely.
        </p>
      </div>
    );
  }

  if (isA(t.type, 'StateTransition')) {
    const flags = prop(t, 'flags');
    const setFlag = (bit: number, on: boolean) => set({ flags: on ? flags | bit : flags & ~bit });
    const to = layer?.children?.find((c) => c.id === t.props.stateToId);
    const conditions = (t.children ?? []).filter((c) => isA(c.type, 'TransitionCondition'));
    const addCondition = (inputId: string) => {
      const input = inputs.find((i) => i.id === inputId);
      if (!input) return;
      const type =
        input.type === 'StateMachineNumber'
          ? 'TransitionNumberCondition'
          : input.type === 'StateMachineBool'
            ? 'TransitionBoolCondition'
            : 'TransitionTriggerCondition';
      mutate((o) => (o.children ??= []).push(obj(type, { inputId, ...(type === 'TransitionNumberCondition' ? { opValue: 0, value: 0 } : {}) })));
    };
    const addPropertyCondition = (propertyId: string) => {
      const property = dataProps.find((item) => item.obj.id === propertyId);
      if (property) mutate((o) => (o.children ??= []).push(propertyCondition(property)));
    };
    const setCond = (id: string, values: Record<string, unknown>) =>
      mutate((o) => {
        const c = o.children?.find((x) => x.id === id);
        if (c) Object.assign(c.props, values);
      });
    const removeCond = (id: string) => mutate((o) => (o.children = o.children?.filter((x) => x.id !== id)));
    return (
      <div className="section flex flex-col gap-2">
        {header(`${parent ? stateLabel(ab, parent) : '?'} → ${to ? stateLabel(ab, to) : '?'}`)}
        <Row label="Duration">
          <NumberField value={prop(t, 'duration')} precision={0} min={0} disabled={readOnly} onChange={(v, tr) => set({ duration: Math.round(v) }, tr)} />
          <Select
            className="w-[70px] shrink-0"
            value={flags & 2 ? 'pct' : 'ms'}
            options={[
              { value: 'ms', label: 'ms' },
              { value: 'pct', label: '%' },
            ]}
            onChange={(v) => setFlag(2, v === 'pct')}
          />
        </Row>
        <Row label="Exit time">
          <input type="checkbox" checked={!!(flags & 4)} disabled={readOnly} onChange={(e) => setFlag(4, e.target.checked)} />
          <NumberField value={prop(t, 'exitTime')} precision={0} min={0} disabled={readOnly || !(flags & 4)} onChange={(v, tr) => set({ exitTime: Math.round(v) }, tr)} />
          <Select
            className="w-[70px] shrink-0"
            value={flags & 8 ? 'pct' : 'ms'}
            options={[
              { value: 'ms', label: 'ms' },
              { value: 'pct', label: '%' },
            ]}
            onChange={(v) => setFlag(8, v === 'pct')}
          />
        </Row>
        <label className="flex items-center gap-2 text-t1">
          <input type="checkbox" checked={!!(flags & 16)} disabled={readOnly} onChange={(e) => setFlag(16, e.target.checked)} /> Pause source when exiting
        </label>
        <label className="flex items-center gap-2 text-t1">
          <input type="checkbox" checked={!!(flags & 32)} disabled={readOnly} onChange={(e) => setFlag(32, e.target.checked)} /> Allow exit during transition
        </label>
        <label className="flex items-center gap-2 text-t1">
          <input type="checkbox" checked={!!(flags & 1)} disabled={readOnly} onChange={(e) => setFlag(1, e.target.checked)} /> Disabled
        </label>
        <div className="label mt-2">Conditions (all must be true)</div>
        {conditions.map((c) => {
          const input = inputs.find((i) => i.id === c.props.inputId);
          const bind = (c.children ?? []).find((child) => child.type === 'DataBindContext');
          const path = bind ? decodePath(bind.props.sourcePathIds) : [];
          const property = c.type === 'TransitionViewModelCondition'
            ? dataProps.find((p) => p.viewModelIndex === path[0] && p.index === path[1])
            : undefined;
          const comparator = (c.children ?? []).find((child) => isA(child.type, 'TransitionValueComparator'));
          const updateComparator = (values: Record<string, unknown>) => mutate((transition) => {
            const condition = transition.children?.find((child) => child.id === c.id);
            const value = condition?.children?.find((child) => isA(child.type, 'TransitionValueComparator'));
            if (value) Object.assign(value.props, values);
          });
          return (
            <div key={c.id} className="flex items-center gap-1.5 bg-bg2 rounded p-1.5">
              <span className="truncate flex-1">{property?.name ?? (input ? String(input.props.name) : c.type === 'TransitionViewModelCondition' ? 'missing property' : 'missing input')}</span>
              {c.type === 'TransitionNumberCondition' && (
                <>
                  <Select className="w-14 shrink-0" value={prop(c, 'opValue')} options={OPS} onChange={(v) => setCond(c.id, { opValue: v })} />
                  <div className="w-16 shrink-0">
                    <NumberField value={prop(c, 'value')} onChange={(v) => setCond(c.id, { value: v })} disabled={readOnly} />
                  </div>
                </>
              )}
              {c.type === 'TransitionBoolCondition' && (
                <Select
                  className="w-20 shrink-0"
                  value={prop(c, 'opValue')}
                  options={[
                    { value: 0, label: 'is true' },
                    { value: 1, label: 'is false' },
                  ]}
                  onChange={(v) => setCond(c.id, { opValue: v })}
                />
              )}
              {c.type === 'TransitionTriggerCondition' && <span className="text-t2">fired</span>}
              {c.type === 'TransitionViewModelCondition' && property?.type === 'number' && comparator && (
                <>
                  <Select className="w-14 shrink-0" value={prop(c, 'opValue')} options={OPS} onChange={(opValue) => setCond(c.id, { opValue })} />
                  <div className="w-16 shrink-0"><NumberField value={Number(comparator.props.value ?? 0)} disabled={readOnly} onChange={(value) => updateComparator({ value })} /></div>
                </>
              )}
              {c.type === 'TransitionViewModelCondition' && property?.type === 'boolean' && (
                <Select className="w-20 shrink-0" value={prop(c, 'opValue')} options={[{ value: 0, label: 'is true' }, { value: 1, label: 'is false' }]} onChange={(opValue) => setCond(c.id, { opValue })} />
              )}
              {c.type === 'TransitionViewModelCondition' && property?.type === 'string' && comparator && (
                <div className="w-20 shrink-0"><TextField value={String(comparator.props.value ?? '')} disabled={readOnly} onChange={(value) => updateComparator({ value })} /></div>
              )}
              {c.type === 'TransitionViewModelCondition' && property?.type === 'trigger' && <span className="text-t2">fired</span>}
              {!readOnly && (
                <button className="icon-btn w-5 h-5" onClick={() => removeCond(c.id)}>
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          );
        })}
        {!readOnly && (
          <Select
            value=""
            options={[{ value: '', label: '+ Add condition…' }, ...dataProps.map((p) => ({ value: `property:${p.obj.id}`, label: p.name })), ...inputs.map((i) => ({ value: `input:${i.id}`, label: String(i.props.name) }))]}
            onChange={(v) => {
              const [kind, id] = v.split(':', 2);
              if (kind === 'property') addPropertyCondition(id!);
              if (kind === 'input') addCondition(id!);
            }}
          />
        )}
      </div>
    );
  }

  if (isA(t.type, 'StateMachineListener')) {
    const actions = (t.children ?? []).filter((c) => isA(c.type, 'ListenerAction'));
    const shapes = ab.objects.filter((o) => isA(o.type, 'TransformComponent') && o.type !== 'Artboard');
    const addAction = (inputId: string) => {
      const input = inputs.find((i) => i.id === inputId);
      if (!input) return;
      const type =
        input.type === 'StateMachineNumber' ? 'ListenerNumberChange' : input.type === 'StateMachineBool' ? 'ListenerBoolChange' : 'ListenerTriggerChange';
      mutate((o) => (o.children ??= []).push(obj(type, { inputId, ...(type === 'ListenerBoolChange' ? { value: 1 } : {}) })));
    };
    const addDataAction = (propertyId: string) => {
      const property = dataProps.find((item) => item.obj.id === propertyId);
      if (property) mutate((o) => (o.children ??= []).push(...propertyListenerAction(property)));
    };
    const addAlignAction = (targetId: string) => mutate((o) => (o.children ??= []).push(obj('ListenerAlignTarget', { targetId, preserveOffset: true })));
    const addEventAction = (eventId: string) => mutate((o) => (o.children ??= []).push(obj('ListenerFireEvent', { eventId })));
    const setAction = (id: string, values: Record<string, unknown>) =>
      mutate((o) => {
        const c = o.children?.find((x) => x.id === id);
        if (c) Object.assign(c.props, values);
      });
    return (
      <div className="section flex flex-col gap-2">
        {header('Listener')}
        <Row label="Name">
          <TextField value={String(t.props.name ?? '')} onChange={(v) => set({ name: v })} />
        </Row>
        <Row label="Target">
          <Select
            value={String(t.props.targetId ?? '')}
            options={[{ value: '', label: 'Artboard' }, ...shapes.map((o) => ({ value: o.id, label: displayName(o) }))]}
            onChange={(v) => set({ targetId: v || undefined })}
          />
        </Row>
        <Row label="Event">
          <Select value={prop(t, 'listenerTypeValue')} options={LISTENER_TYPES} onChange={(v) => set({ listenerTypeValue: v, ...(v === 5 && events[0] ? { eventId: events[0].id } : v !== 5 ? { eventId: undefined } : {}) })} />
        </Row>
        {prop(t, 'listenerTypeValue') === 5 && (
          <Row label="Rive event">
            <Select value={String(t.props.eventId ?? '')} options={events.map((event) => ({ value: event.id, label: String(event.props.name ?? 'Event') }))} disabled={readOnly || !events.length} onChange={(eventId) => set({ eventId })} />
          </Row>
        )}
        <div className="label mt-2">Actions</div>
        {actions.map((a) => {
          const input = inputs.find((i) => i.id === a.props.inputId);
          return (
            <div key={a.id} className="flex items-center gap-1.5 bg-bg2 rounded p-1.5">
              {a.type === 'ListenerAlignTarget' ? (
                <>
                  <Select className="min-w-0 flex-1" value={String(a.props.targetId ?? '')} options={shapes.map((shape) => ({ value: shape.id, label: displayName(shape) }))} disabled={readOnly} onChange={(targetId) => setAction(a.id, { targetId })} />
                  <label className="flex items-center gap-1 text-[10px] text-t2 shrink-0" title="Keep the target's offset from the pointer">
                    <input type="checkbox" checked={!!a.props.preserveOffset} disabled={readOnly} onChange={(e) => setAction(a.id, { preserveOffset: e.target.checked })} /> Offset
                  </label>
                </>
              ) : a.type === 'ListenerFireEvent' ? (
                <span className="truncate flex-1">{String(events.find((event) => event.id === a.props.eventId)?.props.name ?? 'missing event')}</span>
              ) : a.type === 'ListenerViewModelChange' ? (
                <span className="truncate flex-1">{dataProps.find((p) => {
                  const at = (t.children ?? []).indexOf(a);
                  const bind = (t.children ?? []).slice(0, at).reverse().find((child) => child.type === 'DataBindContext');
                  const path = bind ? decodePath(bind.props.sourcePathIds) : [];
                  return p.viewModelIndex === path[0] && p.index === path[1];
                })?.name ?? 'missing property'}</span>
              ) : (
                <span className="truncate flex-1">{input ? String(input.props.name) : 'missing input'}</span>
              )}
              {a.type === 'ListenerBoolChange' && (
                <Select
                  className="w-20 shrink-0"
                  value={prop(a, 'value')}
                  options={[
                    { value: 1, label: 'true' },
                    { value: 0, label: 'false' },
                    { value: 2, label: 'toggle' },
                  ]}
                  onChange={(v) => setAction(a.id, { value: v })}
                />
              )}
              {a.type === 'ListenerNumberChange' && (
                <div className="w-16 shrink-0">
                  <NumberField value={prop(a, 'value')} onChange={(v) => setAction(a.id, { value: v })} disabled={readOnly} />
                </div>
              )}
              {a.type === 'ListenerTriggerChange' && <span className="text-t2">fire</span>}
              {!readOnly && (
                <button className="icon-btn w-5 h-5" onClick={() => mutate((o) => {
                  const kids = o.children ?? [];
                  const index = kids.findIndex((x) => x.id === a.id);
                  if (a.type === 'ListenerViewModelChange') {
                    let from = index - 1;
                    while (from > 0 && !isA(kids[from - 1]!.type, 'BindableProperty')) from--;
                    from = Math.max(0, from - 1);
                    o.children = kids.filter((_, i) => i < from || i > index);
                  } else o.children = kids.filter((x) => x.id !== a.id);
                })}>
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          );
        })}
        {!readOnly && (
          <Select value="" options={[
            { value: '', label: '+ Add listener action…' },
            ...dataProps.map((p) => ({ value: `property:${p.obj.id}`, label: `Set ${p.name}` })),
            ...inputs.map((i) => ({ value: `input:${i.id}`, label: String(i.props.name) })),
            ...events.map((event) => ({ value: `event:${event.id}`, label: `Fire ${String(event.props.name ?? 'Event')}` })),
            ...shapes.map((shape) => ({ value: `align:${shape.id}`, label: `Align ${displayName(shape)} to pointer` })),
          ]} onChange={(value) => {
            const [kind, id] = value.split(':', 2);
            if (kind === 'property') addDataAction(id!);
            if (kind === 'input') addAction(id!);
            if (kind === 'event') addEventAction(id!);
            if (kind === 'align') addAlignAction(id!);
          }} />
        )}
      </div>
    );
  }
  return <div className="section text-t2">{t.type}</div>;
}

/** Deletes the selected state / transition / input / listener of the active state machine. */
export function deleteSmSelection() {
  const s = useEditor.getState();
  const sel = s.smSelection;
  if (!sel || !s.doc || s.readOnly) return;
  const ab = findArtboard(s.doc, s.activeArtboardId);
  const sm = ab?.stateMachines.find((m) => m.id === s.stateMachineId);
  if (!ab || !sm) return;
  let target: CoreObj | undefined;
  const find = (o: CoreObj) => {
    if (o.id === sel.id) target = o;
    o.children?.forEach(find);
  };
  find(sm);
  if (!target || ['EntryState', 'AnyState', 'ExitState'].includes(target.type)) return;
  const id = target.id;
  s.commit((d) => {
    const m = findArtboard(d, ab.id)!.stateMachines.find((x) => x.id === sm.id)!;
    const w = (o: CoreObj) => {
      if (!o.children) return;
      o.children = o.children.filter(
        (c) =>
          c.id !== id &&
          // transitions into a deleted state, and conditions / actions on a deleted input
          !(isA(c.type, 'StateTransition') && c.props.stateToId === id) &&
          !(isA(c.type, 'TransitionInputCondition') && c.props.inputId === id) &&
          !(isA(c.type, 'ListenerInputChange') && c.props.inputId === id),
      );
      o.children.forEach(w);
    };
    w(m);
  });
  s.set('smSelection', null);
}

/** One data binding property: rename it, set the value it starts with, remove it. */
function PropertyRow({
  property,
  readOnly,
  onEdit,
}: {
  property: PropertyDoc;
  readOnly: boolean;
  onEdit: (fn: (d: RiveDoc, ab: ArtboardDoc) => void) => void;
}) {
  const value = propertyValue(property);
  const set = (v: number | boolean | string) => onEdit((d, ab) => setPropertyValue(d, ab, property.obj.id, v));
  return (
    <div
      className="flex items-center gap-2 h-8 px-2 rounded hover:bg-bg2 group"
      onContextMenu={(e) =>
        openContextMenu(e, [
          {
            label: 'Rename…',
            disabled: readOnly,
            run: async () => {
              const name = await promptDialog({ title: 'Rename property', label: 'Property name', defaultValue: property.name, confirmLabel: 'Rename' });
              if (name) onEdit((d, ab) => void renameProperty(d, ab, property.obj.id, name));
            },
          },
          sep,
          {
            label: 'Delete property',
            danger: true,
            disabled: readOnly,
            run: () => onEdit((d, ab) => void removeProperty(d, ab, property.obj.id)),
          },
        ])
      }
    >
      <span className="text-t2" title={property.type}>
        {PROPERTY_ICONS[property.type]}
      </span>
      <span className="flex-1 truncate" title={`${property.name} (${property.type})`}>
        {property.name}
      </span>
      {property.type === 'number' && (
        <div className="w-16">
          <NumberField value={Number(value ?? 0)} onChange={set} disabled={readOnly} />
        </div>
      )}
      {property.type === 'boolean' && <input type="checkbox" checked={!!value} disabled={readOnly} onChange={(e) => set(e.target.checked)} />}
      {property.type === 'string' && (
        <input className="field h-6 w-20" value={String(value ?? '')} disabled={readOnly} onChange={(e) => set(e.target.value)} />
      )}
      {property.type === 'color' && (
        <input
          type="color"
          className="w-8 h-6"
          value={`#${((Number(value ?? 0) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`}
          disabled={readOnly}
          onChange={(e) => set((0xff000000 | parseInt(e.target.value.slice(1), 16)) >>> 0)}
        />
      )}
      {property.type === 'trigger' && <span className="text-t3 text-[11px]">fire in Preview</span>}
    </div>
  );
}
