import { describe, expect, test } from "bun:test";
import {
  TEMPLATE_LIMITS,
  parseTemplate,
  renderTemplate,
  safe,
  validateTemplate,
} from "../src/lib/template";

const render = (src: string, ctx: Record<string, unknown> = {}) =>
  renderTemplate(parseTemplate(src), ctx);

const ctx = {
  text: safe("Hello <https://example.com|world>"),
  author: "Ada",
  meta: { title: "Ship it", priority: "high", tags: ["news", "ysws"], count: "3" },
  fields: [
    { id: "title", label: "Title", value: "Ship it" },
    { id: "priority", label: "Priority", value: "high" },
  ],
};

describe("output", () => {
  test("interpolates paths", () => {
    expect(render("*{{ meta.title }}* by {{ author }}", ctx)).toBe("*Ship it* by Ada");
  });
  test("indexes arrays and reads size, first and last", () => {
    expect(render("{{ meta.tags[1] }} {{ meta.tags.0 }} {{ meta.tags.size }} {{ meta.tags.last }}", ctx)).toBe(
      "ysws news 2 ysws",
    );
  });
  test("unset values render as nothing", () => {
    expect(render("[{{ meta.nope }}{{ nope.deeper.still }}]", ctx)).toBe("[]");
  });
  test("arrays join with commas", () => {
    expect(render("{{ meta.tags }}", ctx)).toBe("news, ysws");
  });
  test("the message text stays mrkdwn", () => {
    expect(render("{{ text }}", ctx)).toBe("Hello <https://example.com|world>");
  });
});

describe("escaping", () => {
  test("metadata can't inject mentions or links", () => {
    expect(render("{{ x }}", { x: "<!channel> <@U123> <https://evil|ok> & co" })).toBe(
      "&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil|ok&gt; &amp; co",
    );
  });
  test("replacements into trusted text are escaped", () => {
    expect(render('{{ text | replace: "world", x }}', { ...ctx, x: "<!here>" })).toBe(
      "Hello <https://example.com|&lt;!here&gt;>",
    );
  });
  test("link only links http(s) URLs", () => {
    expect(render('{{ u | link: "Open" }}', { u: "https://a.example/x?y=1" })).toBe("<https://a.example/x?y=1|Open>");
    expect(render('{{ u | link: "Open" }}', { u: "javascript:alert(1)" })).toBe("javascript:alert(1)");
    expect(render('{{ u | link: l }}', { u: "https://a.example", l: "a|<b>" })).toBe("<https://a.example|a/&lt;b&gt;>");
  });
  test("formats can't broadcast", () => {
    expect(validateTemplate("hey <!channel>")).toMatch(/@channel/);
    expect(validateTemplate("hey <!subteam^S123>")).toMatch(/group/);
  });
});

describe("prototype access", () => {
  test("can't reach prototypes or constructors", () => {
    expect(render("{{ meta.constructor }}{{ meta.__proto__ }}{{ meta.toString }}{{ meta.tags.constructor.name }}", ctx)).toBe(
      "",
    );
    expect(render('{{ meta["__proto__"] }}{{ author.length }}', ctx)).toBe("");
  });
  test("class instances are opaque", () => {
    expect(render("{{ d.getTime }}{{ m.size }}", { d: new Date(), m: new Map([["a", 1]]) })).toBe("");
  });
});

describe("conditions", () => {
  test("if, elif and else", () => {
    const src = '{% if meta.priority == "low" %}low{% elif meta.priority == "high" %}HIGH{% else %}?{% endif %}';
    expect(render(src, ctx)).toBe("HIGH");
  });
  test("unless, not, and, or, parentheses", () => {
    expect(render("{% unless meta.nope %}yes{% endunless %}", ctx)).toBe("yes");
    expect(render('{% if not (meta.nope or author == "Bob") and meta.title %}ok{% endif %}', ctx)).toBe("ok");
  });
  test("contains on lists and strings", () => {
    expect(render('{% if meta.tags contains "ysws" %}a{% endif %}{% if author contains "d" %}b{% endif %}', ctx)).toBe(
      "ab",
    );
  });
  test("numbers compare numerically", () => {
    expect(render("{% if meta.count > 2 %}many{% endif %}{% if meta.count == 3 %}!{% endif %}", ctx)).toBe("many!");
  });
  test("empty matches unset, blank and empty lists", () => {
    expect(render("{% if meta.nope == empty %}a{% endif %}{% if x == empty %}b{% endif %}{% if meta.tags != empty %}c{% endif %}", { ...ctx, x: [] })).toBe(
      "abc",
    );
  });
  test("0 counts as set", () => {
    expect(render("{% if n %}set{% endif %}", { n: 0 })).toBe("set");
  });
});

