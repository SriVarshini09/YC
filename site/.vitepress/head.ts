import type { HeadConfig } from "vitepress";

export const SITE = "https://shapi.dev";

/** A page's public URL, with VitePress clean URLs: guide/cli.md is /guide/cli, legal/index.md is /legal/. */
export const pageUrl = (relativePath: string) => `${SITE}/${relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;

/**
 * The per-page tags link previews and search engines read: the canonical URL, and the page's own title and
 * description for Open Graph and X. The site-wide image and card type are in config.ts.
 */
export function pageHead(page: { relativePath: string; isNotFound?: boolean }, title: string, description: string): HeadConfig[] {
  const head: HeadConfig[] = [
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { name: "twitter:title", content: title }],
    ["meta", { name: "twitter:description", content: description }],
  ];
  if (page.isNotFound) return head;
  const url = pageUrl(page.relativePath);
  return [["link", { rel: "canonical", href: url }], ["meta", { property: "og:url", content: url }], ...head];
}
