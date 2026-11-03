/**
 * A small, sandboxed template language for subscriber message formats,
 * flavoured after Liquid:
 *
 *   {{ meta.title | default: "Untitled" | upper }}
 *   {% if meta.priority == "high" %}:rotating_light: {% endif %}
 *   {% for tag in meta.tags %}{{ tag }}{% unless loop.last %}, {% endunless %}{% endfor %}
 *   {% assign n = fields | size %}{# comments #}
 *
 * Templates never run code. They're parsed into a tree and walked with hard
 * limits on size, nesting, loop iterations and output length. Lookups only
 * see a value's own data, never its prototype. Interpolated values are
 * escaped for Slack mrkdwn unless they're already trusted mrkdwn
 * (SafeString), so metadata can't smuggle in mentions, broadcasts or links.
 * The module has no dependencies so the dashboard can preview formats too.
 */

export const TEMPLATE_LIMITS = {
  source: 4000,
  nesting: 12,
  expressionDepth: 32,
  loopItems: 200,
  iterations: 1000,
  output: 12000,
};

export class TemplateError extends Error {
  constructor(message: string, readonly pos?: number) {
    super(message);
  }
}

/** Trusted Slack mrkdwn, output as is. Everything else gets escaped. */
export class SafeString {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const safe = (value: string) => new SafeString(value);

// The `empty` keyword: equal to any unset value, "" or [].
const EMPTY = Symbol("empty");

/** Escape text so Slack shows it literally (no mentions, links or dates). */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Syntax tree ---

type Expr =
  | { k: "lit"; v: unknown }
  | { k: "path"; parts: (string | number)[] }
  | { k: "filter"; input: Expr; name: string; args: Expr[] }
  | { k: "not"; e: Expr }
  | { k: "and" | "or"; a: Expr; b: Expr }
  | { k: "cmp"; op: string; a: Expr; b: Expr };

type Node =
  | { k: "text"; v: string }
  | { k: "out"; e: Expr }
  | { k: "if"; branches: { cond: Expr | null; body: Node[] }[] }
  | { k: "for"; name: string; iter: Expr; limit: Expr | null; body: Node[]; empty: Node[] }
  | { k: "assign"; name: string; e: Expr };

export interface Template {
  nodes: Node[];
}

// --- Tokenizing ---

type Raw =
  | { t: "text"; v: string }
  | { t: "out" | "tag"; v: string; pos: number };

function lex(src: string): Raw[] {
  const out: Raw[] = [];
  let i = 0;
  let trimNext = false;
  while (i < src.length) {
    const open = src.slice(i).search(/\{[{%#]/);
    const start = open < 0 ? src.length : i + open;
    let text = src.slice(i, start);
    if (trimNext) text = text.replace(/^\s+/, "");
    trimNext = false;
    if (start >= src.length) {
      if (text) out.push({ t: "text", v: text });
      break;
    }
    const kind = src[start + 1];
    const close = kind === "{" ? "}}" : kind === "%" ? "%}" : "#}";
    const end = src.indexOf(close, start + 2);
    if (end < 0) throw new TemplateError(`Unclosed "${src.slice(start, start + 2)}"`, start);
    let inner = src.slice(start + 2, end);
    if (inner.startsWith("-")) {
      text = text.replace(/\s+$/, "");
      inner = inner.slice(1);
    }
    if (inner.endsWith("-")) {
      trimNext = true;
      inner = inner.slice(0, -1);
    }
    if (text) out.push({ t: "text", v: text });
    if (kind !== "#") out.push({ t: kind === "{" ? "out" : "tag", v: inner.trim(), pos: start });
    i = end + 2;
  }
  return out;
}

type Tok = { t: "id" | "num" | "str" | "op"; v: string };

function lexExpr(src: string, pos: number): Tok[] {
  const toks: Tok[] = [];
  const re = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(==|!=|<=|>=|[<>()|:,.[\]=]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new TemplateError(`Unexpected "${src.slice(i).trim()[0]}"`, pos);
    i = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: "id", v: m[1] });
    else if (m[2] !== undefined) toks.push({ t: "num", v: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined)
      toks.push({ t: "str", v: (m[3] ?? m[4]!).replace(/\\(.)/g, "$1") });
    else toks.push({ t: "op", v: m[5]! });
  }
  return toks;
}

// --- Parsing expressions ---

const COMPARATORS = new Set(["==", "!=", "<", ">", "<=", ">=", "contains"]);

class ExprParser {
  private i = 0;
  private depth = 0;
  constructor(private toks: Tok[], private pos: number) {}

  fail(message: string): never {
    throw new TemplateError(message, this.pos);
  }
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isOp(v: string) {
    const t = this.peek();
    return !!t && (t.t === "op" || t.t === "id") && t.v === v;
  }
  take(v?: string): Tok {
    const t = this.toks[this.i];
    if (!t) this.fail(v ? `Expected "${v}"` : "Unexpected end of expression");
    if (v && t.v !== v) this.fail(`Expected "${v}" but found "${t.v}"`);
    this.i++;
    return t;
  }
  ident(): string {
    const t = this.take();
    if (t.t !== "id") this.fail(`Expected a name but found "${t.v}"`);
    return t.v;
  }
  done() {
    if (this.i < this.toks.length) this.fail(`Unexpected "${this.toks[this.i]!.v}"`);
  }

  expr(): Expr {
    if (++this.depth > TEMPLATE_LIMITS.expressionDepth) this.fail("Expression is nested too deeply");
    let a = this.and();
    while (this.isOp("or")) {
      this.take();
      a = { k: "or", a, b: this.and() };
    }
    this.depth--;
    return a;
  }
  and(): Expr {
    let a = this.not();
    while (this.isOp("and")) {
      this.take();
      a = { k: "and", a, b: this.not() };
    }
    return a;
  }
  not(): Expr {
    if (this.isOp("not")) {
      this.take();
      return { k: "not", e: this.not() };
    }
    const a = this.filtered();
    const t = this.peek();
    if (t && COMPARATORS.has(t.v) && (t.t === "op" || (t.t === "id" && t.v === "contains"))) {
      this.take();
      return { k: "cmp", op: t.v, a, b: this.filtered() };
    }
    return a;
  }
  filtered(): Expr {
    let e = this.primary();
    while (this.isOp("|")) {
      this.take();
      const name = this.ident();
      if (!Object.hasOwn(FILTERS, name)) this.fail(`Unknown filter "${name}"`);
      const args: Expr[] = [];
      if (this.isOp(":")) {
        this.take();
        args.push(this.primary());
        while (this.isOp(",")) {
          this.take();
          args.push(this.primary());
        }
      }
      e = { k: "filter", input: e, name, args };
    }
    return e;
  }
  primary(): Expr {
    const t = this.take();
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = this.expr();
      this.take(")");
      return e;
    }
    if (t.t !== "id") this.fail(`Unexpected "${t.v}"`);
    if (t.v === "true" || t.v === "false") return { k: "lit", v: t.v === "true" };
    if (t.v === "nil" || t.v === "null") return { k: "lit", v: null };
    if (t.v === "empty") return { k: "lit", v: EMPTY };
    const parts: (string | number)[] = [t.v];
    for (;;) {
      if (this.isOp(".")) {
        this.take();
        const next = this.take();
        if (next.t !== "id" && next.t !== "num") this.fail(`Unexpected "${next.v}" after "."`);
        parts.push(next.t === "num" ? Number(next.v) : next.v);
      } else if (this.isOp("[")) {
        this.take();
        const key = this.take();
        if (key.t !== "num" && key.t !== "str") this.fail("Use a number or quoted name inside [ ]");
        parts.push(key.t === "num" ? Number(key.v) : key.v);
        this.take("]");
      } else break;
    }
    return { k: "path", parts };
  }
}

function parseExpr(src: string, pos: number): Expr {
  if (!src) throw new TemplateError("Empty expression", pos);
  const p = new ExprParser(lexExpr(src, pos), pos);
  const e = p.expr();
  p.done();
  return e;
}

// --- Parsing blocks ---

// Broadcasts and group pings in a format would fire on every forward.
const FORBIDDEN_MENTION = /<!(?:channel|here|everyone|subteam\^)/i;

export function parseTemplate(src: string): Template {
  if (src.length > TEMPLATE_LIMITS.source)
    throw new TemplateError(`Formats are limited to ${TEMPLATE_LIMITS.source} characters`);
  const m = FORBIDDEN_MENTION.exec(src);
  if (m) throw new TemplateError("Formats can't include @channel, @here, @everyone or group mentions", m.index);

  type Frame = { tag: string; pos: number; node: Node | null; target: Node[]; inElse: boolean };
  const root: Node[] = [];
  const stack: Frame[] = [{ tag: "root", pos: 0, node: null, target: root, inElse: false }];
  const top = () => stack[stack.length - 1]!;

  for (const raw of lex(src)) {
    if (raw.t === "text") {
      top().target.push({ k: "text", v: raw.v });
      continue;
    }
    if (raw.t === "out") {
      top().target.push({ k: "out", e: parseExpr(raw.v, raw.pos) });
      continue;
    }
    const [, name = "", rest = ""] = raw.v.match(/^(\w+)\s*([\s\S]*)$/) ?? [];
    const frame = top();
    const fail = (message: string): never => {
      throw new TemplateError(message, raw.pos);
    };
    const open = (tag: string, node: Node, target: Node[]) => {
      if (stack.length > TEMPLATE_LIMITS.nesting) fail("Blocks are nested too deeply");
      frame.target.push(node);
      stack.push({ tag, pos: raw.pos, node, target, inElse: false });
    };
    switch (name) {
      case "if":
      case "unless": {
        const cond = parseExpr(rest, raw.pos);
        const body: Node[] = [];
        open(name, { k: "if", branches: [{ cond: name === "unless" ? { k: "not", e: cond } : cond, body }] }, body);
        break;
      }
      case "elif":
      case "elsif":
      case "else": {
        if (name === "else" && rest) fail('"else" takes no condition (use "elif")');
        if (frame.inElse) fail(`"${name}" after "else"`);
        if (frame.node?.k === "if") {
          const body: Node[] = [];
          frame.node.branches.push({ cond: name === "else" ? null : parseExpr(rest, raw.pos), body });
          frame.target = body;
        } else if (frame.node?.k === "for" && name === "else") {
          frame.target = frame.node.empty;
        } else fail(`"${name}" outside an if or for block`);
        frame.inElse = name === "else";
        break;
      }
      case "for": {
        const m = rest.match(/^([A-Za-z_]\w*)\s+in\s+([\s\S]+?)(?:\s+limit\s*:\s*([\s\S]+))?$/);
        if (!m) fail('Write loops as "for item in list"');
        const body: Node[] = [];
        open(
          "for",
          {
            k: "for",
            name: m![1]!,
            iter: parseExpr(m![2]!, raw.pos),
            limit: m![3] ? parseExpr(m![3], raw.pos) : null,
            body,
            empty: [],
          },
          body,
        );
        break;
      }
      case "assign": {
        const m = rest.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
        if (!m) fail('Write "assign name = value"');
        frame.target.push({ k: "assign", name: m![1]!, e: parseExpr(m![2]!, raw.pos) });
        break;
      }
      case "endif":
      case "endunless":
      case "endfor": {
        if (frame.tag !== name.slice(3)) fail(`"${name}" without a matching "${name.slice(3)}"`);
        if (rest) fail(`"${name}" takes nothing after it`);
        stack.pop();
        break;
      }
      default:
        fail(`Unknown tag "${name || raw.v}"`);
    }
  }
  if (stack.length > 1) {
    const open = top();
    throw new TemplateError(`"${open.tag}" is never closed`, open.pos);
  }
  return { nodes: root };
}

/** Null when the format is valid, else a message with its line and column. */
export function validateTemplate(src: string): string | null {
  try {
    parseTemplate(src);
    return null;
  } catch (err) {
    return describeTemplateError(src, err);
  }
}

export function describeTemplateError(src: string, err: unknown): string {
  if (!(err instanceof TemplateError)) return String((err as Error)?.message ?? err);
  if (err.pos === undefined) return err.message;
  const before = src.slice(0, err.pos).split("\n");
  return `${err.message} (line ${before.length}, column ${before[before.length - 1]!.length + 1})`;
}

// --- Values ---

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof SafeString) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Read one key from a value, seeing only its own data. */
function lookup(value: unknown, key: string | number): unknown {
  if (value instanceof SafeString) value = value.value;
  if (Array.isArray(value) || typeof value === "string") {
    if (key === "size") return value.length;
    if (key === "first") return value[0];
    if (key === "last") return value[value.length - 1];
    if (typeof key === "number") return value[key < 0 ? value.length + key : key];
    return undefined;
  }
  if (isPlainObject(value) && typeof key === "string" && !BLOCKED_KEYS.has(key))
    return Object.hasOwn(value, key) ? value[key] : undefined;
  return undefined;
}

function plain(v: unknown): unknown {
  return v instanceof SafeString ? v.value : v;
}

/** Unset, false, "" and [] are falsy. 0 counts as set. */
export function truthy(v: unknown): boolean {
  v = plain(v);
  return !(v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0));
}

function toNumber(v: unknown): number | null {
  v = plain(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

function toText(v: unknown): string {
  v = plain(v);
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (typeof v === "object") return "";
  return String(v);
}

function toList(v: unknown): unknown[] {
  v = plain(v);
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === "") return [];
  return [v];
}

/** Render a value as mrkdwn: trusted values as is, the rest escaped. */
function emit(v: unknown): string {
  if (v instanceof SafeString) return v.value;
  if (Array.isArray(v)) return v.map(emit).filter(Boolean).join(", ");
  return escapeMrkdwn(toText(v));
}

function compare(op: string, a: unknown, b: unknown): boolean {
  a = plain(a);
  b = plain(b);
  if (a === EMPTY || b === EMPTY) {
    const isEmpty = !truthy(a === EMPTY ? b : a);
    if (op === "==") return isEmpty;
    if (op === "!=") return !isEmpty;
    return false;
  }
  if (op === "contains") {
    if (Array.isArray(a)) return a.some((x) => toText(x) === toText(b));
    return typeof a === "string" && a.includes(toText(b));
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  const numeric = na !== null && nb !== null;
  if (op === "==" || op === "!=") {
    const eq = numeric
      ? na === nb
      : a == null || b == null
        ? a == null && b == null
        : typeof a !== "object" && typeof b !== "object"
          ? toText(a) === toText(b)
          : a === b;
    return op === "==" ? eq : !eq;
  }
  const [x, y] = numeric ? [na!, nb!] : [toText(a), toText(b)];
  if (op === "<") return x < y;
  if (op === ">") return x > y;
  if (op === "<=") return x <= y;
  return x >= y;
}

// --- Filters ---

const SLACK_DATE_FORMATS: Record<string, string> = {
  short: "{date_short}",
  long: "{date_long}",
  pretty: "{date_short_pretty}",
  time: "{time}",
  datetime: "{date_short} {time}",
};

function toDate(v: unknown): Date | null {
  v = plain(v);
  const n = toNumber(v);
  const d =
    n !== null
      ? new Date(n < 1e12 ? n * 1000 : n)
      : typeof v === "string" && v
        ? new Date(v)
        : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// Plain text for labels inside Slack's <url|label> syntax.
const linkLabel = (v: unknown) => escapeMrkdwn(toText(v).replace(/[|]/g, "/"));

const wrap = (mark: string) => (v: unknown) => {
  const text = emit(v).trim();
  return text ? safe(`${mark}${text}${mark}`) : "";
};

// String filters keep trusted mrkdwn (like the message text) trusted, since
// they only reshape what's already there.
const keep = (f: (s: string) => string) => (v: unknown) =>
  v instanceof SafeString ? safe(f(v.value)) : f(toText(v));

const FILTERS: Record<string, (v: unknown, ...args: unknown[]) => unknown> = {
  upper: keep((s) => s.toUpperCase()),
  lower: keep((s) => s.toLowerCase()),
  capitalize: keep((s) => s.charAt(0).toUpperCase() + s.slice(1)),
  strip: keep((s) => s.trim()),
  default: (v, fallback) => (truthy(v) ? v : fallback),
  size: (v) => {
    v = plain(v);
    return Array.isArray(v) || typeof v === "string" ? v.length : v == null ? 0 : 1;
  },
  first: (v) => toList(v)[0],
  last: (v) => toList(v).at(-1),
  join: (v, sep = ", ") => safe(toList(v).map(emit).filter(Boolean).join(escapeMrkdwn(toText(sep)))),
  split: (v, sep = ",") => toText(v).split(toText(sep)).slice(0, TEMPLATE_LIMITS.loopItems).map((s) => s.trim()),
  sort: (v) => [...toList(v)].sort((a, b) => toText(a).localeCompare(toText(b))),
  reverse: (v) => [...toList(v)].reverse(),
  uniq: (v) => [...new Map(toList(v).map((x) => [toText(x), x])).values()],
  truncate: (v, n = 50, ellipsis = "…") => {
    const max = Math.max(0, Math.min(toNumber(n) ?? 50, TEMPLATE_LIMITS.output));
    const end = v instanceof SafeString ? escapeMrkdwn(toText(ellipsis)) : toText(ellipsis);
    return keep((s) => (s.length > max ? s.slice(0, max).trimEnd() + end : s))(v);
  },
  replace: (v, from, to = "") => {
    const f = toText(from);
    if (!f) return v instanceof SafeString ? v : toText(v);
    // Into trusted text, the replacement goes in escaped.
    const t = v instanceof SafeString ? escapeMrkdwn(toText(to)) : toText(to);
    return keep((s) => s.split(f).join(t))(v);
  },
  plus: (v, n) => (toNumber(v) ?? 0) + (toNumber(n) ?? 0),
  minus: (v, n) => (toNumber(v) ?? 0) - (toNumber(n) ?? 0),
  times: (v, n) => (toNumber(v) ?? 0) * (toNumber(n) ?? 1),
  round: (v, places = 0) => {
    const p = Math.max(0, Math.min(toNumber(places) ?? 0, 10));
    return Number((toNumber(v) ?? 0).toFixed(p));
  },
  plural: (v, one, many) => {
    const n = Array.isArray(plain(v)) ? (plain(v) as unknown[]).length : toNumber(v);
    return n === 1 ? one : many;
  },
  // Slack renders <!date^…> in each reader's own timezone.
  date: (v, format = "short") => {
    const d = toDate(v);
    if (!d) return toText(v);
    const iso = d.toISOString().slice(0, 10);
    const f = toText(format);
    if (f === "iso") return iso;
    const token = SLACK_DATE_FORMATS[f] ?? SLACK_DATE_FORMATS.short!;
    return safe(`<!date^${Math.floor(d.getTime() / 1000)}^${token}|${iso}>`);
  },
  link: (v, label) => {
    const url = toText(v).trim();
    if (!/^https?:\/\/[^\s<>|]+$/i.test(url)) return escapeMrkdwn(url);
    return safe(label === undefined ? `<${url}>` : `<${url}|${linkLabel(label)}>`);
  },
  bold: wrap("*"),
  italic: wrap("_"),
  strike: wrap("~"),
  code: (v) => {
    const text = toText(v).replace(/`/g, "ˋ").trim();
    return text ? safe("`" + escapeMrkdwn(text) + "`") : "";
  },
  quote: (v) => {
    const text = emit(v);
    return text ? safe(text.split("\n").map((l) => `> ${l}`).join("\n")) : "";
  },
  bullets: (v, marker = "•") => {
    const items = toList(v).filter(truthy);
    return safe(items.map((x) => `${escapeMrkdwn(toText(marker))} ${emit(x)}`).join("\n"));
  },
};

export const TEMPLATE_FILTERS = Object.keys(FILTERS);

// --- Rendering ---

export function renderTemplate(tpl: Template, context: Record<string, unknown>): string {
  const vars = new Map<string, unknown>();
  let out = "";
  let iterations = 0;

  const resolve = (parts: (string | number)[]): unknown => {
    const [head, ...rest] = parts;
    let value: unknown = typeof head === "string" && vars.has(head) ? vars.get(head) : lookup(context, head!);
    for (const p of rest) value = lookup(value, p);
    return value;
  };

  const evaluate = (e: Expr): unknown => {
    switch (e.k) {
      case "lit":
        return e.v;
      case "path":
        return resolve(e.parts);
      case "not":
        return !truthy(evaluate(e.e));
      case "and":
        return truthy(evaluate(e.a)) && truthy(evaluate(e.b));
      case "or":
        return truthy(evaluate(e.a)) || truthy(evaluate(e.b));
      case "cmp":
        return compare(e.op, evaluate(e.a), evaluate(e.b));
      case "filter":
        return FILTERS[e.name]!(evaluate(e.input), ...e.args.map(evaluate));
    }
  };

  const write = (s: string) => {
    out += s;
    if (out.length > TEMPLATE_LIMITS.output)
      throw new TemplateError(`Output is longer than ${TEMPLATE_LIMITS.output} characters`);
  };

  const run = (nodes: Node[]) => {
    for (const node of nodes) {
      switch (node.k) {
        case "text":
          write(node.v);
          break;
        case "out":
          write(emit(evaluate(node.e)));
          break;
        case "assign":
          vars.set(node.name, evaluate(node.e));
          break;
        case "if": {
          const branch = node.branches.find((b) => b.cond === null || truthy(evaluate(b.cond)));
          if (branch) run(branch.body);
          break;
        }
        case "for": {
          const limit = node.limit ? toNumber(evaluate(node.limit)) : null;
          const items = toList(evaluate(node.iter)).slice(
            0,
            Math.max(0, Math.min(limit ?? TEMPLATE_LIMITS.loopItems, TEMPLATE_LIMITS.loopItems)),
          );
          if (items.length === 0) {
            run(node.empty);
            break;
          }
          const saved = [vars.get(node.name), vars.get("loop")] as const;
          const had = [vars.has(node.name), vars.has("loop")] as const;
          items.forEach((item, index) => {
            if (++iterations > TEMPLATE_LIMITS.iterations)
              throw new TemplateError(`Loops ran more than ${TEMPLATE_LIMITS.iterations} times`);
            vars.set(node.name, item);
            vars.set("loop", {
              index: index + 1,
              index0: index,
              first: index === 0,
              last: index === items.length - 1,
              length: items.length,
            });
            run(node.body);
          });
          // Loop variables don't leak past the loop.
          if (had[0]) vars.set(node.name, saved[0]);
          else vars.delete(node.name);
          if (had[1]) vars.set("loop", saved[1]);
          else vars.delete("loop");
          break;
        }
      }
    }
  };

  run(tpl.nodes);
  return out;
}
