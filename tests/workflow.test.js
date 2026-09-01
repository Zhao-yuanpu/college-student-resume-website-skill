import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("inspect_project rejects a repository without a commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portfolio-mcp-unborn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  const result = await createWorkflow().inspectProject({ projectPath: root });
  assert.equal(result.ok, false);
});

test("MCP stdio lists inspect_project and apply_patch", async () => {
  const published = process.env.MCP_SMOKE_PACKAGE;
  const command = published ? (process.platform === "win32" ? "npm.cmd" : "npm") : process.execPath;
  const args = published
    ? ["exec", "--yes", "--package", published, "--", "student-portfolio-website-mcp"]
    : ["src/index.js"];
  const client = new Client({ name: "smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command, args });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["inspect_project", "apply_patch"]);
  await client.close();
});

const readmePatch = [
  "diff --git a/README.md b/README.md",
  "index 1f8785b..9ec7e11 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-Open index.html directly.",
  "+Serve index.html locally."
].join("\n") + "\n";

test("apply_patch previews then executes once with WRITE approval", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.applyPatch({
    projectPath: root,
    snapshot: inspected.snapshot,
    patch: readmePatch,
    allowedPaths: ["README.md"],
    mode: "preview"
  });
  assert.equal(preview.ok, true);
  const executed = await workflow.applyPatch({
    projectPath: root,
    snapshot: inspected.snapshot,
    patch: readmePatch,
    allowedPaths: ["README.md"],
    mode: "execute",
    approvalToken: preview.approvalToken,
    confirm: "WRITE"
  });
  assert.equal(executed.ok, true);
  assert.notEqual(executed.snapshot.statusHash, inspected.snapshot.statusHash);
  assert.equal((await readFile(join(root, "README.md"), "utf8")).includes("Serve index.html locally."), true);
  const reused = await workflow.applyPatch({
    projectPath: root,
    snapshot: inspected.snapshot,
    patch: readmePatch,
    allowedPaths: ["README.md"],
    mode: "execute",
    approvalToken: preview.approvalToken,
    confirm: "WRITE"
  });
  assert.equal(reused.ok, false);
});

test("apply_patch requires exact WRITE confirmation", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  const result = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: preview.approvalToken, confirm: "write" });
  assert.equal(result.ok, false);
});

test("apply_patch requires allowedPaths to match exactly", async (t) => {
  const root = await fixtureRepo(t);
  const inspected = await createWorkflow().inspectProject({ projectPath: root });
  const result = await createWorkflow().applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md", "README.md"], mode: "preview" });
  assert.equal(result.ok, false);
});

test("apply_patch rejects traversal, git internals, secrets, and symlink escapes", async (t) => {
  const root = await fixtureRepo(t);
  const outside = await mkdtemp(join(tmpdir(), "portfolio-mcp-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "linked-outside"), "junction");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  for (const path of ["../outside.txt", ".git/config", ".env", "linked-outside/escape.txt"]) {
    const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+blocked\n`;
    const result = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch, allowedPaths: [path], mode: "preview" });
    assert.equal(result.ok, false, path);
  }
});

test("apply_patch rejects stale snapshots", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  await writeFile(join(root, "other.txt"), "changed\n");
  const result = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: preview.approvalToken, confirm: "WRITE" });
  assert.equal(result.ok, false);
});

test("apply_patch expires approvals and consumes failed execute attempts", async (t) => {
  const root = await fixtureRepo(t);
  let clock = 0;
  const workflow = createWorkflow({ now: () => clock, randomUUIDImpl: () => "approval" });
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  clock = 300_001;
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: preview.approvalToken, confirm: "WRITE" })).ok, false);
  clock = 0;
  const fresh = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: fresh.approvalToken, confirm: "write" })).ok, false);
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: fresh.approvalToken, confirm: "WRITE" })).ok, false);
});

test("apply_patch binds approvals to arguments and branches", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  const differentPatch = readmePatch.replace("Serve index.html locally.", "Open the site locally.");
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: differentPatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: preview.approvalToken, confirm: "WRITE" })).ok, false);
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: preview.approvalToken, confirm: "WRITE" })).ok, false);
  const branchPreview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  await execFileAsync("git", ["checkout", "-b", "other"], { cwd: root });
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: branchPreview.approvalToken, confirm: "WRITE" })).ok, false);
});

test("apply_patch rejects absolute paths and supports quoted rename paths", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const absolute = join(root, "outside.txt").replaceAll("\\", "/");
  const absolutePatch = `diff --git a/${absolute} b/${absolute}\n--- a/${absolute}\n+++ b/${absolute}\n@@ -0,0 +1 @@\n+blocked\n`;
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: absolutePatch, allowedPaths: [absolute], mode: "preview" })).ok, false);
  await execFileAsync("git", ["mv", "README.md", "README renamed.md"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["diff", "--cached", "-M"], { cwd: root });
  const renamePatch = stdout.replace("diff --git a/README.md b/README renamed.md", 'diff --git "a/README.md" "b/README renamed.md"');
  await execFileAsync("git", ["reset", "--hard"], { cwd: root });
  const renamePreview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: renamePatch, allowedPaths: ["README.md", "README renamed.md"], mode: "preview" });
  assert.equal(renamePreview.ok, true, renamePreview.summary);
});

test("apply_patch requires both copy paths in allowedPaths", async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "copy source.md"), "copy\n");
  await execFileAsync("git", ["add", "copy source.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "copy source"], { cwd: root });
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  await copyFile(join(root, "copy source.md"), join(root, "copy target.md"));
  await execFileAsync("git", ["add", "copy target.md"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["diff", "--cached", "-C", "--find-copies-harder"], { cwd: root });
  const copyPatch = stdout.replace("diff --git a/copy source.md b/copy target.md", 'diff --git "a/copy source.md" "b/copy target.md"');
  await execFileAsync("git", ["reset", "--hard"], { cwd: root });
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: copyPatch, allowedPaths: ["copy target.md"], mode: "preview" })).ok, false);
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: copyPatch, allowedPaths: ["copy source.md", "copy target.md"], mode: "preview" })).ok, true);
});
