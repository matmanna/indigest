import { describe, expect, test } from "bun:test";
import {
  cleanSchema,
  parseSchemaForBuilder,
  slugify,
  uniqueActionId,
  validateMetadataSchema,
  type MetadataSchema,
} from "../src/lib/metadata-schema";
import { schemaToSave, serializeSchema } from "../src/web/metadata-builder";

const valid: MetadataSchema = {
  title: "Message Metadata",
  fields: [
    { action_id: "title", label: "Title", type: "plain_text_input", placeholder: "Enter a title" },
    { action_id: "description", label: "Description", type: "plain_text_input", multiline: true },
    {
      action_id: "priority",
      label: "Priority",
      type: "static_select",
      options: [
        { label: "Low", value: "low" },
        { label: "High", value: "high" },
      ],
      initial_value: "low",
    },
    { action_id: "due_date", label: "Due Date", type: "datepicker" },
  ],
};

const messages = (schema: unknown) => validateMetadataSchema(schema).map((p) => p.message);

describe("validateMetadataSchema", () => {
  test("accepts the README example", () => {
    expect(validateMetadataSchema(valid)).toEqual([]);
  });

  test("needs a fields list", () => {
    expect(messages({ title: "x" })).toEqual(["The schema needs a `fields` list"]);
    expect(messages([])).toEqual(["The schema must be a JSON object"]);
  });

  test("enforces Slack's title and submit limits", () => {
    expect(messages({ ...valid, title: "x".repeat(25) })).toEqual([
      "Slack limits the form title to 24 characters",
    ]);
    expect(messages({ ...valid, submit_label: "x".repeat(25) })).toEqual([
      "Slack limits the submit button to 24 characters",
    ]);
  });

  test("points at the field with the problem", () => {
    const problems = validateMetadataSchema({
      title: "T",
      fields: [
        { action_id: "a", label: "A", type: "plain_text_input" },
        { action_id: "a", label: "", type: "plain_text_input" },
        { action_id: "bad id", label: "C", type: "nope" },
      ],
    });
    expect(problems).toEqual([
      { field: 1, message: "Give the field a label" },
      { field: 1, message: 'The ID "a" is already used by field 1' },
      { field: 2, message: "IDs can only use letters, numbers, - and _" },
      { field: 2, message: 'Unknown field type "nope"' },
    ]);
  });

  test("checks dropdown options", () => {
    const select = (options: unknown, extra = {}) => ({
      title: "T",
      fields: [{ action_id: "s", label: "S", type: "static_select", options, ...extra }],
    });
    expect(messages(select([]))).toEqual(["Add at least one option"]);
    expect(
      messages(
        select([
          { label: "A", value: "a" },
          { label: "B", value: "a" },
        ]),
      ),
    ).toEqual(['Two options share the value "a"']);
    expect(messages(select([{ label: "A", value: "a" }], { initial_value: "z" }))).toEqual([
      "The default isn't one of the options",
    ]);
  });

  test("checks lengths and defaults", () => {
    const one = (f: object) => messages({ title: "T", fields: [{ action_id: "x", label: "X", ...f }] });
    expect(one({ type: "plain_text_input", min_length: 10, max_length: 5 })).toEqual([
      "The minimum length is longer than the maximum",
    ]);
    expect(one({ type: "plain_text_input", max_length: 1.5 })).toEqual(["Lengths must be whole numbers"]);
    expect(one({ type: "datepicker", initial_value: "next week" })).toEqual([
      "The default date must look like 2026-01-31",
    ]);
    expect(one({ type: "number_input", initial_value: "4.2" })).toEqual(["The default must be a whole number"]);
  });
});

describe("builder helpers", () => {
  test("slugify suggests IDs from labels", () => {
    expect(slugify("Due date!")).toBe("due_date");
    expect(slugify("Café rating")).toBe("cafe_rating");
    expect(slugify("!!!")).toBe("field");
  });

  test("uniqueActionId avoids taken IDs", () => {
    expect(uniqueActionId("title", [])).toBe("title");
    expect(uniqueActionId("title", ["title", "title_2"])).toBe("title_3");
  });

  test("cleanSchema drops settings that don't fit the type, keeps unknown keys", () => {
    const cleaned = cleanSchema({
      title: "T",
      submit_label: "",
      custom: 1,
      fields: [
        {
          action_id: "x",
          label: "X",
          type: "datepicker",
          options: [{ label: "a", value: "a" }],
          multiline: true,
          max_length: 5,
          placeholder: "",
          note: "kept",
        },
      ],
    });
    expect(cleaned).toEqual({
      title: "T",
      custom: 1,
      fields: [{ action_id: "x", label: "X", type: "datepicker", note: "kept" }],
    });
  });

  test("parseSchemaForBuilder handles empty, valid and broken input", () => {
    expect(parseSchemaForBuilder("")).toEqual({ title: "Metadata", fields: [] });
    expect(parseSchemaForBuilder(JSON.stringify(valid))).toEqual(valid);
    expect(parseSchemaForBuilder("{nope")).toBeNull();
    expect(parseSchemaForBuilder('{"fields": [1]}')).toBeNull();
  });

  test("a form with no fields is saved as no form", () => {
    expect(schemaToSave(serializeSchema({ title: "Anything", fields: [] }))).toBe("");
    expect(schemaToSave(serializeSchema(valid))).toBe(JSON.stringify(valid, null, 2));
  });
});
