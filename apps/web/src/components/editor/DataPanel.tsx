'use client';
// The Data panel: view models, their properties, and the table of view model
// instances — the same three things Rive's Data panel shows.
//
// Rive separates the *view model* (a reusable blueprint: name + property list)
// from *view model instances* (the values). The panel filters on that split:
// "Properties" edits the blueprint, "Data table" edits one row per property
// across one column per instance, which is what you use to fill in sample data
// before previewing. Our file layout stores models, properties, instances and
// per-instance values as flat file-level objects, so both views are two
// projections of the same objects (see packages/rive/src/databind.ts).
import { useMemo, useState } from 'react';
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  Copy,
  Hash,
  Palette,
  Pencil,
  Plus,
  ListOrdered,
  Table2,
  ToggleLeft,
  Trash2,
  Type,
  Zap,
} from 'lucide-react';
import { ArtboardDoc, RiveDoc } from '@openrive/rive/document';
import { obj } from '@openrive/rive/factory';
import { findArtboard } from '@openrive/rive/ops';
import {
  addEnumProperty,
  addProperty,
  artboardViewModel,
  convertInputsToProperties,
  enumValueOf,
  enums,
  propertyEnum,
  updateEnum,
  instances as modelInstances,
  PropertyDoc,
  PropertyType,
  PropertyValue,
  propertyValue,
  previewInstance,
  removeProperty,
  renameProperty,
  renameViewModel,
  setPropertyValue,
  usesInputs,
  viewModels,
} from '@openrive/rive/databind';
import { PanelHeader, promptDialog, TabStrip } from '@openrive/ui';
import { toast } from '@/lib/client/toast';
import { useActiveArtboard, useEditor } from '@/lib/store/editor';
import { NumberField, TextField } from './controls';
import { openContextMenu, sep } from './ContextMenu';

const PROPERTY_TYPES: { type: PropertyType; label: string; icon: React.ReactNode; hint: string }[] = [
  { type: 'number', label: 'Number', icon: <Hash size={12} />, hint: 'Numeric value' },
  { type: 'boolean', label: 'Boolean', icon: <ToggleLeft size={12} />, hint: 'True or false' },
  { type: 'trigger', label: 'Trigger', icon: <Zap size={12} />, hint: 'Fire-and-forget event' },
  { type: 'string', label: 'String', icon: <Type size={12} />, hint: 'Text value' },
  { type: 'color', label: 'Color', icon: <Palette size={12} />, hint: 'RGBA color value' },
  { type: 'enum', label: 'Enum', icon: <ListOrdered size={12} />, hint: 'One of a fixed set of options' },
];

const PROPERTY_ICONS: Record<PropertyType, React.ReactNode> = Object.fromEntries(
  PROPERTY_TYPES.map((p) => [p.type, p.icon]),
) as Record<PropertyType, React.ReactNode>;

type DataTab = 'properties' | 'table';
type View = 'artboard' | 'file';

