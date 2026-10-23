import { defineConfig } from "vitepress";

// Published by GitHub Pages at https://srivarshini09.github.io/YC/ (see .github/workflows/docs.yml).
export default defineConfig({
  title: "SHAPI",
  description: "Find the code that breaks when a third-party API changes, and fix it test-first.",
  base: "/YC/",
  cleanUrls: true,
  lastUpdated: true,
  head: [["meta", { name: "theme-color", content: "#0f766e" }]],
  themeConfig: {
    nav: [
      { text: "Quickstart", link: "/guide/quickstart" },
      { text: "How it works", link: "/guide/how-it-works" },
      { text: "Advisories", link: "/advisories" },
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
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/SriVarshini09/YC" }],
    search: { provider: "local" },
    editLink: { pattern: "https://github.com/SriVarshini09/YC/edit/main/site/:path", text: "Edit this page on GitHub" },
    footer: {
      message: "shapi-cli is Apache-2.0. Advisories are CC BY 4.0.",
      copyright: "SHAPI",
    },
  },
});
