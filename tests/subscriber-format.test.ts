import { describe, expect, test } from "bun:test";
import { buildFormatContext, renderSubscriberFormat } from "../src/app";

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
