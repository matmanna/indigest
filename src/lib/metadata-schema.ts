/**
 * The metadata form a channel shows approvers, as stored in
 * `channels.metadata_schema`. Shared by the dashboard's visual builder and the
 * API, so both agree on what a valid form is. The limits mirror Slack's Block
 * Kit limits for modals: a schema that breaks one would fail when the modal
 * opens, long after it was saved.
 */

export type FieldType =
  | "plain_text_input"
  | "url_text_input"
  | "email_text_input"
  | "number_input"
  | "static_select"
  | "multi_static_select"
  | "datepicker"
  | "file_input";

export interface SchemaOption {
  label: string;
  value: string;
}

export interface SchemaField {
  action_id: string;
  label: string;
  type: FieldType | string;
  placeholder?: string;
  initial_value?: string;
  optional?: boolean;
  multiline?: boolean;
  min_length?: number;
  max_length?: number;
  options?: SchemaOption[];
  [extra: string]: unknown;
}

export interface MetadataSchema {
  title: string;
  submit_label?: string;
  fields: SchemaField[];
  [extra: string]: unknown;
}

export const FIELD_TYPES: { type: FieldType; label: string; hint: string }[] = [
  { type: "plain_text_input", label: "Text", hint: "A line of text, or a paragraph" },
  { type: "static_select", label: "Dropdown", hint: "Pick one option" },
  { type: "multi_static_select", label: "Multi-select", hint: "Pick any number of options" },
  { type: "url_text_input", label: "Link", hint: "A URL, checked by Slack" },
  { type: "email_text_input", label: "Email", hint: "An email address, checked by Slack" },
  { type: "number_input", label: "Number", hint: "A whole number" },
  { type: "datepicker", label: "Date", hint: "A date picker" },
  { type: "file_input", label: "File upload", hint: "Uploaded to the Hack Club CDN when configured" },
];

export const SCHEMA_LIMITS = {
  title: 24,
  submitLabel: 24,
  label: 2000,
  placeholder: 150,
  actionId: 255,
  fields: 50,
  options: 100,
  optionLabel: 75,
  optionValue: 150,
  textLength: 3000,
} as const;

const KNOWN_TYPES = new Set<string>(FIELD_TYPES.map((t) => t.type));
const ACTION_ID = /^[A-Za-z0-9_-]+$/;

export const isSelectType = (type: string) => type === "static_select" || type === "multi_static_select";
export const isTextType = (type: string) =>
  type === "plain_text_input" || type === "url_text_input" || type === "email_text_input";

/** "Due date!" → "due_date". Used to suggest an action_id from a label. */
export function slugify(label: string): string {
  return (
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "field"
  );
}

/** An action_id based on `base` that no other field uses. */
export function uniqueActionId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

export interface SchemaProblem {
  /** Index of the field the problem belongs to, or null for the form itself. */
  field: number | null;
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const tooLong = (v: unknown, max: number) => typeof v === "string" && v.length > max;
const isCount = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0);