describe("loops", () => {
  test("loop variables", () => {
    expect(render("{% for t in meta.tags %}{{ loop.index }}.{{ t }}{% unless loop.last %}, {% endunless %}{% endfor %}", ctx)).toBe(
      "1.news, 2.ysws",
    );
  });
  test("objects in loops", () => {
    expect(render("{% for f in fields %}*{{ f.label }}:* {{ f.value }}\n{% endfor %}", ctx)).toBe(
      "*Title:* Ship it\n*Priority:* high\n",
    );
  });
  test("else runs for empty lists, limit caps items", () => {
    expect(render("{% for t in meta.nope %}x{% else %}none{% endfor %}", ctx)).toBe("none");
    expect(render("{% for t in meta.tags limit: 1 %}{{ t }}{% endfor %}", ctx)).toBe("news");
  });
  test("loop variables don't leak", () => {
    expect(render("{% for t in meta.tags %}{% endfor %}[{{ t }}{{ loop.index }}]", ctx)).toBe("[]");
  });
  test("whitespace control trims around tags", () => {
    expect(render("a\n{%- if true -%}\n  b\n{%- endif -%}\n c", {})).toBe("abc");
  });
});

describe("filters", () => {
  test("text filters", () => {
    expect(render('{{ author | upper }} {{ "x" | default: "y" }} {{ nope | default: "fallback" }}', ctx)).toBe(
      "ADA x fallback",
    );
    expect(render('{{ "abcdef" | truncate: 3 }} {{ "a,b" | split: "," | join: " / " }}', ctx)).toBe("abc… a / b");
  });
  test("lists", () => {
    expect(render('{{ meta.tags | reverse | join: "+" }} {{ fields | size }} {{ meta.tags | bullets }}', ctx)).toBe(
      "ysws+news 2 • news\n• ysws",
    );
  });
  test("numbers and plurals", () => {
    expect(render('{{ meta.count | plus: 2 }} {{ meta.tags | size }} {{ meta.tags | plural: "tag", "tags" }}', ctx)).toBe(
      "5 2 tags",
    );
  });
  test("dates render in the reader's timezone", () => {
    expect(render('{{ d | date: "long" }} {{ d | date: "iso" }}', { d: "2026-11-03T12:00:00Z" })).toBe(
      "<!date^1793707200^{date_long}|2026-11-03> 2026-11-03",
    );
  });
  test("formatting wraps escaped text", () => {
    expect(render("{{ x | bold }} {{ x | code }} {{ x | quote }}", { x: "<b>" })).toBe(
      "*&lt;b&gt;* `&lt;b&gt;` > &lt;b&gt;",
    );
  });
  test("assign", () => {
    expect(render('{% assign t = meta.title | default: "Untitled" | upper %}{{ t }}', ctx)).toBe("SHIP IT");
  });
});

describe("errors and limits", () => {
  test("reports where a template is wrong", () => {
    expect(validateTemplate("ok\n{% if x %}")).toBe('"if" is never closed (line 2, column 1)');
    expect(validateTemplate("{{ x | nope }}")).toMatch(/Unknown filter "nope"/);
    expect(validateTemplate("{% endfor %}")).toMatch(/without a matching/);
    expect(validateTemplate("{% if a %}{% else %}{% elif b %}{% endif %}")).toMatch(/after "else"/);
    expect(validateTemplate("{% eval x %}")).toMatch(/Unknown tag/);
    expect(validateTemplate("{{ x ")).toMatch(/Unclosed/);
  });
  test("caps source size and nesting", () => {
    expect(validateTemplate("x".repeat(TEMPLATE_LIMITS.source + 1))).toMatch(/limited/);
    const deep = "{% if a %}".repeat(TEMPLATE_LIMITS.nesting + 1) + "{% endif %}".repeat(TEMPLATE_LIMITS.nesting + 1);
    expect(validateTemplate(deep)).toMatch(/nested too deeply/);
  });
  test("caps loop work and output size", () => {
    const many = Array.from({ length: 200 }, (_, i) => i);
    expect(() =>
      render("{% for a in xs %}{% for b in xs %}.{% endfor %}{% endfor %}", { xs: many }),
    ).toThrow(/Loops ran more than/);
    expect(() => render("{% for a in xs %}{{ big }}{% endfor %}", { xs: many, big: "x".repeat(1000) })).toThrow(
      /Output is longer/,
    );
  });
});
