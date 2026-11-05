import { useMemo, useRef, useState } from "react";
import { Icon, Switch } from "./ui";
import {
  FIELD_TYPES,
  SCHEMA_LIMITS,
  cleanSchema,
  isSelectType,
  isTextType,
  parseSchemaForBuilder,
  slugify,
  uniqueActionId,
  validateMetadataSchema,
  type FieldType,
  type MetadataSchema,
  type SchemaField,
  type SchemaOption,
  type SchemaProblem,
} from "../lib/metadata-schema";

const DEFAULT_SUBMIT = "Save to Feed";
const typeLabel = (type: string) => FIELD_TYPES.find((t) => t.type === type)?.label ?? type;

function newField(type: FieldType, taken: string[]): SchemaField {
  const label = typeLabel(type);
  const field: SchemaField = { action_id: uniqueActionId(slugify(label), taken), label, type, optional: false };
  if (isSelectType(type))
    field.options = [
      { label: "Option 1", value: "option_1" },
      { label: "Option 2", value: "option_2" },
    ];
  return field;
}

export function serializeSchema(schema: MetadataSchema): string {
  return JSON.stringify(cleanSchema(schema), null, 2);
}

/** What to store: a form with no fields is saved as no form at all. */
export function schemaToSave(raw: string): string {
  const parsed = parseSchemaForBuilder(raw);
  return parsed && parsed.fields.length === 0 ? "" : raw.trim();
}

export function schemaProblems(raw: string): SchemaProblem[] {
  if (!raw.trim()) return [];
  try {
    return validateMetadataSchema(JSON.parse(raw));
  } catch (e: any) {
    return [{ field: null, message: `Invalid JSON: ${e.message}` }];
  }
}

/**
 * Visual editor for a channel's metadata form, with a JSON view for anything it
 * doesn't cover and a live mock of the Slack modal approvers will see.
 */