/** Everything wrong with a schema, in order. Empty when it's valid. */
export function validateMetadataSchema(schema: unknown): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const form = (message: string) => problems.push({ field: null, message });
  if (!isObject(schema)) return [{ field: null, message: "The schema must be a JSON object" }];

  if (schema.title !== undefined && typeof schema.title !== "string") form("The form title must be text");
  if (tooLong(schema.title, SCHEMA_LIMITS.title))
    form(`Slack limits the form title to ${SCHEMA_LIMITS.title} characters`);
  if (schema.submit_label !== undefined && typeof schema.submit_label !== "string")
    form("The submit button label must be text");
  if (tooLong(schema.submit_label, SCHEMA_LIMITS.submitLabel))
    form(`Slack limits the submit button to ${SCHEMA_LIMITS.submitLabel} characters`);
  if (!Array.isArray(schema.fields)) {
    form("The schema needs a `fields` list");
    return problems;
  }
  if (schema.fields.length > SCHEMA_LIMITS.fields) form(`A form can have at most ${SCHEMA_LIMITS.fields} fields`);

  const seen = new Map<string, number>();
  schema.fields.forEach((raw, i) => {
    const add = (message: string) => problems.push({ field: i, message });
    if (!isObject(raw)) return add("Each field must be an object");
    const f = raw as SchemaField;

    if (typeof f.label !== "string" || !f.label.trim()) add("Give the field a label");
    else if (tooLong(f.label, SCHEMA_LIMITS.label)) add(`Labels are limited to ${SCHEMA_LIMITS.label} characters`);

    if (typeof f.action_id !== "string" || !f.action_id) add("Give the field an ID");
    else if (!ACTION_ID.test(f.action_id)) add("IDs can only use letters, numbers, - and _");
    else if (f.action_id.length > SCHEMA_LIMITS.actionId) add(`IDs are limited to ${SCHEMA_LIMITS.actionId} characters`);
    else if (seen.has(f.action_id)) add(`The ID "${f.action_id}" is already used by field ${seen.get(f.action_id)! + 1}`);
    else seen.set(f.action_id, i);

    if (typeof f.type !== "string" || !KNOWN_TYPES.has(f.type)) {
      add(`Unknown field type ${JSON.stringify(f.type)}`);
      return;
    }
    if (f.placeholder !== undefined && typeof f.placeholder !== "string") add("The placeholder must be text");
    if (tooLong(f.placeholder, SCHEMA_LIMITS.placeholder))
      add(`Placeholders are limited to ${SCHEMA_LIMITS.placeholder} characters`);
    if (f.optional !== undefined && typeof f.optional !== "boolean") add("`optional` must be true or false");

    if (isTextType(f.type) || f.type === "number_input") {
      if (!isCount(f.min_length) || !isCount(f.max_length)) add("Lengths must be whole numbers");
      else if (f.max_length !== undefined && f.max_length > SCHEMA_LIMITS.textLength)
        add(`Slack allows at most ${SCHEMA_LIMITS.textLength} characters`);
      else if (f.min_length !== undefined && f.max_length !== undefined && f.min_length > f.max_length)
        add("The minimum length is longer than the maximum");
    }

    if (isSelectType(f.type)) {
      const options = f.options;
      if (!Array.isArray(options) || options.length === 0) return add("Add at least one option");
      if (options.length > SCHEMA_LIMITS.options) add(`Slack allows at most ${SCHEMA_LIMITS.options} options`);
      const values = new Set<string>();
      options.forEach((o, j) => {
        const n = j + 1;
        if (!isObject(o) || typeof o.label !== "string" || typeof o.value !== "string")
          return add(`Option ${n} needs a label and a value`);
        if (!o.label.trim()) add(`Option ${n} needs a label`);
        else if (tooLong(o.label, SCHEMA_LIMITS.optionLabel))
          add(`Option ${n}'s label is over ${SCHEMA_LIMITS.optionLabel} characters`);
        if (!o.value) add(`Option ${n} needs a value`);
        else if (tooLong(o.value, SCHEMA_LIMITS.optionValue))
          add(`Option ${n}'s value is over ${SCHEMA_LIMITS.optionValue} characters`);
        else if (values.has(o.value)) add(`Two options share the value "${o.value}"`);
        else values.add(o.value);
      });
      if (f.type === "static_select" && f.initial_value && !values.has(f.initial_value))
        add("The default isn't one of the options");
    }

    if (f.type === "datepicker" && f.initial_value && !/^\d{4}-\d{2}-\d{2}$/.test(f.initial_value))
      add("The default date must look like 2026-01-31");
    if (f.type === "number_input" && f.initial_value && !/^-?\d+$/.test(f.initial_value))
      add("The default must be a whole number");
  });
  return problems;
}

/**
 * Drops settings that don't apply to a field's type and empty values, so
 * switching a field from Dropdown to Text doesn't leave stale options behind.
 * Keys the builder doesn't know about are kept as they are.
 */
export function cleanSchema(schema: MetadataSchema): MetadataSchema {
  const fields = schema.fields.map((f) => {
    const out: SchemaField = { ...f };
    if (!isSelectType(f.type)) delete out.options;
    if (!isTextType(f.type)) delete out.multiline;
    if (!isTextType(f.type) && f.type !== "number_input") {
      delete out.min_length;
      delete out.max_length;
    }
    if (f.type === "file_input") {
      delete out.placeholder;
      delete out.initial_value;
    }
    for (const key of ["placeholder", "initial_value"] as const) if (out[key] === "") delete out[key];
    for (const key of ["min_length", "max_length"] as const) if (out[key] === undefined) delete out[key];
    if (out.multiline === false) delete out.multiline;
    return out;
  });
  const out: MetadataSchema = { ...schema, fields };
  if (!out.submit_label) delete out.submit_label;
  return out;
}

/** Parses a stored schema for the builder. Returns null if it can't be edited visually. */
export function parseSchemaForBuilder(raw: string): MetadataSchema | null {
  if (!raw.trim()) return { title: "Metadata", fields: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || !Array.isArray(parsed.fields) || !parsed.fields.every(isObject)) return null;
    return { ...parsed, title: typeof parsed.title === "string" ? parsed.title : "Metadata" } as MetadataSchema;
  } catch {
    return null;
  }
}
