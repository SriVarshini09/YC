/**
 * What a GraphQL document asks for, enough to match advisories against it: each operation's type, and the dotted
 * path of every field it selects (`automaticDiscounts.nodes.id`). Arguments, variables, directives and aliases are
 * read past; inline fragments (`... on Type`) select into their parent; named fragments are expanded where spread.
 * Not a validating parser: a document it cannot follow gives undefined, and the matcher then treats the call as
 * one it cannot read.
 */
export interface GraphqlSelections {
  operations: ("query" | "mutation" | "subscription")[];
  /** Every selected field as a dotted path from the operation root, aliases resolved to field names. */
  paths: string[];
}

type Token = { kind: "name" | "punct" | "string"; value: string };

function tokenize(doc: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < doc.length) {
    const c = doc[i]!;
    if (c === "#") {
      while (i < doc.length && doc[i] !== "\n") i++;
    } else if (/\s|,/.test(c)) {
      i++;
    } else if (doc.startsWith('"""', i)) {
      const end = doc.indexOf('"""', i + 3);
      out.push({ kind: "string", value: "" });
      i = end < 0 ? doc.length : end + 3;
    } else if (c === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') i += doc[i] === "\\" ? 2 : 1;
      out.push({ kind: "string", value: "" });
      i++;
    } else if (doc.startsWith("...", i)) {
      out.push({ kind: "punct", value: "..." });
      i += 3;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < doc.length && /\w/.test(doc[j]!)) j++;
      out.push({ kind: "name", value: doc.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: "punct", value: c });
      i++;
    }
  }
  return out;
}

export function graphqlSelections(doc: string): GraphqlSelections | undefined {
  const tokens = tokenize(doc);
  let i = 0;
  const peek = (o = 0) => tokens[i + o];
  const skipBalanced = (open: string, close: string) => {
    let depth = 0;
    do {
      const t = tokens[i++];
      if (!t) throw new Error("unbalanced");
      if (t.value === open) depth++;
      else if (t.value === close) depth--;
    } while (depth > 0);
  };
  const skipDirectives = () => {
    while (peek()?.value === "@") {
      i += 2;
      if (peek()?.value === "(") skipBalanced("(", ")");
    }
  };
  /** A selection set at tokens[i] === "{": its fields as relative paths, and the fragments it spreads with their prefix. */
  const selectionSet = (prefix: string, out: string[], spreads: { name: string; prefix: string }[]) => {
    if (peek()?.value !== "{") throw new Error("expected {");
    i++;
    while (peek() && peek()!.value !== "}") {
      const t = peek()!;
      if (t.value === "...") {
        i++;
        if (peek()?.value === "on") {
          i += 2;
          skipDirectives();
          selectionSet(prefix, out, spreads);
        } else if (peek()?.value === "@" || peek()?.value === "{") {
          skipDirectives();
          selectionSet(prefix, out, spreads);
        } else {
          spreads.push({ name: tokens[i++]!.value, prefix });
          skipDirectives();
        }
        continue;
      }
      if (t.kind !== "name") throw new Error(`unexpected ${t.value}`);
      i++;
      let name = t.value;
      if (peek()?.value === ":") {
        i++;
        name = tokens[i++]!.value;
      }
      const path = prefix ? `${prefix}.${name}` : name;
      out.push(path);
      if (peek()?.value === "(") skipBalanced("(", ")");
      skipDirectives();
      if (peek()?.value === "{") selectionSet(path, out, spreads);
    }
    if (!peek()) throw new Error("unclosed selection set");
    i++;
  };

  try {
    const operations: GraphqlSelections["operations"] = [];
    const paths: string[] = [];
    const spreads: { name: string; prefix: string }[] = [];
    const fragments = new Map<string, { paths: string[]; spreads: { name: string; prefix: string }[] }>();
    while (peek()) {
      const t = peek()!;
      if (t.value === "{") {
        operations.push("query");
        selectionSet("", paths, spreads);
      } else if (t.value === "query" || t.value === "mutation" || t.value === "subscription") {
        operations.push(t.value);
        i++;
        if (peek()?.kind === "name") i++;
        if (peek()?.value === "(") skipBalanced("(", ")");
        skipDirectives();
        selectionSet("", paths, spreads);
      } else if (t.value === "fragment") {
        const name = tokens[i + 1]?.value ?? "";
        i += 4;
        skipDirectives();
        const own = { paths: [] as string[], spreads: [] as { name: string; prefix: string }[] };
        selectionSet("", own.paths, own.spreads);
        fragments.set(name, own);
      } else throw new Error(`unexpected ${t.value}`);
    }
    if (!operations.length) return undefined;
    // Expand named fragments where they are spread (a fragment spreading itself stops after one level).
    const expand = (list: { name: string; prefix: string }[], seen: Set<string>) => {
      for (const s of list) {
        const f = fragments.get(s.name);
        if (!f || seen.has(s.name)) continue;
        const join = (p: string) => (s.prefix ? `${s.prefix}.${p}` : p);
        paths.push(...f.paths.map(join));
        expand(
          f.spreads.map((x) => ({ name: x.name, prefix: x.prefix ? join(x.prefix) : s.prefix })),
          new Set([...seen, s.name]),
        );
      }
    };
    expand(spreads, new Set());
    return { operations: [...new Set(operations)], paths: [...new Set(paths)] };
  } catch {
    return undefined;
  }
}

/** The selected paths a trigger field names: the path itself, anything under it, or a path ending in it (`priceRule`). */
export function graphqlPathsFor(selections: GraphqlSelections, field: string): string[] {
  return selections.paths.filter((p) => p === field || p.startsWith(`${field}.`) || p.endsWith(`.${field}`));
}
