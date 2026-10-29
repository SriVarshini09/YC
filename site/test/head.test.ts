import { describe, expect, it } from "vitest";
import { pageHead, pageUrl } from "../.vitepress/head";

// Link previews (Slack, X, LinkedIn) read these tags; without them every page shared the home page's text.
describe("per-page head tags", () => {
  it("gives clean, canonical URLs", () => {
    expect(pageUrl("index.md")).toBe("https://shapi.dev/");
    expect(pageUrl("guide/cli.md")).toBe("https://shapi.dev/guide/cli");
    expect(pageUrl("legal/index.md")).toBe("https://shapi.dev/legal/");
  });

  it("carries the page's own title, description and URL", () => {
    const head = pageHead({ relativePath: "guide/cli.md" }, "CLI reference | SHAPI", "Every shapi-cli command.");
    expect(head).toContainEqual(["link", { rel: "canonical", href: "https://shapi.dev/guide/cli" }]);
    expect(head).toContainEqual(["meta", { property: "og:url", content: "https://shapi.dev/guide/cli" }]);
    expect(head).toContainEqual(["meta", { property: "og:title", content: "CLI reference | SHAPI" }]);
    expect(head).toContainEqual(["meta", { property: "og:description", content: "Every shapi-cli command." }]);
    expect(head).toContainEqual(["meta", { name: "twitter:title", content: "CLI reference | SHAPI" }]);
  });

  it("gives the 404 page no canonical URL", () => {
    const head = pageHead({ relativePath: "404.md", isNotFound: true }, "404 | SHAPI", "x");
    expect(head.some(([tag]) => tag === "link")).toBe(false);
    expect(head.some(([, attrs]) => "property" in attrs && attrs.property === "og:url")).toBe(false);
  });
});
