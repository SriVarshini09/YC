import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import type { Edit, Recipe, RecipeContext } from "../recipe";

const STATUS_PROPS = new Set(["status", "statusCode"]);

/**
 * Status-code set change: wherever the code compares the response status to an
 * old code, make it accept the old and the new codes. For example
 * `res.status !== 204` becomes `![200, 204].includes(res.status)`.
 */
export const statusCodeAcceptSet: Recipe = {
  id: "status-code-accept-set",
  changeClass: "status-code",
  description: "Accept the new status codes alongside the old ones wherever the response status is compared",
  edits({ sourceFile, call, advisory }: RecipeContext): Edit[] {
    const oldCodes = advisory.trigger.statusCodes ?? [];
    const accept = [...new Set([...oldCodes, ...(advisory.trigger.newStatusCodes ?? [])])].sort((a, b) => a - b);
    if (oldCodes.length === 0 || accept.length === oldCodes.length) return [];
    const list = `[${accept.join(", ")}]`;
    const edits: Edit[] = [];
    const where = (n: Node) => `${sourceFile.getFilePath().slice(1)}:${n.getStartLineNumber()}`;

    for (const status of statusExpressions(call)) {
      let cur: Node = status;
      while (Node.isParenthesizedExpression(cur.getParent())) cur = cur.getParent()!;
      const parent = cur.getParent();

      if (Node.isBinaryExpression(parent)) {
        const op = parent.getOperatorToken().getKind();
        const other = parent.getLeft() === cur ? parent.getRight() : parent.getLeft();
        if (!Node.isNumericLiteral(other) || !oldCodes.includes(Number(other.getLiteralValue()))) continue;
        const negated = op === SyntaxKind.ExclamationEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken;
        const equal = op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.EqualsEqualsToken;
        if (!negated && !equal) continue;
        const text = `${negated ? "!" : ""}${list}.includes(${status.getText()})`;
        edits.push({ start: parent.getStart(), end: parent.getEnd(), text, note: `${where(parent)} \`${parent.getText()}\` → \`${text}\`` });
      } else if (Node.isSwitchStatement(parent) && parent.getExpression() === cur) {
        const cases = parent.getClauses().filter(Node.isCaseClause);
        const present = new Set(cases.map((c) => c.getExpression()).filter(Node.isNumericLiteral).map((l) => Number(l.getLiteralValue())));
        const anchor = cases.find((c) => {
          const e = c.getExpression();
          return Node.isNumericLiteral(e) && oldCodes.includes(Number(e.getLiteralValue()));
        });
        const missing = accept.filter((c) => !present.has(c));
        if (!anchor || missing.length === 0) continue;
        const indent = " ".repeat(sourceFile.getLineAndColumnAtPos(anchor.getStart()).column - 1);
        const text = missing.map((c) => `case ${c}:\n${indent}`).join("");
        edits.push({ start: anchor.getStart(), end: anchor.getStart(), text, note: `${where(anchor)} add ${missing.map((c) => `case ${c}`).join(", ")}` });
      } else if (Node.isCallExpression(parent) && parent.getArguments()[0] === cur) {
        const callee = parent.getExpression();
        const arr = Node.isPropertyAccessExpression(callee) && callee.getName() === "includes" ? callee.getExpression() : undefined;
        if (!arr || !Node.isArrayLiteralExpression(arr)) continue;
        const values = arr.getElements().filter(Node.isNumericLiteral).map((l) => Number(l.getLiteralValue()));
        if (!values.some((v) => oldCodes.includes(v))) continue;
        const merged = [...new Set([...values, ...accept])].sort((a, b) => a - b);
        if (merged.length === values.length) continue;
        const text = `[${merged.join(", ")}]`;
        edits.push({ start: arr.getStart(), end: arr.getEnd(), text, note: `${where(arr)} \`${arr.getText()}\` → \`${text}\`` });
      }
    }
    return edits;
  },
};

/** Expressions that evaluate to the call's response status, following it through the same file. */
function statusExpressions(call: Node): Node[] {
  const out: Node[] = [];
  let cur = call;
  for (;;) {
    const p = cur.getParent();
    if (p && (Node.isAwaitExpression(p) || Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isNonNullExpression(p))) cur = p;
    else break;
  }
  const parent = cur.getParent();
  const sf = call.getSourceFile();

  // (await fetch(url)).status
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur && STATUS_PROPS.has(parent.getName())) out.push(parent);

  // fetch(url).then((res) => res.status ...)
  if (Node.isPropertyAccessExpression(parent) && parent.getName() === "then") {
    const cb = Node.isCallExpression(parent.getParent()) ? (parent.getParent() as CallExpression).getArguments()[0] : undefined;
    const param = cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) ? cb.getParameters()[0] : undefined;
    if (param) out.push(...fromBinding(param.getNameNode(), param, sf));
  }

  // const res = await fetch(...); const { status } = await octokit...
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === cur) out.push(...fromBinding(parent.getNameNode(), parent, sf));
  return out;
}

function fromBinding(name: Node, decl: Node, sf: SourceFile): Node[] {
  const out: Node[] = [];
  if (Node.isIdentifier(name)) {
    for (const ref of references(name.getText(), decl, sf)) {
      const p = ref.getParent();
      if (Node.isPropertyAccessExpression(p) && p.getExpression() === ref && STATUS_PROPS.has(p.getName())) out.push(p);
    }
  } else if (Node.isObjectBindingPattern(name)) {
    for (const el of name.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
      if (STATUS_PROPS.has(prop) && Node.isIdentifier(el.getNameNode())) out.push(...references(el.getName(), decl, sf));
    }
  }
  return out;
}

/** Same-scope identifier references after the declaration (matches the extractor's intra-file dataflow). */
function references(name: string, decl: Node, sf: SourceFile): Node[] {
  const scope =
    decl.getFirstAncestor(
      (n) =>
        Node.isBlock(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n) ||
        Node.isMethodDeclaration(n) || Node.isCaseClause(n),
    ) ?? sf;
  return scope.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => {
    if (id.getText() !== name || id.getStart() < decl.getEnd()) return false;
    const p = id.getParent();
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return false;
    if (Node.isPropertyAssignment(p) && p.getNameNode() === id) return false;
    return !(Node.isBindingElement(p) || Node.isVariableDeclaration(p) || Node.isParameterDeclaration(p));
  });
}