const hex = (v: unknown) => `#${((Number(v ?? 0) >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Writes one property value on one instance.
 *
 * The first instance of a model is the one the file previews with, and the
 * shared helper already owns its value objects, so it is used there. Later
 * instances need the value object appended to *their* value block, in property
 * order, which is what the runtime expects when a model has several instances.
 */
function writeInstanceValue(
  doc: RiveDoc,
  ab: ArtboardDoc,
  property: PropertyDoc,
  instanceId: string,
  value: number | boolean | string,
) {
  const vm = artboardViewModel(doc, ab);
  const target = vm ? modelInstances(doc, vm).find((i) => i.obj.id === instanceId) : undefined;
  if (!vm || !target) return;
  if (target.index === 0) {
    setPropertyValue(doc, ab, property.obj.id, value);
    return;
  }
  const start = doc.top.indexOf(target.obj);
  let end = start + 1;
  while (end < doc.top.length && doc.top[end]!.type === 'ViewModelInstanceValue') end++;
  const block = doc.top.slice(start + 1, end);
  const existing = block.find(
    (o) => o.type === 'ViewModelInstanceValue' && Number(o.props.viewModelPropertyId ?? 0) === property.index,
  );
  if (existing) {
    existing.props.propertyValue = value;
    return;
  }
  const valueType: Record<PropertyType, string> = {
    number: 'ViewModelInstanceNumber',
    boolean: 'ViewModelInstanceBoolean',
    trigger: 'ViewModelInstanceTrigger',
    string: 'ViewModelInstanceString',
    color: 'ViewModelInstanceColor',
    enum: 'ViewModelInstanceEnum',
  };
  const created = obj(valueType[property.type], {
    parentId: target.index,
    viewModelPropertyId: property.index,
    propertyValue: value,
  });
  // keep values in property order inside the instance block
  const after = block.findIndex(
    (o) => o.type === 'ViewModelInstanceValue' && Number(o.props.viewModelPropertyId ?? 0) > property.index,
  );
  doc.top.splice(after < 0 ? end : start + 1 + after, 0, created);
}

export function DataPanel() {
  const doc = useEditor((s) => s.doc);
  const readOnly = useEditor((s) => s.readOnly);
  const ab = useActiveArtboard();
  const [tab, setTab] = useState<DataTab>('properties');
  const [view, setView] = useState<View>('artboard');
  const [addOpen, setAddOpen] = useState(false);
  const [tableInstance, setTableInstance] = useState<string | null>(null);

  const s = useEditor.getState();
  const fileModels = useMemo(() => (doc ? viewModels(doc) : []), [doc]);
  const artboardModel = doc && ab ? artboardViewModel(doc, ab) : undefined;
  const model = view === 'artboard' ? artboardModel : fileModels[0];
  const properties = model?.properties ?? [];
  const instances = useMemo(() => (doc && model ? modelInstances(doc, model) : []), [doc, model]);
  const shownInstance = instances.find((i) => i.obj.id === tableInstance) ?? instances[0];
  const legacyInputs = ab ? usesInputs(ab) : false;

  if (!doc) return null;

  const edit = (fn: (d: RiveDoc, artboard: ArtboardDoc) => void) => {
    if (!ab) return;
    s.commit((d) => {
      const artboard = findArtboard(d, ab.id);
      if (artboard) fn(d, artboard);
    });
  };

  const attachModel = () => {
    if (!ab) return;
    s.commit((d) => {
      const artboard = findArtboard(d, ab.id);
      if (!artboard) return;
      const existing = viewModels(d)[0];
      if (existing) artboard.artboard.props.viewModelId = existing.obj.id;
      else addProperty(d, artboard, { name: 'value', type: 'number', value: 0 });
    });
  };

  const add = async (type: PropertyType) => {
    setAddOpen(false);
    if (!ab) return;
    const n = (artboardViewModel(doc, ab)?.properties.length ?? 0) + 1;
    if (type === 'enum') {
      // an enum needs its options up front; comma-separated is the quickest way in
      const answer = await promptDialog({
        title: 'New enum property',
        label: 'Options (comma separated)',
        defaultValue: 'Small, Medium, Large',
        confirmLabel: 'Create',
      });
      if (!answer) return;
      const labels = answer.split(',').map((v) => v.trim()).filter(Boolean);
      edit((d, artboard) => {
        try {
          addEnumProperty(d, artboard, { name: defaultName('enum', n), labels: labels.length ? labels : ['Option 1', 'Option 2'] });
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Could not add the enum property');
        }
      });
      return;
    }
    edit((d, artboard) => {
      addProperty(d, artboard, { name: defaultName(type, n), type, value: defaultFor(type) });
    });
  };

  const convert = () => {
    if (!ab) return;
    s.commit((d) => {
      const artboard = findArtboard(d, ab.id);
      if (!artboard) return;
      const result = convertInputsToProperties(d, artboard);
      toast(
        `Converted ${result.properties.length} input${result.properties.length === 1 ? '' : 's'} to view model properties` +
          (result.kept.length ? `, kept ${result.kept.length} (${result.kept.map((k) => k.name).join(', ')})` : ''),
      );
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="section !py-1.5">
        <PanelHeader icon={<Braces size={13} className="text-t2" />} title="Data">
          {viewModels(doc).length > 1 && (
            <button
              className="icon-btn"
              title={view === 'artboard' ? 'Show the file view models' : 'Show the artboard view model'}
              onClick={() => setView(view === 'artboard' ? 'file' : 'artboard')}
            >
              {view === 'artboard' ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          )}
          <button className="icon-btn" title="Add data property" disabled={readOnly || !ab} onClick={() => setAddOpen(!addOpen)}>
            <Plus size={14} />
          </button>
        </PanelHeader>

        {model ? (
          <div className="flex items-center gap-1.5 mt-1">
            <Pencil size={11} className="text-t3 shrink-0" />
            <TextField
              value={model.name}
              className="h-6 flex-1"
              disabled={readOnly}
              onChange={(name) =>
                edit((d, artboard) => {
                  try {
                    renameViewModel(d, artboard, name);
                  } catch (error) {
                    toast(error instanceof Error ? error.message : 'Could not rename view model');
                  }
                })
              }
            />
            <span className="text-t3 text-[10px] shrink-0 tabular-nums">
              {properties.length} prop{properties.length === 1 ? '' : 's'}
            </span>
          </div>
        ) : (
          <div className="mt-1.5 rounded border border-line bg-bg2 p-2">
            <p className="text-t2 text-[11px]">This artboard has no view model yet.</p>
            <p className="text-t3 text-[11px] mt-0.5">
              A view model gives the artboard data your app can set: transitions read it, and so does your runtime code.
            </p>
            {!readOnly && (
              <button className="btn h-7 w-full mt-2" onClick={attachModel}>
                <Plus size={13} /> Create view model
              </button>
            )}
          </div>
        )}

        {addOpen && (
          <div className="grid grid-cols-1 gap-0.5 mt-1.5 rounded border border-line bg-bg2 p-1">
            {PROPERTY_TYPES.map((p) => (
              <button
                key={p.type}
                className="flex items-center gap-2 h-7 px-2 rounded text-left hover:bg-bg3"
                onClick={() => add(p.type)}
              >
                <span className="text-t2">{p.icon}</span>
                <span className="text-[11px] text-t0 flex-1">{p.label}</span>
                <span className="text-[10px] text-t3">{p.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <TabStrip
        items={[
          { id: 'properties', label: 'Properties', icon: <Braces size={11} /> },
          { id: 'table', label: 'Data table', icon: <Table2 size={11} /> },
        ]}
        value={tab}
        onChange={(t) => setTab(t as DataTab)}
      />

      {tab === 'properties' ? (
        <div className="flex-1 overflow-auto p-1.5">
          {!properties.length && model && <div className="text-t3 text-[11px] px-1 py-2">No properties yet. Use + to add one.</div>}
          {properties.map((property) => (
            <PropertyRow
              key={property.obj.id}
              property={property}
              readOnly={readOnly}
              onEdit={(fn) => edit(fn)}
            />
          ))}
          {legacyInputs && (
            <div className="mt-3 p-2 rounded border border-line bg-bg2">
              <div className="flex items-center gap-1.5 text-[11px] text-t1">
                <Braces size={12} /> Deprecated inputs
              </div>
              <p className="text-t3 text-[11px] mt-1">
                This state machine still uses inputs. Rive deprecated them in favour of view model properties; converting keeps the
                behaviour and drops the runtime warnings.
              </p>
              {!readOnly && (
                <button className="btn h-7 w-full mt-2" onClick={convert}>
                  Convert to data binding
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col">
          {!model || !properties.length ? (
            <div className="text-t3 text-[11px] p-3">
              Add a number, boolean, string, color or trigger property to fill in the data table.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line bg-bg1 sticky top-0">
                <Table2 size={12} className="text-t2" />
                <span className="text-[10px] uppercase tracking-wide text-t3 flex-1">Instance</span>
                {instances.length > 1 ? (
                  <select
                    className="field h-6 text-[11px] py-0"
                    value={shownInstance?.obj.id ?? ''}
                    onChange={(e) => setTableInstance(e.target.value)}
                  >
                    {instances.map((inst) => (
                      <option key={inst.obj.id} value={inst.obj.id}>
                        {inst.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[11px] text-t2">{shownInstance?.name ?? 'No instance'}</span>
                )}
              </div>
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-t3">
                    <th className="text-left font-medium px-2 py-1 border-b border-line w-[42%]">Property</th>
                    <th className="text-left font-medium px-2 py-1 border-b border-line">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {properties.map((property) => (
                    <tr key={property.obj.id} className="hover:bg-bg2">
                      <td className="px-2 py-1 border-b border-line/60">
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <span className="text-t2 shrink-0" title={property.type}>
                            {PROPERTY_ICONS[property.type]}
                          </span>
                          <span className="truncate text-t0" title={`${property.name} (${property.type})`}>
                            {property.name}
                          </span>
                        </span>
                      </td>
                      <td className="px-2 py-0.5 border-b border-line/60">
                        <InstanceValueCell
                          property={property}
                          instanceId={shownInstance?.obj.id}
                          value={shownInstance ? shownInstance.values[property.index] : propertyValue(property)}
                          readOnly={readOnly}
                          onChange={(value) => {
                            if (!shownInstance) return;
                            const instanceId = shownInstance.obj.id;
                            edit((d, artboard) => writeInstanceValue(d, artboard, property, instanceId, value));
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-t3 text-[10px] px-2 py-2 leading-relaxed">
                Values start the artboard with data. Runtime code reads and writes the same properties through the Rive runtimes.
              </p>
            </>
          )}
        </div>
      )}

      {ab && (
        <div className="border-t border-line px-2 py-1.5 text-[10px] text-t3">
          {previewInstance(doc, ab) ? (
            <>Preview uses instance “{previewInstance(doc, ab)!.name}”</>
          ) : (
            <>Artboard is not bound to a view model instance</>
          )}
        </div>
      )}
    </div>
  );
}

function defaultName(type: PropertyType, n: number) {
  const base =
    type === 'boolean' ? 'isOn'
      : type === 'trigger' ? 'onFire'
        : type === 'string' ? 'label'
          : type === 'color' ? 'color'
            : type === 'enum' ? 'variant'
              : 'number';
  return n > 1 ? `${base}${n}` : base;
}

function defaultFor(type: PropertyType): number | boolean | string {
  if (type === 'boolean') return false;
  if (type === 'string') return '';
  if (type === 'color') return 0xff57a5e0;
  if (type === 'trigger') return 0;
  if (type === 'enum') return '';
  return 0;
}

/** One property in the blueprint list: rename, edit its default, delete. */
function PropertyRow({
  property,
  readOnly,
  onEdit,
}: {
  property: PropertyDoc;
  readOnly: boolean;
  onEdit: (fn: (d: RiveDoc, ab: ArtboardDoc) => void) => void;
}) {
  const doc = useEditor((state) => state.doc);
  const list = property.type === 'enum' && doc ? propertyEnum(doc, property) : undefined;
  // an enum instance stores the option index; the picker works in option keys
  const value =
    property.type === 'enum' && doc ? enumValueOf(doc, property, propertyValue(property)) : propertyValue(property);
  const set = (v: number | boolean | string) => onEdit((d, ab) => setPropertyValue(d, ab, property.obj.id, v));
  return (
    <div
      className="flex items-center gap-2 h-8 px-2 rounded hover:bg-bg2 group"
      onContextMenu={(e) =>
        openContextMenu(e, [
          {
            label: 'Rename…',
            icon: <Pencil size={12} />,
            disabled: readOnly,
            run: async () => {
              const name = await promptDialog({ title: 'Rename property', label: 'Property name', defaultValue: property.name, confirmLabel: 'Rename' });
              if (name) onEdit((d, ab) => void renameProperty(d, ab, property.obj.id, name));
            },
          },
          {
            label: 'Duplicate',
            icon: <Copy size={12} />,
            disabled: readOnly,
            run: () => onEdit((d, ab) => void addProperty(d, ab, { name: `${property.name} copy`, type: property.type, value })),
          },
          sep,
          {
            label: 'Delete property',
            icon: <Trash2 size={12} />,
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
      <ValueControl type={property.type} value={value} readOnly={readOnly} onChange={set} compact options={list?.values} />
    </div>
  );
}

/** Inline editor for a single value of a given property type. */
function ValueControl({
  type,
  value,
  readOnly,
  onChange,
  compact,
  options,
}: {
  type: PropertyType;
  value: unknown;
  readOnly: boolean;
  onChange: (v: number | boolean | string) => void;
  compact?: boolean;
  /** enum options: the values offered for an `enum` property */
  options?: { key: string; value: string }[];
}) {
  const width = compact ? 'w-16' : 'w-full';
  if (type === 'enum')
    return (
      <select
        className={`field h-6 text-[11px] py-0 ${compact ? 'w-20' : 'w-full'}`}
        value={String(value ?? '')}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      >
        {!options?.length && <option value="">No options</option>}
        {options?.map((option) => (
          <option key={option.key} value={option.key}>
            {option.value}
          </option>
        ))}
      </select>
    );
  if (type === 'number')
    return (
      <div className={width}>
        <NumberField value={Number(value ?? 0)} onChange={onChange} disabled={readOnly} />
      </div>
    );
  if (type === 'boolean')
    return <input type="checkbox" checked={!!value} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />;
  if (type === 'string')
    return (
      <input
        className={`field h-6 ${compact ? 'w-20' : 'w-full'}`}
        value={String(value ?? '')}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (type === 'color')
    return (
      <input
        type="color"
        className="w-8 h-6"
        value={hex(value)}
        disabled={readOnly}
        onChange={(e) => onChange((0xff000000 | parseInt(e.target.value.slice(1), 16)) >>> 0)}
      />
    );
  return <span className="text-t3 text-[10px]">fire in Preview</span>;
}

function InstanceValueCell({
  property,
  instanceId,
  value,
  readOnly,
  onChange,
}: {
  property: PropertyDoc;
  instanceId?: string;
  value: unknown;
  readOnly: boolean;
  onChange: (v: number | boolean | string) => void;
}) {
  const doc = useEditor((state) => state.doc);
  const list = property.type === 'enum' && doc ? propertyEnum(doc, property) : undefined;
  if (property.type === 'trigger') return <span className="text-t3 text-[10px]">fire in Preview</span>;
  if (!instanceId) return <span className="text-t3 text-[10px]">no instance</span>;
  const shown = property.type === 'enum' && doc ? enumValueOf(doc, property, value as PropertyValue | undefined) : value;
  return <ValueControl type={property.type} value={shown} readOnly={readOnly} onChange={onChange} options={list?.values} />;
}
