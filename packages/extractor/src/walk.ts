import { Node, type KindToNodeMappings, type SyntaxKind } from "ts-morph";

/**
 * A node's descendants of the given kinds, in document order (a node before the ones inside it).
 *
 * ts-morph's getDescendantsOfKind() and getDescendants() go through the compiler's getChildren(), which builds
 * and keeps a node for every token of the file. For a 2 MB repository that kept ~150 MB, and the scan ran a
 * 512 MB worker out of memory. forEachDescendant() walks forEachChild() instead, which has no token nodes.
 */
export function descendantsOfKind<K extends SyntaxKind>(node: Node, ...kinds: K[]): KindToNodeMappings[K][] {
  const out: KindToNodeMappings[K][] = [];
  node.forEachDescendant((d) => {
    if ((kinds as SyntaxKind[]).includes(d.getKind())) out.push(d as KindToNodeMappings[K]);
  });
  return out;
}
