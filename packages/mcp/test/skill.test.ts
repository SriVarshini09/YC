import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "@shapi/mcp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skill = readFileSync(path.join(root, ".claude", "skills", "shapi", "SKILL.md"), "utf8");

describe("shapi agent skill", () => {
  it("has the frontmatter the skills installer and Claude Code require", () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(skill.replace(/\r\n/g, "\n"));
    expect(m).not.toBeNull();
    const fields = Object.fromEntries(m![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    expect(fields.name).toBe("shapi");
    expect(fields.name).toMatch(/^[a-z0-9-]+$/);
    expect(fields.description!.length).toBeGreaterThan(100);
    expect(fields.description!.length).toBeLessThanOrEqual(1024);
  });

  it("names exactly the tools the server exposes, and every apply_fix mode", async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer({ cwd: root }).connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const { tools } = await client.listTools();
    await client.close();
    for (const t of tools) expect(skill, t.name).toContain(`\`${t.name}\``);
    const modes = (tools.find((t) => t.name === "apply_fix")!.inputSchema.properties!.mode as { enum: string[] }).enum;
    for (const mode of modes) expect(skill, mode).toContain(mode);
  });
});

describe("editor MCP configs", () => {
  for (const file of [".mcp.json", ".cursor/mcp.json"]) {
    it(`${file} launches the shapi server from the repo`, () => {
      const config = JSON.parse(readFileSync(path.join(root, file), "utf8"));
      const server = config.mcpServers.shapi;
      expect(server.command).toBe("node");
      expect(existsSync(path.join(root, server.args[0]))).toBe(true);
    });
  }
});
