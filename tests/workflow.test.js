import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWorkflow } from "../src/workflow.js";

const execFileAsync = promisify(execFile);

async function fixtureRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "portfolio-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "MCP Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "mcp@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "Open index.html directly.\n");
  await writeFile(join(root, "direction-approved.md"), "隐私：遮挡证书编号。\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await execFileAsync("git", ["add", "README.md", "direction-approved.md", "package.json"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

test("inspect_project reports repository and evidence without personal text", async (t) => {
  const root = await fixtureRepo(t);
  const result = await createWorkflow().inspectProject({ projectPath: root });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.repoRoot, root.replaceAll("\\", "/"));
  assert.deepEqual(result.packageScripts, ["test"]);
  assert.ok(result.evidence.some((item) => item.path === "direction-approved.md"));
  assert.equal(JSON.stringify(result).includes("证书编号"), false);
});

test("MCP stdio lists inspect_project", async () => {
  const published = process.env.MCP_SMOKE_PACKAGE;
  const command = published ? (process.platform === "win32" ? "npm.cmd" : "npm") : process.execPath;
  const args = published
    ? ["exec", "--yes", "--package", published, "--", "student-portfolio-website-mcp"]
    : ["src/index.js"];
  const client = new Client({ name: "smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command, args });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["inspect_project"]);
  await client.close();
});
