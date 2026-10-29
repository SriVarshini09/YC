import { defineConfig } from "vitepress";

// Published by GitHub Pages at https://shapi.dev (see .github/workflows/docs.yml).
export default defineConfig({
  title: "SHAPI",
  description: "Find the code that breaks when a third-party API changes, and fix it test-first.",
  cleanUrls: true,
  sitemap: { hostname: "https://shapi.dev" },
  // One light theme: Stone and Ink (theme/custom.css).
  appearance: false,
  lastUpdated: true,
  // The social image must be absolute.
  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "32x32" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#F1F1EE" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "SHAPI" }],
    ["meta", { property: "og:image", content: "https://shapi.dev/og.png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: "https://shapi.dev/og.png" }],
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
    // The public advisory database: SHAPI's source repository is private.
    socialLinks: [{ icon: "github", link: "https://github.com/SriVarshini09/shapi-advisories" }],
    search: { provider: "local" },
    footer: {
      message:
        'shapi-cli is Apache-2.0. Advisories are CC BY 4.0. <a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a> · <a href="/security">Security</a>',
      copyright: "© 2026 SHAPI",
    },
  },
});
