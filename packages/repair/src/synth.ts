import type { FieldShape, ResponseShape } from "@shapi/shapes";

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

/** "a.b[].c" → ["a", "b", "[]", "c"]; "[].id" → ["[]", "id"]. */
function tokens(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[]*)((?:\[\])*)$/.exec(part)!;
    if (m[1]) out.push(m[1]);
    for (let i = 0; i < m[2]!.length / 2; i++) out.push("[]");
  }
  return out;
}

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
