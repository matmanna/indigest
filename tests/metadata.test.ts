import { describe, expect, test } from "bun:test";
import { extractMetadataFromView } from "../src/api/modal";
import { isMetadataValueSet } from "../src/app";

describe("optional metadata fields", () => {
  const schema = {
    title: "Details",
    fields: [
      { action_id: "title", label: "Title", type: "plain_text_input" },
      { action_id: "tags", label: "Tags", type: "multi_static_select" },
      { action_id: "due", label: "Due", type: "datepicker" },
    ],
  };

  test("blank optional fields are omitted", () => {
    expect(extractMetadataFromView(schema, {
      field_title: { title: { value: "" } },
      field_tags: { tags: { selected_options: [] } },
      field_due: { due: { selected_date: "" } },
    })).toBe("{}");
  });

  test("provided values are retained", () => {
    expect(extractMetadataFromView(schema, {
      field_title: { title: { value: "Hello" } },
      field_tags: { tags: { selected_options: [{ value: "news" }] } },
      field_due: { due: { selected_date: "2026-08-13" } },
    })).toBe(JSON.stringify({ title: "Hello", tags: ["news"], due: "2026-08-13" }));
  });

  test("only set values are eligible for forwarded metadata", () => {
    expect(isMetadataValueSet(undefined)).toBe(false);
    expect(isMetadataValueSet(null)).toBe(false);
    expect(isMetadataValueSet("")).toBe(false);
    expect(isMetadataValueSet([])).toBe(false);
    expect(isMetadataValueSet(false)).toBe(true);
    expect(isMetadataValueSet(0)).toBe(true);
    expect(isMetadataValueSet(["news"])).toBe(true);
  });
});
