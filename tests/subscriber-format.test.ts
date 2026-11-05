import { describe, expect, test } from "bun:test";
import { buildFormatContext, renderSubscriberFormat, resolveForwardFormat } from "../src/app";
import { applyChannelPatch } from "../src/api/routers/channels";
import { formatSchema } from "../src/api/routers/subscriptions";

const input = {
  text: "Big news <https://example.com|here>",
  author: "Ada <3",
  channelId: "C1",
  channelName: "news",
  link: "https://slack.com/archives/C1/p1",
  permalink: "https://slack.com/archives/C1/p1",
  timestamp: "2026-11-03T12:00:00.000Z",
  metadata: { tags: ["a", "b"], agreement: ["yes"], title: "Hi", blank: "" },
  schema: {
    fields: [
      { action_id: "title", label: "Title" },
      { action_id: "agreement", label: "I agree" },
      { action_id: "tags", label: "Tags" },
    ],
  },
  props: { emoji: ":newspaper:" },
  staticSection: "*Weekly*",
};

describe("subscriber format context", () => {
  test("never exposes the agreement field or unset values", () => {
    const ctx = buildFormatContext(input) as any;
    expect(Object.keys(ctx.meta)).toEqual(["tags", "title"]);
    expect(ctx.fields.map((f: any) => f.id)).toEqual(["title", "tags"]);
    expect(renderSubscriberFormat("{{ meta.agreement }}{% for f in fields %}{{ f.id }}{% endfor %}", input)).toBe(
      "titletags",
    );
  });

  test("renders a full format", () => {
    const format =
      "{{ props.emoji }} *{{ meta.title }}* from {{ channel.mention }} by {{ author }}\n" +
      '{{ text }}\n{% for f in fields %}• {{ f.label }}: {{ f.value | join: " / " }}\n{% endfor %}{{ static }}';
    expect(renderSubscriberFormat(format, input)).toBe(
      ":newspaper: *Hi* from <#C1|news> by Ada &lt;3\nBig news <https://example.com|here>\n• Title: Hi\n• Tags: a / b\n*Weekly*",
    );
  });

  test("falls back to the default layout when a format renders nothing or hits a limit", () => {
    expect(renderSubscriberFormat("{% if meta.nope %}x{% endif %}  ", input)).toBeNull();
    expect(renderSubscriberFormat("{% for a in meta.tags %}{{ text | truncate: 100000 }}{% endfor %}{{ x", input)).toBeNull();
  });
});

describe("publisher forward format", () => {
  const pub = "*{{ meta.title }}*";
  const own = "{{ text }}";

  test("a subscriber's own format beats the publisher's default", () => {
    expect(resolveForwardFormat({ forwardFormat: pub }, { format: own })).toBe(own);
    expect(resolveForwardFormat({ forwardFormat: pub }, { format: null })).toBe(pub);
    expect(resolveForwardFormat({ forwardFormat: null }, { format: own })).toBe(own);
    expect(resolveForwardFormat({}, {})).toBeNull();
  });

  test("a locked publisher format beats the subscriber's", () => {
    expect(resolveForwardFormat({ forwardFormat: pub, forwardFormatLocked: true }, { format: own })).toBe(pub);
  });

  test("a lock without a publisher format does nothing", () => {
    expect(resolveForwardFormat({ forwardFormat: null, forwardFormatLocked: true }, { format: own })).toBe(own);
    expect(resolveForwardFormat({ forwardFormat: "", forwardFormatLocked: true }, {})).toBeNull();
  });

  test("a locked format that fails falls back to the default layout, not the subscriber's", () => {
    const chosen = resolveForwardFormat({ forwardFormat: "{% if meta.nope %}x{% endif %}", forwardFormatLocked: true }, { format: own });
    expect(renderSubscriberFormat(chosen!, input)).toBeNull();
  });

  test("saving: blank clears it, broken formats are rejected", () => {
    const ch = { forwardFormat: "x" } as any;
    expect(applyChannelPatch(ch, { forwardFormat: "   " }).forwardFormat).toBeNull();
    expect(applyChannelPatch(ch, { forwardFormat: null }).forwardFormat).toBeNull();
    expect(applyChannelPatch(ch, { forwardFormat: pub }).forwardFormat).toBe(pub);
    expect(applyChannelPatch(ch, {}).forwardFormat).toBe("x");
    expect(formatSchema.safeParse("{% if x %}").success).toBe(false);
    expect(formatSchema.safeParse("hi <!channel>").success).toBe(false);
    expect(formatSchema.safeParse(pub).success).toBe(true);
  });
});
