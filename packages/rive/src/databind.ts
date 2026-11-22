// Data binding: view model properties, and the objects that read and write them.
//
// Rive deprecated state machine inputs in favour of view model properties
// (https://rive.app/docs/editor/data-binding/migration-guide). A property can do
// everything an input can — drive transitions, be set by a pointer listener —
// plus types inputs never had, and runtimes read and write it without the
// deprecated inputs API.
//
// Layout written into the file (file level objects, in this order per model):
//
//   ViewModel { name }
//   ViewModelProperty<T> { name }          ← one per property, in index order
//   ViewModelInstance { viewModelId, name }
//   ViewModelInstance<T> { viewModelPropertyId, propertyValue }
//
// and the artboard points at the model with `viewModelId`. References are
// indices: `viewModelId` counts ViewModel objects in the file, and
// `viewModelPropertyId` counts properties inside their own model. A data bind
// reaches a property through `sourcePathIds`, a varuint path of
// [viewModelIndex, …nested properties…, propertyIndex].
import { ArtboardDoc, CoreObj, RiveDoc } from './document';
import { obj } from './factory';
import { isA } from './schema';

export type PropertyType = 'number' | 'boolean' | 'trigger' | 'string' | 'color' | 'enum';

export type PropertyValue = number | boolean | string;

interface TypeInfo {
  /** file level property declaration */
  property: string;
  /** the value it holds on an instance */
  instance: string;
  /** what a condition or listener binds to */
  bindable: string;
  /** property key of the bindable's value, named by the data bind */
  propertyKey: number;
  /** literal to compare a property against in a transition */
  comparator: string;
}

const TYPES: Record<PropertyType, TypeInfo> = {
  number: {
    property: 'ViewModelPropertyNumber',
    instance: 'ViewModelInstanceNumber',
    bindable: 'BindablePropertyNumber',
    propertyKey: 636,
    comparator: 'TransitionValueNumberComparator',
  },
  boolean: {
    property: 'ViewModelPropertyBoolean',
    instance: 'ViewModelInstanceBoolean',
    bindable: 'BindablePropertyBoolean',
    propertyKey: 634,
    comparator: 'TransitionValueBooleanComparator',
  },
  trigger: {
    property: 'ViewModelPropertyTrigger',
    instance: 'ViewModelInstanceTrigger',
    bindable: 'BindablePropertyTrigger',
    propertyKey: 686,
    comparator: 'TransitionValueTriggerComparator',
  },
  string: {
    property: 'ViewModelPropertyString',
    instance: 'ViewModelInstanceString',
    bindable: 'BindablePropertyString',
    propertyKey: 635,
    comparator: 'TransitionValueStringComparator',
  },
  color: {
    property: 'ViewModelPropertyColor',
    instance: 'ViewModelInstanceColor',
    bindable: 'BindablePropertyColor',
    propertyKey: 638,
    comparator: 'TransitionValueColorComparator',
  },
  // An enum property points at a DataEnumCustom by id; each instance value holds
  // the key of the chosen DataEnumValue. Type keys come from rive-runtime's
  // generated viewmodel headers (ViewModelPropertyEnumCustom etc).
  enum: {
    property: 'ViewModelPropertyEnumCustom',
    instance: 'ViewModelInstanceEnum',
    bindable: 'BindablePropertyEnum',
    propertyKey: 637,
    comparator: 'TransitionValueEnumComparator',
  },
};

/** TransitionConditionOp in the runtime. */
export const CONDITION_OPS = { '==': 0, '!=': 1, '<=': 2, '>=': 3, '<': 4, '>': 5 } as const;
export type ConditionOp = keyof typeof CONDITION_OPS;

/** DataBindFlags.Direction: the bind writes into the view model. */
const TO_SOURCE = 1;

const PROPERTY_TYPES = Object.entries(TYPES).map(([k, v]) => [v.property, k as PropertyType] as const);
const INSTANCE_TYPES = Object.entries(TYPES).map(([k, v]) => [v.instance, k as PropertyType] as const);

export const propertyTypeOf = (coreType: string): PropertyType | undefined => PROPERTY_TYPES.find(([t]) => t === coreType)?.[1];
const instanceTypeOf = (coreType: string): PropertyType | undefined => INSTANCE_TYPES.find(([t]) => t === coreType)?.[1];

export interface PropertyDoc {
  /** the ViewModelProperty object */
  obj: CoreObj;
  /** the ViewModelInstance value holding the default, when the model has an instance */
  value?: CoreObj;
  name: string;
  type: PropertyType;
  /** index inside its view model */
  index: number;
  /** index of the view model in the file */
  viewModelIndex: number;
}