export function MetadataBuilder({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const parsed = useMemo(() => parseSchemaForBuilder(value), [value]);
  const [mode, setMode] = useState<"visual" | "json">(parsed ? "visual" : "json");
  const [open, setOpen] = useState<number | null>(null);
  const problems = useMemo(() => schemaProblems(value), [value]);

  // Stable React keys for fields, kept in step with every add, move and delete.
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  const count = parsed?.fields.length ?? 0;
  if (keys.current.length !== count) keys.current = Array.from({ length: count }, () => nextKey.current++);

  const schema = parsed ?? { title: "Metadata", fields: [] };
  const commit = (next: MetadataSchema) => onChange(serializeSchema(next));
  const setFields = (fields: SchemaField[]) => commit({ ...schema, fields });
  const updateField = (i: number, patch: Partial<SchemaField>) =>
    setFields(schema.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const add = (type: FieldType) => {
    keys.current = [...keys.current, nextKey.current++];
    setFields([...schema.fields, newField(type, schema.fields.map((f) => f.action_id))]);
    setOpen(schema.fields.length);
  };
  const remove = (i: number) => {
    keys.current = keys.current.filter((_, j) => j !== i);
    setFields(schema.fields.filter((_, j) => j !== i));
    setOpen(null);
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= schema.fields.length) return;
    const swap = <T,>(list: T[]) => {
      const out = [...list];
      out[i] = list[j]!;
      out[j] = list[i]!;
      return out;
    };
    keys.current = swap(keys.current);
    setFields(swap(schema.fields));
    if (open === i) setOpen(j);
    else if (open === j) setOpen(i);
  };
  const duplicate = (i: number) => {
    const f = schema.fields[i];
    if (!f) return;
    const copy: SchemaField = {
      ...structuredClone(f),
      label: `${f.label} (copy)`,
      action_id: uniqueActionId(f.action_id, schema.fields.map((x) => x.action_id)),
    };
    keys.current = [...keys.current.slice(0, i + 1), nextKey.current++, ...keys.current.slice(i + 1)];
    setFields([...schema.fields.slice(0, i + 1), copy, ...schema.fields.slice(i + 1)]);
    setOpen(i + 1);
  };

  const formProblems = problems.filter((p) => p.field === null);
  const fieldProblems = (i: number) => problems.filter((p) => p.field === i).map((p) => p.message);

  return (
    <div className="mb">
      <div className="mb-toolbar">
        <div className="segmented" role="tablist" aria-label="Editor">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "visual"}
            className={mode === "visual" ? "active" : ""}
            disabled={!parsed}
            title={parsed ? undefined : "Fix the JSON to edit visually"}
            onClick={() => setMode("visual")}
          >
            <Icon name="layers" size={14} /> Visual
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "json"}
            className={mode === "json" ? "active" : ""}
            onClick={() => setMode("json")}
          >
            <Icon name="code" size={14} /> JSON
          </button>
        </div>
        <span className="field-hint">
          {count === 0 ? "No fields yet. Without fields, there's no metadata form." : `${count} field${count === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="mb-layout">
        <div className="mb-editor">
          {mode === "json" || !parsed ? (
            <div className="field">
              <textarea
                className="textarea"
                rows={16}
                spellCheck={false}
                disabled={disabled}
                placeholder={'{\n  "title": "Metadata",\n  "fields": [\n    { "action_id": "title", "label": "Title", "type": "plain_text_input" }\n  ]\n}'}
                value={value}
                onChange={(e) => onChange(e.currentTarget.value)}
              />
            </div>
          ) : (
            <>
              <div className="mb-form-settings">
                <LabeledInput
                  label="Form title"
                  value={schema.title}
                  max={SCHEMA_LIMITS.title}
                  disabled={disabled}
                  onChange={(title) => commit({ ...schema, title })}
                />
                <LabeledInput
                  label="Submit button"
                  value={schema.submit_label ?? ""}
                  placeholder={DEFAULT_SUBMIT}
                  max={SCHEMA_LIMITS.submitLabel}
                  disabled={disabled}
                  onChange={(submit_label) => commit({ ...schema, submit_label })}
                />
              </div>

              <ol className="mb-fields">
                {schema.fields.map((f, i) => (
                  <FieldCard
                    key={keys.current[i]}
                    field={f}
                    index={i}
                    total={schema.fields.length}
                    open={open === i}
                    problems={fieldProblems(i)}
                    disabled={disabled}
                    taken={schema.fields.filter((_, j) => j !== i).map((x) => x.action_id)}
                    onToggle={() => setOpen(open === i ? null : i)}
                    onChange={(patch) => updateField(i, patch)}
                    onMove={(by) => move(i, by)}
                    onDuplicate={() => duplicate(i)}
                    onRemove={() => remove(i)}
                  />
                ))}
              </ol>

              {!disabled && schema.fields.length < SCHEMA_LIMITS.fields && (
                <div className="mb-add">
                  <span className="field-label">Add a question</span>
                  <div className="mb-add-grid">
                    {FIELD_TYPES.map((t) => (
                      <button key={t.type} type="button" className="mb-add-btn" title={t.hint} onClick={() => add(t.type)}>
                        <TypeGlyph type={t.type} />
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {(mode === "json" || !parsed) &&
            problems.map((p, i) => (
              <span key={i} className="field-error">
                {p.field === null ? p.message : `Field ${p.field + 1}: ${p.message}`}
              </span>
            ))}
          {mode === "visual" &&
            parsed &&
            formProblems.map((p, i) => (
              <span key={i} className="field-error">
                {p.message}
              </span>
            ))}
        </div>

        <div className="mb-preview-wrap">
          <span className="field-label">Preview</span>
          {parsed ? (
            <SlackModalPreview schema={schema} active={open} onPick={(i) => setOpen(i)} />
          ) : (
            <p className="field-hint">The preview appears once the JSON is valid.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  max,
  disabled,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  max?: number;
  disabled?: boolean;
  mono?: boolean;
}) {
  const over = max !== undefined && value.length > max;
  return (
    <label className="field">
      <span className="field-label mb-label-row">
        {label}
        {max !== undefined && value.length > max * 0.7 && (
          <span className={"mb-count" + (over ? " over" : "")}>
            {value.length}/{max}
          </span>
        )}
      </span>
      <input
        className={"input" + (mono ? " mono" : "")}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </label>
  );
}

function FieldCard({
  field: f,
  index,
  total,
  open,
  problems,
  disabled,
  taken,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  field: SchemaField;
  index: number;
  total: number;
  open: boolean;
  problems: string[];
  disabled?: boolean;
  taken: string[];
  onToggle: () => void;
  onChange: (patch: Partial<SchemaField>) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const required = f.optional === false;
  const setLabel = (label: string) => {
    // Keep the ID following the label until someone edits the ID by hand.
    const following = !f.action_id || f.action_id === slugify(f.label) || f.action_id === uniqueActionId(slugify(f.label), taken);
    onChange(following ? { label, action_id: uniqueActionId(slugify(label), taken) } : { label });
  };
  const num = (v: string) => (v === "" ? undefined : Math.max(0, Math.floor(Number(v)) || 0));

  return (
    <li className={"mb-field" + (open ? " open" : "") + (problems.length ? " invalid" : "")}>
      <div className="mb-field-head">
        <button type="button" className="mb-field-toggle" onClick={onToggle} aria-expanded={open}>
          <TypeGlyph type={f.type} />
          <span className="mb-field-title">{f.label || <em>Untitled</em>}</span>
          <span className="badge outline">{typeLabel(f.type)}</span>
          {required && <span className="badge">Required</span>}
          {problems.length > 0 && <span className="badge danger">{problems.length} to fix</span>}
        </button>
        {!disabled && (
          <div className="mb-field-actions">
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
              <span className="mb-rot">
                <Icon name="chevronDown" size={14} />
              </span>
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>
              <Icon name="chevronDown" size={14} />
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Duplicate" onClick={onDuplicate}>
              <Icon name="copy" size={14} />
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Delete" onClick={onRemove}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        )}
      </div>

      {open && (
        <div className="mb-field-body">
          <div className="mb-grid">
            <LabeledInput label="Question" value={f.label} disabled={disabled} onChange={setLabel} max={SCHEMA_LIMITS.label} />
            <label className="field">
              <span className="field-label">Type</span>
              <select
                className="select"
                value={f.type}
                disabled={disabled}
                onChange={(e) => {
                  const type = e.currentTarget.value as FieldType;
                  const patch: Partial<SchemaField> = { type };
                  if (isSelectType(type) && !f.options?.length) patch.options = newField(type, []).options;
                  onChange(patch);
                }}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
                {!FIELD_TYPES.some((t) => t.type === f.type) && <option value={f.type}>{f.type}</option>}
              </select>
            </label>
          </div>

          <div className="mb-grid">
            <LabeledInput
              label="ID"
              mono
              value={f.action_id}
              disabled={disabled}
              onChange={(action_id) => onChange({ action_id })}
            />
            {f.type !== "file_input" && (
              <LabeledInput
                label="Placeholder"
                value={f.placeholder ?? ""}
                max={SCHEMA_LIMITS.placeholder}
                disabled={disabled}
                onChange={(placeholder) => onChange({ placeholder })}
              />
            )}
          </div>
          <span className="field-hint">
            The ID is the key in webhooks, the API and message formats. Changing it after messages have metadata leaves old
            values under the old ID.
          </span>

          <div className="mb-toggles">
            <label className="mb-toggle">
              <Switch label="Required" checked={required} disabled={disabled} onChange={(on) => onChange({ optional: !on })} />
              Required
            </label>
            {isTextType(f.type) && (
              <label className="mb-toggle">
                <Switch label="Paragraph" checked={!!f.multiline} disabled={disabled} onChange={(multiline) => onChange({ multiline })} />
                Paragraph (multi-line)
              </label>
            )}
          </div>

          {isTextType(f.type) && (
            <div className="mb-grid">
              <label className="field">
                <span className="field-label">Min length</span>
                <input className="input" type="number" min={0} value={f.min_length ?? ""} disabled={disabled} onChange={(e) => onChange({ min_length: num(e.currentTarget.value) })} />
              </label>
              <label className="field">
                <span className="field-label">Max length</span>
                <input className="input" type="number" min={0} max={SCHEMA_LIMITS.textLength} value={f.max_length ?? ""} disabled={disabled} onChange={(e) => onChange({ max_length: num(e.currentTarget.value) })} />
              </label>
            </div>
          )}

          {isSelectType(f.type) && (
            <OptionsEditor
              options={f.options ?? []}
              single={f.type === "static_select"}
              initial={f.initial_value ?? ""}
              disabled={disabled}
              onChange={(options, initial_value) => onChange(initial_value === undefined ? { options } : { options, initial_value })}
            />
          )}

          {(isTextType(f.type) || f.type === "number_input" || f.type === "datepicker") && (
            <label className="field">
              <span className="field-label">
                Default <span className="optional">(optional)</span>
              </span>
              <input
                className="input"
                type={f.type === "datepicker" ? "date" : f.type === "number_input" ? "number" : "text"}
                value={f.initial_value ?? ""}
                disabled={disabled}
                onChange={(e) => onChange({ initial_value: e.currentTarget.value })}
              />
            </label>
          )}

          {problems.map((p, i) => (
            <span key={i} className="field-error">
              {p}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function OptionsEditor({
  options,
  single,
  initial,
  disabled,
  onChange,
}: {
  options: SchemaOption[];
  single: boolean;
  initial: string;
  disabled?: boolean;
  /** `initial` is passed only when the default changes. */
  onChange: (options: SchemaOption[], initial?: string) => void;
}) {
  const [bulk, setBulk] = useState<string | null>(null);
  const values = options.map((o) => o.value);
  const set = (i: number, patch: Partial<SchemaOption>) => {
    const next = options.map((o, j) => (j === i ? { ...o, ...patch } : o));
    const renamed = patch.value !== undefined && options[i]?.value === initial;
    onChange(next, renamed ? patch.value : undefined);
  };
  const setLabel = (i: number, label: string) => {
    const o = options[i];
    if (!o) return;
    const others = values.filter((_, j) => j !== i);
    const following = !o.value || o.value === slugify(o.label) || o.value === uniqueActionId(slugify(o.label), others);
    set(i, following ? { label, value: uniqueActionId(slugify(label), others) } : { label });
  };
  const addMany = (labels: string[]) => {
    const next = [...options];
    for (const label of labels) next.push({ label, value: uniqueActionId(slugify(label), next.map((o) => o.value)) });
    onChange(next.slice(0, SCHEMA_LIMITS.options));
  };

  return (
    <div className="field">
      <span className="field-label">Options</span>
      <div className="mb-options">
        {options.map((o, i) => (
          <div className="mb-option" key={i}>
            {single && (
              <input
                type="radio"
                name={`default-${values.join("|")}`}
                aria-label={`Make "${o.label}" the default`}
                title="Default"
                checked={!!initial && initial === o.value}
                disabled={disabled}
                onChange={() => onChange(options, o.value)}
                onClick={() => initial === o.value && onChange(options, "")}
              />
            )}
            <input className="input" aria-label={`Option ${i + 1} label`} value={o.label} disabled={disabled} onChange={(e) => setLabel(i, e.currentTarget.value)} />
            <input className="input mono" aria-label={`Option ${i + 1} value`} value={o.value} disabled={disabled} onChange={(e) => set(i, { value: e.currentTarget.value })} />
            {!disabled && (
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => onChange(options.filter((_, j) => j !== i), o.value === initial ? "" : undefined)}
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <div className="mb-option-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => addMany([`Option ${options.length + 1}`])}>
            <Icon name="plus" size={14} /> Add option
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBulk(bulk === null ? "" : null)}>
            Paste a list
          </button>
        </div>
      )}
      {bulk !== null && (
        <div className="field">
          <textarea
            className="textarea mb-bulk"
            rows={4}
            placeholder={"One option per line\nLow\nMedium\nHigh"}
            value={bulk}
            onChange={(e) => setBulk(e.currentTarget.value)}
          />
          <div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                addMany(bulk.split("\n").map((l) => l.trim()).filter(Boolean));
                setBulk(null);
              }}
            >
              Add these
            </button>
          </div>
        </div>
      )}
      <span className="field-hint">
        Left: what approvers see. Right: the value stored and sent to webhooks.{single ? " The circle marks the default." : ""}
      </span>
    </div>
  );
}

function TypeGlyph({ type }: { type: string }) {
  const glyph: Record<string, string> = {
    plain_text_input: "Aa",
    url_text_input: "🔗",
    email_text_input: "@",
    number_input: "#",
    static_select: "▾",
    multi_static_select: "☰",
    datepicker: "📅",
    file_input: "⇪",
  };
  return (
    <span className="mb-glyph" aria-hidden="true">
      {glyph[type] ?? "?"}
    </span>
  );
}

/** A close copy of the Slack modal the schema opens, built from plain elements. */
function SlackModalPreview({
  schema,
  active,
  onPick,
}: {
  schema: MetadataSchema;
  active: number | null;
  onPick: (i: number) => void;
}) {
  const title = schema.title || "Metadata";
  return (
    <div className="slack-modal" aria-label="Slack modal preview">
      <div className="slack-modal-head">
        <strong>{title.slice(0, SCHEMA_LIMITS.title)}</strong>
        <span aria-hidden="true">×</span>
      </div>
      <div className="slack-modal-body">
        <div className="slack-modal-header-block">{title}</div>
        <hr />
        {schema.fields.length === 0 && <p className="slack-modal-empty">Add a question to see it here.</p>}
        {schema.fields.map((f, i) => (
          <div
            key={i}
            className={"slack-input" + (active === i ? " active" : "")}
            role="button"
            tabIndex={0}
            onClick={() => onPick(i)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(i))}
          >
            <div className="slack-input-label">
              {f.label || "Untitled"}
              {f.optional !== false && <span> (optional)</span>}
            </div>
            <PreviewElement field={f} />
          </div>
        ))}
      </div>
      <div className="slack-modal-foot">
        <span className="slack-btn">Cancel</span>
        <span className="slack-btn primary">{schema.submit_label || DEFAULT_SUBMIT}</span>
      </div>
    </div>
  );
}

function PreviewElement({ field: f }: { field: SchemaField }) {
  const ph = f.placeholder || "";
  switch (f.type) {
    case "static_select":
    case "multi_static_select": {
      const picked = f.type === "static_select" ? f.options?.find((o) => o.value === f.initial_value)?.label : undefined;
      return (
        <div className="slack-el slack-select">
          <span className={picked ? "" : "ph"}>{picked || ph || (f.type === "static_select" ? "Select an item" : "Select options")}</span>
          <Icon name="chevronDown" size={14} />
        </div>
      );
    }
    case "datepicker":
      return (
        <div className="slack-el slack-select">
          <span className={f.initial_value ? "" : "ph"}>{f.initial_value || ph || "Select a date"}</span>
          <span aria-hidden="true">📅</span>
        </div>
      );
    case "file_input":
      return (
        <div className="slack-el slack-file">
          Drag and drop a file or <u>upload from your computer</u>
        </div>
      );
    default:
      return (
        <div className={"slack-el" + (f.multiline ? " multiline" : "")}>
          <span className={f.initial_value ? "" : "ph"}>{f.initial_value || ph}</span>
        </div>
      );
  }
}
