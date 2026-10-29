import { pathSegments, type FieldShape, type ResponseShape } from "@shapi/shapes";

interface Node {
  field?: FieldShape;
  children: Map<string, Node>;
  item?: Node;
}

/**
 * Build a synthetic JSON body with the structure a shape describes: every field
 * path present, values chosen from each field's types and value classes. No
 * real payload is involved (shapes never hold values). Returns null for empty bodies.
 */
export function synthesizeBody(shape: ResponseShape): unknown {
  if (shape.body.kind !== "json") return null;
  const root: Node = { children: new Map() };
  for (const field of shape.body.fields) {
    if (field.path === undefined) throw new Error("cannot synthesize from a redacted shape (field paths removed)");
    let node = root;
    for (const token of tokens(field.path)) {
      if (token === "[]") node = node.item ??= { children: new Map() };
      else {
        let child = node.children.get(token);
        if (!child) node.children.set(token, (child = { children: new Map() }));
        node = child;
      }
    }
    node.field = field;
  }
  return value(root, shape.body.rootType === "array" ? "array" : "object");
}

/** "a.b[].c" → ["a", "b", "[]", "c"]; a key holding "." or "[" is escaped in shape paths ("filter\[name]"). */
const tokens = pathSegments;

function value(node: Node, forced?: "array" | "object"): unknown {
  const types = node.field?.types.filter((t) => t !== "null") ?? [];
  const kind = forced ?? (node.item || types.includes("array") ? "array" : node.children.size > 0 || types.includes("object") ? "object" : types[0]);
  if (kind === "array") return node.item ? [value(node.item)] : [];
  if (kind === "object") return Object.fromEntries([...node.children].map(([k, child]) => [k, value(child)]));
  const classes = node.field?.classes ?? [];
  switch (kind) {
    case "integer":
      return classes.includes("negative") ? -1 : classes.includes("zero") && !classes.includes("positive") ? 0 : 1;
    case "number":
      return classes.includes("negative") ? -1.5 : 1.5;
    case "boolean":
      return !classes.includes("false") || classes.includes("true");
    case "string":
      return sampleString(classes);
    default:
      return null;
  }
}

function sampleString(classes: string[]): string {
  if (classes.includes("datetime")) return "2026-01-01T00:00:00Z";
  if (classes.includes("date")) return "2026-01-01";
  if (classes.includes("uuid")) return "00000000-0000-4000-8000-000000000000";
  if (classes.includes("url")) return "https://example.com/shapi";
  if (classes.includes("email")) return "shapi@example.com";
  if (classes.includes("id")) return "id_shapi00000001";
  if (classes.includes("token")) return "shapi_value";
  return "shapi text";
}

/**
 * A JSON body with every field path the code reads (from the call site's surface). Leaves are
 * strings unless `values` sets them, so a field that goes missing reads differently from one that
 * is present. `values` maps a field path to the value to put there (array paths use the first item).
 */
export function bodyFromPaths(paths: string[], values: Record<string, unknown> = {}): unknown {
  const all = [...new Set([...paths, ...Object.keys(values)])];
  const isLeaf = (p: string) => !all.some((o) => o !== p && (o.startsWith(`${p}.`) || o.startsWith(`${p}[]`)));
  const shape: ResponseShape = {
    status: 200,
    headers: {},
    headerNames: [],
    body: {
      kind: "json",
      rootType: all.some((p) => p.startsWith("[]")) ? "array" : "object",
      fields: all.map((path) => ({ path, pathHash: path, types: isLeaf(path) ? ["string"] : [], classes: [], occurrences: 1, nullRate: 0 })),
    },
  };
  const body = synthesizeBody(shape);
  for (const [path, value] of Object.entries(values)) setPath(body, tokens(path), value);
  return body;
}

function setPath(target: unknown, path: string[], value: unknown): void {
  let cur = target as Record<string, unknown> | unknown[];
  for (let i = 0; i < path.length; i++) {
    const t = path[i]!;
    const last = i === path.length - 1;
    if (t === "[]") {
      const arr = cur as unknown[];
      if (last) arr[0] = value;
      else cur = arr[0] as Record<string, unknown>;
    } else {
      const obj = cur as Record<string, unknown>;
      if (last) obj[t] = value;
      else cur = obj[t] as Record<string, unknown>;
    }
    if (cur === undefined || cur === null) return;
  }
}
