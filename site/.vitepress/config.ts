import { defineConfig } from "vitepress";

// Published by GitHub Pages at https://srivarshini09.github.io/YC/ (see .github/workflows/docs.yml).
export default defineConfig({
  title: "SHAPI",
  description: "Find the code that breaks when a third-party API changes, and fix it test-first.",
  base: "/YC/",
  cleanUrls: true,
  // One light theme: paper and ink (theme/custom.css).
  appearance: false,
  lastUpdated: true,
  // VitePress does not add the base to head entries, so these carry it. The social image must be absolute.
  head: [
    ["link", { rel: "icon", href: "/YC/favicon.svg", type: "image/svg+xml" }],
    ["link", { rel: "icon", href: "/YC/favicon.ico", sizes: "32x32" }],
    ["link", { rel: "apple-touch-icon", href: "/YC/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#F7F6F2" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "SHAPI" }],
    ["meta", { property: "og:image", content: "https://srivarshini09.github.io/YC/og.png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: "https://srivarshini09.github.io/YC/og.png" }],
  ],
  themeConfig: {
    // The logo is drawn inline by the theme (theme/index.ts), so it can move; no image logo or text title.
    siteTitle: false,
    nav: [
      { text: "How it works", link: "/guide/how-it-works" },
      { text: "API changes", link: "/advisories" },
      { text: "Docs", link: "/guide/quickstart" },
      { text: "Security", link: "/security" },
    ],
    sidebar: [
      {
        text: "Get started",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "CLI reference", link: "/guide/cli" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "How SHAPI works", link: "/guide/how-it-works" },
          { text: "How fixes are verified", link: "/guide/fixes" },
          { text: "Advisories", link: "/advisories" },
        ],
      },
      {
        text: "Integrations",
        items: [
          { text: "GitHub App", link: "/guide/github-app" },
          { text: "Coding agents (MCP)", link: "/guide/agents" },
        ],
      },
      {
        text: "Trust",
        items: [
          { text: "Security and code handling", link: "/security" },
          { text: "FAQ", link: "/faq" },
        ],
      },
      {
        text: "Legal",
        items: [
          { text: "Privacy policy", link: "/legal/privacy" },
          { text: "Terms of service", link: "/legal/terms" },
          { text: "Data processing agreement", link: "/legal/dpa" },
          { text: "Subprocessors", link: "/legal/subprocessors" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/SriVarshini09/YC" }],
    search: { provider: "local" },
    editLink: { pattern: "https://github.com/SriVarshini09/YC/edit/main/site/:path", text: "Edit this page on GitHub" },
    footer: {
      // Raw HTML: VitePress doesn't add the base to these links.
      message:
        'shapi-cli is Apache-2.0. Advisories are CC BY 4.0. <a href="/YC/legal/privacy">Privacy</a> · <a href="/YC/legal/terms">Terms</a> · <a href="/YC/security">Security</a>',
      copyright: "SHAPI",
    },
  },
});