export interface ViewModelDoc {
  obj: CoreObj;
  name: string;
  /** index of this view model in the file */
  index: number;
  properties: PropertyDoc[];
  instance?: CoreObj;
  /** index of the instance in the file, -1 when there is none */
  instanceIndex: number;
}

function matchesViewModel(vmRef: unknown, vm: { obj: CoreObj; index: number }): boolean {
  if (typeof vmRef === 'string') return vmRef === vm.obj.id;
  return Number(vmRef ?? 0) === vm.index;
}

function parseColorValue(v: unknown): number {
  if (typeof v === 'number') return v >>> 0;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let h = m[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const rgb = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
    return ((a << 24) | rgb) >>> 0;
  }
  const r = s.match(/^rgba?\(([^)]+)\)$/i);
  if (r) {
    const [cr, cg, cb, ca = '1'] = r[1]!.split(',').map((x) => x.trim());
    return ((Math.round(Number(ca) * 255) << 24) | (Number(cr) << 16) | (Number(cg) << 8) | Number(cb)) >>> 0;
  }
  const hsl = s.match(/^hsla?\(([^)]+)\)$/i);
  if (hsl) {
    const [hs, ss, ls, as = '1'] = hsl[1]!.split(/[\s,/]+/).filter(Boolean);
    const h = ((parseFloat(hs!) % 360) + 360) % 360;
    const sat = parseFloat(ss!) / 100;
    const l = parseFloat(ls!) / 100;
    const a = as.endsWith('%') ? parseFloat(as) / 100 : Number(as);
    const k = (n: number) => (n + h / 30) % 12;
    const f = (n: number) => Math.round(255 * (l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return ((Math.round(a * 255) << 24) | (f(0) << 16) | (f(8) << 8) | f(4)) >>> 0;
  }
  const numeric = Number(s);
  return Number.isFinite(numeric) ? numeric >>> 0 : 0;
}

// ---------------------------------------------------------------------------
// Reading

/** Every view model in the file, with its properties and default instance. */
export function viewModels(doc: RiveDoc): ViewModelDoc[] {
  const models: ViewModelDoc[] = [];
  const instances: { obj: CoreObj; index: number; values: CoreObj[] }[] = [];
  let model: ViewModelDoc | undefined;
  let instance: (typeof instances)[number] | undefined;

  for (const o of doc.top) {
    if (o.type === 'ViewModel') {
      model = { obj: o, name: String(o.props.name ?? ''), index: models.length, properties: [], instanceIndex: -1 };
      models.push(model);
      instance = undefined;
    } else if (isA(o.type, 'ViewModelProperty')) {
      const type = propertyTypeOf(o.type);
      if (model && type) {
        model.properties.push({ obj: o, name: String(o.props.name ?? ''), type, index: model.properties.length, viewModelIndex: model.index });
      } else if (model) {
        // a property type OpenRive cannot edit still occupies an index
        model.properties.push({ obj: o, name: String(o.props.name ?? ''), type: 'string', index: model.properties.length, viewModelIndex: model.index });
      }
    } else if (o.type === 'ViewModelInstance') {
      instance = { obj: o, index: instances.length, values: [] };
      instances.push(instance);
      model = undefined;
    } else if (isA(o.type, 'ViewModelInstanceValue')) {
      instance?.values.push(o);
    }
  }

  // the first instance of a model holds the values the file plays with
  for (const inst of instances) {
    const vmRef = inst.obj.props.viewModelId;
    const target = typeof vmRef === 'string' ? models.find((m) => m.obj.id === vmRef) : models[Number(vmRef ?? 0)];
    if (!target || target.instance) continue;
    target.instance = inst.obj;
    target.instanceIndex = inst.index;
    for (const v of inst.values) {
      const p = target.properties[Number(v.props.viewModelPropertyId ?? 0)];
      if (p && !p.value) p.value = v;
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// Enums
//
// Rive's sixth property type. A DataEnumCustom holds the name and a group of
// DataEnumValue children (`key` is the stable identifier, `value` the label the
// editor shows); an enum property points at its DataEnumCustom by `enumId`, and
// an instance stores the selected key in `propertyValue`.

/** The enum a property object points at, as an id when it is resolved. */
const propsEnumId = (prop: CoreObj): string | undefined =>
  typeof prop.props.enumId === 'string' ? prop.props.enumId : undefined;

export interface EnumValueDoc {
  obj: CoreObj;
  key: string;
  value: string;
}

export interface EnumDoc {
  obj: CoreObj;
  name: string;
  values: EnumValueDoc[];
}

/**
 * Every enum in the file, with its options in declaration order.
 *
 * A `.riv` stream is flat: the options follow their enum as file-level objects
 * with no explicit parent, so they are read positionally from `doc.top`. Keeping
 * that layout is what makes the format round-trip byte for byte.
 */
export function enums(doc: RiveDoc): EnumDoc[] {
  const out: EnumDoc[] = [];
  doc.top.forEach((o, i) => {
    if (o.type !== 'DataEnumCustom') return;
    const values: EnumValueDoc[] = [];
    for (const next of doc.top.slice(i + 1)) {
      if (next.type !== 'DataEnumValue') break;
      values.push({ obj: next, key: String(next.props.key ?? ''), value: String(next.props.value ?? next.props.key ?? '') });
    }
    out.push({ obj: o, name: String(o.props.name ?? ''), values });
  });
  return out;
}

/** The enum an enum property points at. */
export function propertyEnum(doc: RiveDoc, p: PropertyDoc): EnumDoc | undefined {
  const id = p.obj.props.enumId;
  if (typeof id !== 'string') return undefined;
  return enums(doc).find((e) => e.obj.id === id);
}

/**
 * An enum instance value is the *index* of the chosen option, not its key: the
 * runtime resolves `ViewModelInstanceEnum.propertyValue` against the enum's
 * value list. The editor works in keys, so convert at these two edges.
 */
function enumIndexOf(doc: RiveDoc, prop: PropertyDoc, value: PropertyValue): number {
  const list = propertyEnum(doc, prop);
  const key = coerce('enum', value);
  if (!list?.values.length || key === undefined) return 0;
  const at = list.values.findIndex((v) => v.key === key);
  return at < 0 ? 0 : at;
}

/** The option key behind an enum instance value, for reading and editing. */
export function enumValueOf(doc: RiveDoc, prop: PropertyDoc, raw: PropertyValue | undefined): string | undefined {
  const list = propertyEnum(doc, prop);
  if (!list?.values.length) return undefined;
  if (typeof raw === 'string') return list.values.some((v) => v.key === raw) ? raw : list.values[0]!.key;
  const at = typeof raw === 'number' ? raw : 0;
  return (list.values[at] ?? list.values[0])!.key;
}

const keyOf = (label: string) =>
  label
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'value';

/**
 * Creates an enum definition, ready to be referenced by an enum property.
 *
 * The options are file-level objects that follow the enum in the stream, which
 * is the layout Rive writes: `DataEnumValue` has no parent reference, so the
 * runtime reads the run of values after a `DataEnumCustom` as its options.
 */
export function addEnum(doc: RiveDoc, name: string, labels: string[] = ['Option 1', 'Option 2']): EnumDoc {
  const base = name.trim() || 'Enum';
  let unique = base;
  let n = 2;
  const taken = new Set(enums(doc).map((e) => e.name));
  while (taken.has(unique)) unique = `${base} ${n++}`;
  const seen = new Set<string>();
  const values = labels.map((raw, i) => {
    const label = raw.trim() || `Option ${i + 1}`;
    const stem = keyOf(label);
    let key = stem;
    let suffix = 2;
    while (seen.has(key)) key = `${stem}_${suffix++}`;
    seen.add(key);
    return { label, key };
  });
  const enumObj = obj('DataEnumCustom', { name: unique });
  // values are file-level objects that follow the enum, in declaration order
  const valueObjs = values.map((v) => obj('DataEnumValue', { key: v.key, value: v.label }));
  const at = doc.top.map((o) => o.type).lastIndexOf('DataEnumCustom');
  doc.top.splice(at < 0 ? doc.top.length : at + 1, 0, enumObj, ...valueObjs);
  return { obj: enumObj, name: unique, values: values.map((v, i) => ({ obj: valueObjs[i]!, key: v.key, value: v.label })) };
}

/** Renames an enum and/or replaces its option labels, keeping keys stable where the label is unchanged. */
export function updateEnum(doc: RiveDoc, enumId: string, patch: { name?: string; labels?: string[] }) {
  const target = enums(doc).find((e) => e.obj.id === enumId);
  if (!target) return undefined;
  if (patch.name !== undefined && patch.name.trim()) target.obj.props.name = patch.name.trim();
  if (patch.labels) {
    const previous = target.values;
    const seen = new Set<string>();
    const next = patch.labels.map((raw, i) => {
      const label = raw.trim() || `Option ${i + 1}`;
      const reused = previous.find((v) => v.value === label);
      let key = reused?.key ?? keyOf(label);
      let suffix = 2;
      while (seen.has(key)) key = `${keyOf(label)}_${suffix++}`;
      seen.add(key);
      return obj('DataEnumValue', { key, value: label });
    });
    // replace the value block that follows the enum in the file-level stream
    const start = doc.top.indexOf(target.obj);
    let end = start + 1;
    while (end < doc.top.length && doc.top[end]!.type === 'DataEnumValue') end++;
    doc.top.splice(start + 1, end - start - 1, ...next);
    target.obj.children = undefined;

    // a stored value is an index into the options, so repoint any that is now
    // out of range (the runtime would otherwise read a removed option)
    for (const inst of doc.top.filter((o) => o.type === 'ViewModelInstanceEnum')) {
      const at = Number(inst.props.propertyValue ?? 0);
      if (!next.length) delete inst.props.propertyValue;
      else if (!Number.isFinite(at) || at < 0 || at >= next.length) inst.props.propertyValue = 0;
    }
  }
  return target;
}

/** Adds an enum property to an artboard's view model, creating the enum when a name is given. */
export function addEnumProperty(
  doc: RiveDoc,
  ab: ArtboardDoc,
  p: { name: string; labels?: string[]; enumId?: string; value?: string; viewModelName?: string },
): PropertyDoc {
  let enumId = p.enumId;
  if (!enumId) {
    if (p.labels) enumId = addEnum(doc, p.name, p.labels).obj.id;
    else throw new Error('An enum property needs either an existing enum or a list of option labels');
  }
  const target = enums(doc).find((e) => e.obj.id === enumId);
  if (!target) throw new Error('That enum does not exist in this file');
  const chosen = p.value ?? target.values[0]?.key;
  const at = Math.max(0, target.values.findIndex((v) => v.key === chosen || v.value === chosen));
  const added = addProperty(doc, ab, { name: p.name, type: 'enum', viewModelName: p.viewModelName });
  // The reference has to exist before the stored value can be resolved, so it is
  // written afterwards. Setting it through the property keeps every instance's
  // value in step, including the ones `addProperty` just created.
  added.obj.props.enumId = enumId;
  setPropertyValue(doc, ab, added.obj.id, target.values[at]?.key ?? '');
  return findProperty(doc, ab, added.obj.id) ?? added;
}

/** The enum an artboard is bound to, if any. */
export function artboardViewModel(doc: RiveDoc, ab: ArtboardDoc): ViewModelDoc | undefined {
  const id = ab.artboard.props.viewModelId;
  const models = viewModels(doc);
  if (typeof id === 'string') return models.find((m) => m.obj.id === id);
  return typeof id === 'number' ? models[id] : undefined;
}

/**
 * A view model instance somewhere in the file, with its stored values.
 *
 * Rive separates the *view model* (the blueprint) from its *instances* (the
 * values), and the Data panel shows both: the model's property list and a
 * table with one column per instance. Exposing instances here keeps that
 * distinction available to the UI instead of flattening it to the model.
 */
export interface ViewModelInstanceDoc {
  obj: CoreObj;
  name: string;
  index: number;
  /** file-level property values, keyed by property index */
  values: (PropertyValue | undefined)[];
}

/** Every instance of a view model, in file order, with its stored values. */
export function instances(doc: RiveDoc, vm: ViewModelDoc | undefined): ViewModelInstanceDoc[] {
  if (!vm) return [];
  const out: ViewModelInstanceDoc[] = [];
  doc.top.forEach((o, i) => {
    if (!matchesViewModel(o.props.viewModelId, vm)) return;
    if (o.type !== 'ViewModelInstance') return;
    // Values follow their instance in the file-level stream, in property order.
    // Parsing them positionally (rather than by parentId) is how viewModels()
    // already reads them, and keeps nested and top-level instances alike.
    const values: (PropertyValue | undefined)[] = [];
    for (const child of doc.top.slice(i + 1)) {
      if (!isA(child.type, 'ViewModelInstanceValue')) break;
      const p = vm.properties.find((prop) => prop.index === Number(child.props.viewModelPropertyId));
      if (p) values[p.index] = child.props.propertyValue as PropertyValue | undefined;
    }
    out.push({ obj: o, name: String(o.props.name ?? `Instance ${out.length + 1}`), index: out.length, values });
  });
  return out;
}

/**
 * The instance a view previews against: the artboard's own instance when it
 * has one, otherwise the model's first instance. Undefined for a model that
 * has no instance at all, which is a model that cannot be previewed.
 */
export function previewInstance(doc: RiveDoc, ab: ArtboardDoc): ViewModelInstanceDoc | undefined {
  const vm = artboardViewModel(doc, ab);
  return vm ? instances(doc, vm)[0] : undefined;
}

/** Renames a view model instance. */
export function renameInstance(doc: RiveDoc, instanceId: string, name: string) {
  const inst = doc.top.find((o) => o.id === instanceId && o.type === 'ViewModelInstance');
  const trimmed = name.trim();
  if (!inst || !trimmed) return undefined;
  inst.props.name = trimmed;
  return inst;
}

/** The data binding properties an artboard exposes. */
export function properties(doc: RiveDoc, ab: ArtboardDoc): PropertyDoc[] {
  return artboardViewModel(doc, ab)?.properties ?? [];
}

export function findProperty(doc: RiveDoc, ab: ArtboardDoc, ref: string): PropertyDoc | undefined {
  const list = properties(doc, ab);
  return list.find((p) => p.obj.id === ref) ?? list.find((p) => p.name === ref);
}

/** The value a property starts with. */
export function propertyValue(p: PropertyDoc): PropertyValue | undefined {
  return p.value?.props.propertyValue as PropertyValue | undefined;
}

// ---------------------------------------------------------------------------
// Writing

/** varuint encoding of a source path, as the runtime reads it. */
export function encodePath(indices: number[]): Uint8Array {
  const out: number[] = [];
  for (const value of indices) {
    let v = value >>> 0;
    do {
      const byte = v & 0x7f;
      v >>>= 7;
      out.push(v ? byte | 0x80 : byte);
    } while (v);
  }
  return new Uint8Array(out);
}

const pathTo = (p: PropertyDoc) => encodePath([p.viewModelIndex, p.index]);

/** Where the next property of this model goes in doc.top. */
function propertyInsertAt(doc: RiveDoc, vm: ViewModelDoc): number {
  const start = doc.top.indexOf(vm.obj);
  let at = start + 1;
  while (at < doc.top.length && isA(doc.top[at]!.type, 'ViewModelProperty')) at++;
  return at;
}

/** All instances of this model in doc.top, with their index in the file-level instance list. */
function instancesOfModel(doc: RiveDoc, vm: ViewModelDoc): { obj: CoreObj; instanceIndex: number }[] {
  const out: { obj: CoreObj; instanceIndex: number }[] = [];
  let instanceIndex = 0;
  for (const o of doc.top) {
    if (o.type !== 'ViewModelInstance') continue;
    if (matchesViewModel(o.props.viewModelId, vm)) out.push({ obj: o, instanceIndex });
    instanceIndex++;
  }
  return out;
}

/** The artboard's view model, created (with its instance) when missing. */
export function ensureViewModel(doc: RiveDoc, ab: ArtboardDoc, name?: string): ViewModelDoc {
  const existing = artboardViewModel(doc, ab);
  if (existing) return existing;
  const model = obj('ViewModel', { name: name ?? `${ab.artboard.props.name || 'Artboard'} Data` });
  const instance = obj('ViewModelInstance', { viewModelId: model.id, name: 'Instance' });
  doc.top.push(model, instance);
  ab.artboard.props.viewModelId = model.id;
  return artboardViewModel(doc, ab)!;
}

function coerce(type: PropertyType, value: PropertyValue | undefined): PropertyValue | undefined {
  if (value === undefined) return undefined;
  if (type === 'enum') return value === '' ? undefined : String(value);
  if (type === 'boolean') return !!value;
  if (type === 'string') return String(value);
  if (type === 'color') return parseColorValue(value);
  if (type === 'trigger') return undefined; // a trigger has no stored value
  return Number(value) || 0;
}

/** Adds a data binding property to the artboard's view model. */
export function addProperty(
  doc: RiveDoc,
  ab: ArtboardDoc,
  p: { name: string; type: PropertyType; value?: PropertyValue; viewModelName?: string },
): PropertyDoc {
  const vm = ensureViewModel(doc, ab, p.viewModelName);
  const info = TYPES[p.type];
  const index = vm.properties.length;
  const propObj = obj(info.property, { name: p.name });
  doc.top.splice(propertyInsertAt(doc, vm), 0, propObj);
  // an enum instance stores the chosen option's index, resolved once the enum is set
  const value = p.type === 'enum' ? undefined : coerce(p.type, p.value);
  const enumIndex = p.type === 'enum' ? 0 : undefined;
  for (const inst of instancesOfModel(doc, vm)) {
    const start = doc.top.indexOf(inst.obj);
    if (start < 0) continue;
    let at = start + 1;
    while (at < doc.top.length && isA(doc.top[at]!.type, 'ViewModelInstanceValue')) at++;
    doc.top.splice(at, 0, obj(info.instance, {
      ...(inst.instanceIndex > 0 ? { parentId: inst.instanceIndex } : {}),
      viewModelPropertyId: index,
      ...(value !== undefined ? { propertyValue: value } : enumIndex !== undefined ? { propertyValue: enumIndex } : {}),
    }));
  }
  return findProperty(doc, ab, propObj.id)!;
}

/** Sets the value a property starts with. */
export function setPropertyValue(doc: RiveDoc, ab: ArtboardDoc, ref: string, value: PropertyValue) {
  const p = findProperty(doc, ab, ref);
  if (!p?.value) return undefined;
  // an enum updates store the option's index, which is what the runtime reads
  if (p.type === 'enum') {
    p.value.props.propertyValue = enumIndexOf(doc, p, value);
    return p;
  }
  const v = coerce(p.type, value);
  if (v === undefined) delete p.value.props.propertyValue;
  else p.value.props.propertyValue = v;
  return p;
}

export function renameProperty(doc: RiveDoc, ab: ArtboardDoc, ref: string, name: string) {
  const p = findProperty(doc, ab, ref);
  const trimmed = name.trim();
  if (!p || !trimmed) return undefined;
  if (properties(doc, ab).some((other) => other.obj.id !== p.obj.id && other.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
    throw new Error(`A property named "${trimmed}" already exists`);
  }
  p.obj.props.name = trimmed;
  return p;
}

/** Renames the view model exposed by an artboard. */
export function renameViewModel(doc: RiveDoc, ab: ArtboardDoc, name: string) {
  const model = artboardViewModel(doc, ab);
  const trimmed = name.trim();
  if (!model || !trimmed) return undefined;
  if (viewModels(doc).some((other) => other.obj.id !== model.obj.id && other.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
    throw new Error(`A view model named "${trimmed}" already exists`);
  }
  model.obj.props.name = trimmed;
  return model;
}

// ---------------------------------------------------------------------------
// Conditions and listener actions

/** Every DataBindContext in the file, with the object that owns it. */
function dataBinds(doc: RiveDoc): { bind: CoreObj; owner: CoreObj }[] {
  const out: { bind: CoreObj; owner: CoreObj }[] = [];
  const walk = (o: CoreObj) => {
    for (const c of o.children ?? []) {
      if (c.type === 'DataBindContext') out.push({ bind: c, owner: o });
      walk(c);
    }
  };
  for (const ab of doc.artboards) {
    for (const sm of ab.stateMachines) walk(sm);
    for (const anim of ab.animations) walk(anim);
    let currentOwner: CoreObj = ab.artboard;
    for (const o of ab.objects) {
      if (o.type === 'DataBindContext') out.push({ bind: o, owner: currentOwner });
      else if (isA(o.type, 'Component')) currentOwner = o;
      walk(o);
    }
  }
  return out;
}

/** Decodes a varuint source path. */
export function decodePath(bytes: unknown): number[] {
  if (!(bytes instanceof Uint8Array)) return [];
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const b of bytes) {
    value |= (b & 0x7f) << shift;
    if (b & 0x80) {
      shift += 7;
    } else {
      out.push(value >>> 0);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/**
 * Removes a property, the conditions and listener actions that used it, and
 * renumbers everything that pointed past it.
 */
export function removeProperty(doc: RiveDoc, ab: ArtboardDoc, ref: string) {
  const vm = artboardViewModel(doc, ab);
  const p = findProperty(doc, ab, ref);
  if (!vm || !p) return false;

  // Instances are flat in doc.top, so collect values for every instance of
  // this model rather than editing only the default (first) instance.
  const valuesByInstance: CoreObj[][] = [];
  let instanceValues: CoreObj[] | undefined;
  for (const object of doc.top) {
    if (object.type === 'ViewModelInstance') {
      instanceValues = matchesViewModel(object.props.viewModelId, vm) ? [] : undefined;
      if (instanceValues) valuesByInstance.push(instanceValues);
    } else if (isA(object.type, 'ViewModelInstanceValue') && instanceValues) {
      instanceValues.push(object);
    } else if (object.type === 'ViewModel' || isA(object.type, 'ViewModelProperty')) {
      instanceValues = undefined;
    }
  }

  // remember what every bind pointed at before the indices move
  const before = dataBinds(doc).map((b) => ({ ...b, path: decodePath(b.bind.props.sourcePathIds) }));
  const removedValues = new Set(valuesByInstance.flatMap((values) => values.filter((value) => Number(value.props.viewModelPropertyId ?? -1) === p.index)));
  doc.top = doc.top.filter((o) => o !== p.obj && !removedValues.has(o));
  for (const values of valuesByInstance) {
    for (const value of values) {
      const index = Number(value.props.viewModelPropertyId ?? -1);
      if (index > p.index) value.props.viewModelPropertyId = index - 1;
    }
  }

  for (const { bind, owner, path } of before) {
    if (path.length !== 2 || path[0] !== vm.index) continue;
    if (path[1] === p.index) {
      // the condition or action has lost its property: drop it whole
      dropBindingGroup(doc, owner, bind);
    } else if (path[1]! > p.index) {
      bind.props.sourcePathIds = encodePath([path[0]!, path[1]! - 1]);
    }
  }
  return true;
}

/** Removes a condition (or a listener's action trio) that binds through `bind`. */
function dropBindingGroup(doc: RiveDoc, owner: CoreObj, bind: CoreObj) {
  if (owner.type === 'TransitionViewModelCondition') {
    const walk = (o: CoreObj) => {
      if (o.children?.includes(owner)) o.children = o.children.filter((c) => c !== owner);
      o.children?.forEach(walk);
    };
    for (const ab of doc.artboards) for (const sm of ab.stateMachines) walk(sm);
    return;
  }
  for (const ab of doc.artboards) {
    const flatIndex = ab.objects.indexOf(bind);
    if (flatIndex >= 0) {
      let from = flatIndex;
      while (from > 0 && ab.objects[from - 1]!.type === 'DataBindContext') from--;
      if (from > 0 && isA(ab.objects[from - 1]!.type, 'BindableProperty')) from--;
      let to = flatIndex;
      while (to + 1 < ab.objects.length && ab.objects[to + 1]!.type === 'DataBindContext') to++;
      if (ab.objects[to + 1]?.type === 'ListenerViewModelChange') to++;
      ab.objects.splice(from, to - from + 1);
      return;
    }
  }
  const kids = owner.children ?? [];
  const at = kids.indexOf(bind);
  if (at < 0) return;
  // [bindable, …binds…, ListenerViewModelChange]
  let from = at;
  while (from > 0 && kids[from - 1]!.type === 'DataBindContext') from--;
  if (from > 0 && isA(kids[from - 1]!.type, 'BindableProperty')) from--;
  let to = at;
  while (to + 1 < kids.length && kids[to + 1]!.type === 'DataBindContext') to++;
  if (kids[to + 1]?.type === 'ListenerViewModelChange') to++;
  owner.children = kids.filter((_, i) => i < from || i > to);
}

/**
 * A transition condition that reads a property:
 *   TransitionViewModelCondition > BindableProperty<T> + DataBindContext +
 *   TransitionPropertyViewModelComparator + TransitionValue<T>Comparator
 */
export function propertyCondition(p: PropertyDoc, op: ConditionOp = '==', value?: PropertyValue): CoreObj {
  const info = TYPES[p.type];
  // a trigger fires: compare "changed" rather than a value
  const opValue = p.type === 'trigger' ? CONDITION_OPS['!='] : CONDITION_OPS[op];
  const literal: Record<string, PropertyValue> = {};
  if (p.type === 'boolean') literal.value = value === undefined ? true : !!value;
  else if (p.type === 'number') literal.value = Number(value ?? 0);
  else if (p.type === 'string') literal.value = String(value ?? '');
  else if (p.type === 'color') literal.value = parseColorValue(value ?? 0);
  else if (p.type === 'enum') literal.value = String(value ?? '');
  return obj('TransitionViewModelCondition', opValue ? { opValue } : {}, [
    obj(info.bindable, {}),
    obj('DataBindContext', { propertyKey: info.propertyKey, sourcePathIds: pathTo(p) }),
    obj('TransitionPropertyViewModelComparator', {}),
    obj(info.comparator, literal),
  ]);
}

/**
 * The objects a listener needs to write a property:
 *   BindableProperty<T> (the value) + DataBindContext (to source) +
 *   ListenerViewModelChange
 */
export function propertyListenerAction(p: PropertyDoc, value?: PropertyValue): CoreObj[] {
  const info = TYPES[p.type];
  const v = p.type === 'boolean' ? value !== false : coerce(p.type, value);
  return [
    obj(info.bindable, v === undefined || v === false ? {} : { propertyValue: v }),
    obj('DataBindContext', { propertyKey: info.propertyKey, flags: TO_SOURCE, sourcePathIds: pathTo(p) }),
    obj('ListenerViewModelChange', {}),
  ];
}

// ---------------------------------------------------------------------------
// Converting a file's state machine inputs

const INPUT_TYPES: Record<string, PropertyType> = {
  StateMachineNumber: 'number',
  StateMachineBool: 'boolean',
  StateMachineTrigger: 'trigger',
};

export interface ConversionResult {
  /** properties created, by name */
  properties: string[];
  conditions: number;
  actions: number;
  /** inputs that had to stay, with the reason */
  kept: { name: string; reason: string }[];
}

/** Anything other than transitions and listeners that still needs an input. */
function otherInputUsers(sm: CoreObj): Map<string, string> {
  const blocked = new Map<string, string>();
  const walk = (o: CoreObj) => {
    const note =
      o.type === 'BlendAnimationDirect' || o.type === 'BlendState1DInput'
        ? 'a blend state still reads it'
        : isA(o.type, 'ListenerInputChange') && o.props.nestedInputId
          ? 'a nested artboard input still reads it'
          : o.type === 'ListenerBoolChange' && Number(o.props.value ?? 0) === 2
            ? 'a listener toggles it, which needs a data converter'
            : undefined;
    if (note && typeof o.props.inputId === 'string') blocked.set(o.props.inputId, note);
    o.children?.forEach(walk);
  };
  walk(sm);
  return blocked;
}

/**
 * Rewrites a state machine's inputs as view model properties: conditions read
 * the property, listeners write it, and the inputs go away. This is OpenRive's
 * "Convert inputs to data binding", the same move as Rive's editor.
 */
export function convertInputsToProperties(doc: RiveDoc, ab: ArtboardDoc, stateMachine?: CoreObj): ConversionResult {
  const machines = stateMachine ? [stateMachine] : ab.stateMachines;
  const result: ConversionResult = { properties: [], conditions: 0, actions: 0, kept: [] };

  for (const sm of machines) {
    const inputs = (sm.children ?? []).filter((c) => isA(c.type, 'StateMachineInput') && INPUT_TYPES[c.type]);
    if (!inputs.length) continue;
    const blocked = otherInputUsers(sm);
    const byInput = new Map<string, PropertyDoc>();

    for (const input of inputs) {
      if (blocked.has(input.id)) continue;
      const type = INPUT_TYPES[input.type]!;
      const rawName = String(input.props.name ?? 'Property');
      const existing = properties(doc, ab).find((candidate) => candidate.name === rawName && candidate.type === type);
      let name = rawName;
      if (!existing && findProperty(doc, ab, name)) {
        name = `${rawName} (${type})`;
      }
      const p = existing ?? addProperty(doc, ab, { name, type, value: input.props.value as PropertyValue | undefined });
      byInput.set(input.id, p);
      if (!existing) result.properties.push(name);
    }

    // conditions: TransitionInputCondition → TransitionViewModelCondition
    const convertConditions = (o: CoreObj) => {
      if (o.children?.length) {
        o.children = o.children.flatMap((c) => {
          if (isA(c.type, 'TransitionInputCondition') && typeof c.props.inputId === 'string') {
            const p = byInput.get(c.props.inputId);
            if (p) {
              result.conditions++;
              const op = c.type === 'TransitionNumberCondition' ? (Object.keys(CONDITION_OPS) as ConditionOp[])[Number(c.props.opValue ?? 0)] ?? '==' : '==';
              const value =
                c.type === 'TransitionBoolCondition'
                  ? Number(c.props.opValue ?? 0) !== 1
                  : c.type === 'TransitionNumberCondition'
                    ? Number(c.props.value ?? 0)
                    : undefined;
              return [propertyCondition(p, op, value)];
            }
          }
          convertConditions(c);
          return [c];
        });
      }
    };
    convertConditions(sm);

    // listener actions: Listener*Change → BindableProperty + DataBindContext + ListenerViewModelChange
    for (const listener of (sm.children ?? []).filter((c) => isA(c.type, 'StateMachineListener'))) {
      listener.children = (listener.children ?? []).flatMap((a) => {
        if (!isA(a.type, 'ListenerInputChange') || typeof a.props.inputId !== 'string') return [a];
        const p = byInput.get(a.props.inputId);
        if (!p) return [a];
        result.actions++;
        const value = a.type === 'ListenerBoolChange' ? Number(a.props.value ?? 1) === 1 : a.type === 'ListenerNumberChange' ? Number(a.props.value ?? 0) : undefined;
        return propertyListenerAction(p, value);
      });
    }

    for (const input of inputs) {
      const reason = blocked.get(input.id);
      if (reason) result.kept.push({ name: String(input.props.name ?? ''), reason });
    }
    // inputs that were fully converted can go
    sm.children = (sm.children ?? []).filter((c) => !byInput.has(c.id));
  }
  return result;
}

/** Whether this artboard still uses deprecated state machine inputs. */
export function usesInputs(ab: ArtboardDoc): boolean {
  return ab.stateMachines.some((sm) => (sm.children ?? []).some((c) => isA(c.type, 'StateMachineInput')));
}
