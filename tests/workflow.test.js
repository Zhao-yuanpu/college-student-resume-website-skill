import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWorkflow, runCommand } from "../src/workflow.js";
import { toToolResult } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("CLI help lists the guarded workflow tools and confirmations", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/index.js", "--help"], { cwd: process.cwd() });
  for (const value of ["inspect_project", "apply_patch", "run_checks", "commit_changes", "push_changes", "verify_github_pages", "WRITE", "RUN", "COMMIT", "PUSH"]) {
    assert.match(stdout, new RegExp(`\\b${value}\\b`));
  }
});

test("CLI version reads package metadata", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["src/index.js", "--version"], { cwd: process.cwd() });
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(stdout, `${packageJson.version}\n`);
});

test("tool text content includes structured data for text-only MCP hosts", () => {
  const result = toToolResult({ ok: true, summary: "Preview ready", approvalToken: "token", snapshot: { head: "head" } });
  const text = result.content[0].text;
  assert.equal(text.startsWith("Preview ready\n"), true);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("\n") + 1)), result.structuredContent);
});

async function fixtureRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "portfolio-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "MCP Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "mcp@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "Open index.html directly.\n");
  await writeFile(join(root, "direction-approved.md"), "隐私：遮挡证书编号。\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
    test: "node --test",
    "test:fixture": "node -e \"require('node:fs').writeFileSync('checked.txt','ok')\"",
    "hang:fixture": "node -e \"setTimeout(() => {}, 5000)\"",
    "redact:fixture": "node -e \"console.log('TOKEN=secret-value');console.log('API_KEY=api-value');console.log('GITHUB_TOKEN:github-value');console.log('AWS_SECRET_ACCESS_KEY=aws-value');console.log('Authorization: Bearer bearer-value');console.log('_authToken=npm-value');console.log('SESSION_ID=session-value');console.log('COOKIE=session-cookie');console.log('REMOTE=https://user:pass@example.invalid/repo.git')\"",
    "fail:fixture": "node -e \"process.exit(1)\"",
    "marker:fixture": "node -e \"require('node:fs').writeFileSync('marker.txt','ran')\"",
    "spawn:fixture": "node -e \"const {spawn}=require('node:child_process');spawn(process.execPath,['-e', \\\"setTimeout(() => require('node:fs').writeFileSync('after-timeout.txt', 'ran'), 500)\\\"],{stdio:'ignore'});setTimeout(() => {}, 5000)\"",
    "-option": "node -e \"process.exit(0)\"",
    "evil&whoami": "node -e \"process.exit(0)\"",
    "evil%PATH%": "node -e \"process.exit(0)\"",
    "evil name": "node -e \"process.exit(0)\""
  } }));
  await execFileAsync("git", ["add", "README.md", "direction-approved.md", "package.json"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

test("inspect_project reports repository and evidence without personal text", async (t) => {
  const root = await fixtureRepo(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "src", "main.js"), "console.log('portfolio');\n");
  await writeFile(join(root, "dist", "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "README.md"), "Open index.html directly. Deploy with GitHub Pages.\n");
  await execFileAsync("git", ["add", "README.md", "src/main.js", "dist/index.html", "index.html"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "inspection fixture"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://student:github-token@github.com/student/example-portfolio.git"], { cwd: root });
  await execFileAsync("git", ["config", "branch.main.remote", "origin"], { cwd: root });
  const result = await createWorkflow().inspectProject({ projectPath: root });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.repoRoot, root.replaceAll("\\", "/"));
  assert.deepEqual(result.packageScripts, ["-option", "evil name", "evil%PATH%", "evil&whoami", "fail:fixture", "hang:fixture", "marker:fixture", "redact:fixture", "spawn:fixture", "test", "test:fixture"]);
  assert.ok(result.evidence.some((item) => item.path === "direction-approved.md"));
  assert.deepEqual(result.remote, { name: "origin", url: "https://github.com/student/example-portfolio.git" });
  assert.equal(result.worktreeStatus.clean, true);
  assert.match(result.worktreeStatus.summary, /clean/i);
  assert.deepEqual(result.sourceDirectories, ["src"]);
  assert.deepEqual(result.buildDirectories, ["dist"]);
  assert.ok(result.deploymentHints.includes("GitHub Pages"));
  assert.ok(result.deploymentHints.includes("static entry: index.html"));
  assert.ok(result.readmePromises.includes("direct index.html use"));
  assert.ok(result.readmePromises.includes("GitHub Pages delivery"));
  assert.equal(JSON.stringify(result).includes("证书编号"), false);
  assert.equal(JSON.stringify(result).includes("github-token"), false);
  assert.equal(JSON.stringify(result).includes("student:"), false);
});

test("inspect_project rejects a repository without a commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portfolio-mcp-unborn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  const result = await createWorkflow().inspectProject({ projectPath: root });
  assert.equal(result.ok, false);
});

test("MCP stdio lists all six tools and calls inspect_project with structured output", async (t) => {
  const root = await fixtureRepo(t);
  const published = process.env.MCP_SMOKE_PACKAGE;
  const command = published ? (process.platform === "win32" ? "npm.cmd" : "npm") : process.execPath;
  const args = published
    ? ["exec", "--yes", "--package", published, "--", "student-portfolio-website-mcp"]
    : ["src/index.js"];
  const client = new Client({ name: "smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command, args });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["inspect_project", "apply_patch", "run_checks", "commit_changes", "push_changes", "verify_github_pages"]);
    const inspected = await client.callTool({ name: "inspect_project", arguments: { projectPath: root } });
    assert.equal(inspected.isError, false);
    assert.equal(inspected.structuredContent.ok, true);
    assert.equal(inspected.structuredContent.phase, "inspect");
    assert.equal(inspected.structuredContent.snapshot.repoRoot, root.replaceAll("\\", "/"));
  } finally {
    await client.close();
  }
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

test("apply_patch rejects ordinary unified patch files outside the allowed paths", async (t) => {
  const root = await fixtureRepo(t);
  const inspected = await createWorkflow().inspectProject({ projectPath: root });
  const patch = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-Open index.html directly.",
    "+Updated README.",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1 +1 @@",
    "-{}",
    "+{\"changed\":true}"
  ].join("\n") + "\n";
  const result = await createWorkflow().applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch, allowedPaths: ["README.md"], mode: "preview" });
  assert.equal(result.ok, false);
});

test("apply_patch rejects traversal, git internals, credential files, private keys, and symlink escapes", async (t) => {
  const root = await fixtureRepo(t);
  const outside = await mkdtemp(join(tmpdir(), "portfolio-mcp-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "linked-outside"), "junction");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  for (const path of ["../outside.txt", ".git/config", ".env", ".npmrc", ".netrc", ".pypirc", "id_ed25519", ".ssh/id_ecdsa", "linked-outside/escape.txt"]) {
    const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+blocked\n`;
    const result = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch, allowedPaths: [path], mode: "preview" });
    assert.equal(result.ok, false, path);
    if ([".npmrc", ".netrc", ".pypirc", "id_ed25519", ".ssh/id_ecdsa"].includes(path)) assert.match(result.summary, /protected/, path);
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

test("content swaps at one unchanged status path stale every mutating approval", async (t) => {
  const root = await fixtureRepo(t);
  await bareRemote(t, root);
  await writeFile(join(root, "swap.txt"), "first\n");
  const workflow = createWorkflow();

  let inspected = await workflow.inspectProject({ projectPath: root });
  const patchPreview = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "preview" });
  await writeFile(join(root, "swap.txt"), "other\n");
  const swapped = await workflow.inspectProject({ projectPath: root });
  assert.notEqual(swapped.snapshot.statusHash, inspected.snapshot.statusHash);
  const stalePatch = await workflow.applyPatch({ projectPath: root, snapshot: inspected.snapshot, patch: readmePatch, allowedPaths: ["README.md"], mode: "execute", approvalToken: patchPreview.approvalToken, confirm: "WRITE" });
  assert.equal(stalePatch.ok, false);
  assert.match(stalePatch.summary, /Snapshot is stale/);

  await writeFile(join(root, "swap.txt"), "first\n");
  inspected = await workflow.inspectProject({ projectPath: root });
  const checksPreview = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["redact:fixture"], mode: "preview" });
  await writeFile(join(root, "swap.txt"), "other\n");
  const staleChecks = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["redact:fixture"], mode: "execute", approvalToken: checksPreview.approvalToken, confirm: "RUN" });
  assert.equal(staleChecks.ok, false);
  assert.match(staleChecks.summary, /Snapshot is stale/);

  await writeFile(join(root, "swap.txt"), "first\n");
  await writeFile(join(root, "README.md"), "Serve index.html locally.\n");
  inspected = await workflow.inspectProject({ projectPath: root });
  const commitPreview = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" });
  await writeFile(join(root, "swap.txt"), "other\n");
  const staleCommit = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "execute", approvalToken: commitPreview.approvalToken, confirm: "COMMIT" });
  assert.equal(staleCommit.ok, false);
  assert.match(staleCommit.summary, /Snapshot is stale/);

  await writeFile(join(root, "swap.txt"), "first\n");
  inspected = await workflow.inspectProject({ projectPath: root });
  const pushPreview = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "preview" });
  await writeFile(join(root, "swap.txt"), "other\n");
  const stalePush = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "execute", approvalToken: pushPreview.approvalToken, confirm: "PUSH" });
  assert.equal(stalePush.ok, false);
  assert.match(stalePush.summary, /Snapshot is stale/);
});

test("snapshot fingerprints are deterministic and detect tracked, staged, and untracked content swaps", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();

  await writeFile(join(root, "swap.txt"), "first\n");
  const untracked = await workflow.inspectProject({ projectPath: root });
  assert.equal((await workflow.inspectProject({ projectPath: root })).snapshot.statusHash, untracked.snapshot.statusHash);
  await writeFile(join(root, "swap.txt"), "other\n");
  assert.notEqual((await workflow.inspectProject({ projectPath: root })).snapshot.statusHash, untracked.snapshot.statusHash);
  await rm(join(root, "swap.txt"));

  await writeFile(join(root, "README.md"), "Tracked one\n");
  const tracked = await workflow.inspectProject({ projectPath: root });
  await writeFile(join(root, "README.md"), "Tracked two\n");
  assert.notEqual((await workflow.inspectProject({ projectPath: root })).snapshot.statusHash, tracked.snapshot.statusHash);

  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  const staged = await workflow.inspectProject({ projectPath: root });
  await writeFile(join(root, "README.md"), "Tracked one\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  assert.notEqual((await workflow.inspectProject({ projectPath: root })).snapshot.statusHash, staged.snapshot.statusHash);
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
  const reset = await workflow.inspectProject({ projectPath: root });
  const renamePreview = await workflow.applyPatch({ projectPath: root, snapshot: reset.snapshot, patch: renamePatch, allowedPaths: ["README.md", "README renamed.md"], mode: "preview" });
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

test("apply_patch decodes quoted UTF-8 paths without accepting mojibake", async (t) => {
  const root = await fixtureRepo(t);
  const filename = "测试.md";
  await writeFile(join(root, filename), "one\n");
  await execFileAsync("git", ["add", filename], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "unicode fixture"], { cwd: root });
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  await writeFile(join(root, filename), "two\n");
  const { stdout: unicodePatch } = await execFileAsync("git", ["diff"], { cwd: root });
  await execFileAsync("git", ["reset", "--hard"], { cwd: root });
  const reset = await workflow.inspectProject({ projectPath: root });
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: reset.snapshot, patch: unicodePatch, allowedPaths: [filename], mode: "preview" })).ok, true);
  assert.equal((await workflow.applyPatch({ projectPath: root, snapshot: reset.snapshot, patch: unicodePatch, allowedPaths: ["æµ‹è¯•.md"], mode: "preview" })).ok, false);
});

test("run_checks previews allowlisted scripts and executes once with RUN approval", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  assert.equal((await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["deploy"], mode: "preview" })).ok, false);
  const preview = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "preview" });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.evidence, [{ script: "test:fixture", command: "npm run test:fixture" }]);
  assert.equal((await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "execute", approvalToken: preview.approvalToken, confirm: "run" })).ok, false);
  const previewAgain = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "preview" });
  const executed = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "execute", approvalToken: previewAgain.approvalToken, confirm: "RUN" });
  assert.equal(executed.ok, true);
  assert.equal((await readFile(join(root, "checked.txt"), "utf8")), "ok");
  assert.notEqual(executed.snapshot.statusHash, inspected.snapshot.statusHash);
  assert.equal((await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "execute", approvalToken: previewAgain.approvalToken, confirm: "RUN" })).ok, false);
});

test("run_checks rejects option-like and shell-metacharacter script names before preview", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  for (const script of ["-option", "evil&whoami", "evil%PATH%", "evil name"]) {
    const result = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: [script], mode: "preview" });
    assert.equal(result.ok, false, script);
    assert.match(result.summary, /safe package script name/, script);
  }
});

test("run_checks does not execute a repository-local npm.cmd on Windows", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "npm.cmd"), "@echo off\r\n>shadow-ran.txt echo shadow\r\nexit /b 0\r\n");
  const calls = [];
  const workflow = createWorkflow({ run: async (command, args, options) => {
    calls.push([command, args]);
    return runCommand(command, args, options);
  } });
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "preview" });
  assert.equal(preview.ok, true, preview.summary);
  const executed = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "execute", approvalToken: preview.approvalToken, confirm: "RUN" });
  assert.equal(executed.ok, true, executed.summary);
  assert.equal(await readFile(join(root, "checked.txt"), "utf8"), "ok");
  await assert.rejects(readFile(join(root, "shadow-ran.txt"), "utf8"));
  const npmCall = calls.find(([, args]) => args[0] === "run");
  assert.equal(isAbsolute(npmCall[0]), true);
  assert.equal(relative(root, npmCall[0]).split(/[\\/]/)[0], "..");
});

test("run_checks rejects a package.json symlink that escapes the repository", async (t) => {
  const root = await fixtureRepo(t);
  const outside = await mkdtemp(join(tmpdir(), "portfolio-mcp-package-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsidePackage = join(outside, "package.json");
  await writeFile(outsidePackage, JSON.stringify({ scripts: { outside: "node -e \"process.exit(0)\"" } }));
  await unlink(join(root, "package.json"));
  try {
    await symlink(outsidePackage, join(root, "package.json"), "file");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("file symlinks require Windows Developer Mode");
      return;
    }
    throw error;
  }
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  assert.equal(inspected.ok, true, inspected.summary);
  const result = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["outside"], mode: "preview" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /escapes the repository/);
});

test("run_checks rejects duplicates, times out, stops on failure, and redacts output", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  assert.equal((await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: [], mode: "preview" })).ok, false);
  assert.equal((await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test", "test"], mode: "preview" })).ok, false);
  const redact = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["redact:fixture"], mode: "preview" });
  const redacted = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["redact:fixture"], mode: "execute", approvalToken: redact.approvalToken, confirm: "RUN" });
  assert.equal(redacted.ok, true, JSON.stringify(redacted));
  assert.match(redacted.evidence[0].stdout, /TOKEN=\[REDACTED\]/);
  for (const secret of ["secret-value", "api-value", "github-value", "aws-value", "bearer-value", "npm-value", "session-value", "session-cookie", "user:pass"]) assert.equal(JSON.stringify(redacted).includes(secret), false, secret);
  for (const name of ["API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "_authToken", "SESSION_ID", "COOKIE"]) assert.match(redacted.evidence[0].stdout, new RegExp(`${name}[:=]\\[REDACTED\\]`, "i"));
  assert.match(redacted.evidence[0].stdout, /Authorization: \[REDACTED\]/i);
  assert.match(redacted.evidence[0].stdout, /https:\/\/\[REDACTED\]@example\.invalid\/repo\.git/);
  const fresh = await workflow.inspectProject({ projectPath: root });
  const timeout = await workflow.runChecks({ projectPath: root, snapshot: fresh.snapshot, scripts: ["hang:fixture"], mode: "preview" });
  const timedOut = await workflow.runChecks({ projectPath: root, snapshot: fresh.snapshot, scripts: ["hang:fixture"], mode: "execute", approvalToken: timeout.approvalToken, confirm: "RUN", timeoutSeconds: 0.05 });
  assert.equal(timedOut.ok, false);
});

test("run_checks binds the capped timeout and stops after the first failed script", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "preview", timeoutSeconds: 1 });
  assert.equal((await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["test:fixture"], mode: "execute", approvalToken: preview.approvalToken, confirm: "RUN", timeoutSeconds: 2 })).ok, false);
  const failed = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["fail:fixture", "marker:fixture"], mode: "preview" });
  const result = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["fail:fixture", "marker:fixture"], mode: "execute", approvalToken: failed.approvalToken, confirm: "RUN" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.evidence.map((item) => item.script), ["fail:fixture"]);
  await assert.rejects(readFile(join(root, "marker.txt"), "utf8"));
});

test("run_checks timeout returns promptly and kills spawned work", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["spawn:fixture"], mode: "preview", timeoutSeconds: 0.05 });
  const started = Date.now();
  const result = await workflow.runChecks({ projectPath: root, snapshot: inspected.snapshot, scripts: ["spawn:fixture"], mode: "execute", approvalToken: preview.approvalToken, confirm: "RUN", timeoutSeconds: 0.05 });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 3_000);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(readFile(join(root, "after-timeout.txt"), "utf8"));
});

test("runCommand escalates to SIGKILL for a SIGTERM-ignoring descendant", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portfolio-mcp-sigkill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "sigterm-survived.txt");
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),600);setTimeout(()=>{},5000)`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});setTimeout(()=>{},5000)`;
  await assert.rejects(runCommand(process.execPath, ["-e", parent], { cwd: root, timeoutMs: 50 }), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 750));
  await assert.rejects(readFile(marker, "utf8"));
});

test("commit_changes previews and commits only explicit paths", async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "README.md"), "Serve index.html locally.\n");
  await writeFile(join(root, "notes-local.txt"), "keep local\n");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const before = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const preview = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.evidence, ["README.md"]);
  assert.equal((await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout, "");
  const executed = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "execute", approvalToken: preview.approvalToken, confirm: "COMMIT" });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.notEqual(executed.head, before);
  assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: root })).stdout, "?? notes-local.txt\n");
  assert.equal((await execFileAsync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: root })).stdout, "README.md\n");
  assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "execute", approvalToken: preview.approvalToken, confirm: "COMMIT" })).ok, false);
});

test("commit_changes rejects invalid scope and messages", async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "README.md"), "Serve index.html locally.\n");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  for (const input of [
    { paths: [], message: "docs: update readme" },
    { paths: ["README.md"], message: " " },
    { paths: ["README.md"], message: "docs: update\nreadme" },
    { paths: ["../outside.txt"], message: "docs: update readme" }
  ]) {
    assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, ...input, mode: "preview" })).ok, false);
  }
});

test("commit_changes rejects credential files and private-key basenames", async (t) => {
  const root = await fixtureRepo(t);
  await mkdir(join(root, ".ssh"));
  await mkdir(join(root, ".docker"));
  await mkdir(join(root, ".kube"));
  const paths = [".npmrc", ".netrc", ".pypirc", ".authinfo", "_netrc", ".htpasswd", ".yarnrc.yml", "id_ed25519", "id_rsa.pub", ".ssh/id_ecdsa", "client.p12", "client.pfx", ".docker/config.json", ".kube/config", "service-account.json"];
  for (const path of paths) await writeFile(join(root, path), "credential material\n");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  for (const path of paths) {
    const result = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: [path], message: "test: protected path", mode: "preview" });
    assert.equal(result.ok, false, path);
    assert.match(result.summary, /protected/, path);
  }
});

test("commit_changes binds approval to scope and requires exact COMMIT confirmation", async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "README.md"), "Serve index.html locally.\n");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" });
  assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: another message", mode: "execute", approvalToken: preview.approvalToken, confirm: "COMMIT" })).ok, false);
  const freshPreview = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" });
  assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "execute", approvalToken: freshPreview.approvalToken, confirm: "commit" })).ok, false);
});

test("commit_changes rejects empty or unsafe staged scope", async (t) => {
  const root = await fixtureRepo(t);
  const workflow = createWorkflow();
  let inspected = await workflow.inspectProject({ projectPath: root });
  assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" })).ok, false);
  await writeFile(join(root, "README.md"), "line with space \n");
  await writeFile(join(root, "direction-approved.md"), "changed\n");
  await execFileAsync("git", ["add", "direction-approved.md"], { cwd: root });
  inspected = await workflow.inspectProject({ projectPath: root });
  assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" })).ok, false);
  await execFileAsync("git", ["reset", "direction-approved.md"], { cwd: root });
  inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "preview" });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal((await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["README.md"], message: "docs: update readme", mode: "execute", approvalToken: preview.approvalToken, confirm: "COMMIT" })).ok, false);
});

test("commit_changes treats pathspec-looking paths literally", async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "README.md"), "Serve index.html locally.\n");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const result = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["*.md"], message: "docs: update readme", mode: "preview" });
  assert.equal(result.ok, false);
});

test("commit_changes rejects directory paths", async (t) => {
  const root = await fixtureRepo(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", ".env"), "SECRET=do-not-commit\n");
  const inspected = await createWorkflow().inspectProject({ projectPath: root });
  const result = await createWorkflow().commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["src"], message: "unsafe directory", mode: "preview" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /files, not directories/i);
});

test("commit_changes commits a selected untracked file without touching another", async (t) => {
  const root = await fixtureRepo(t);
  await writeFile(join(root, "new-profile.md"), "new profile\n");
  await writeFile(join(root, "notes-local.txt"), "keep local\n");
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["new-profile.md"], message: "docs: add profile", mode: "preview" });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const executed = await workflow.commitChanges({ projectPath: root, snapshot: inspected.snapshot, paths: ["new-profile.md"], message: "docs: add profile", mode: "execute", approvalToken: preview.approvalToken, confirm: "COMMIT" });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal((await execFileAsync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: root })).stdout, "new-profile.md\n");
  assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: root })).stdout, "?? notes-local.txt\n");
});

async function bareRemote(t, root) {
  const remote = await mkdtemp(join(tmpdir(), "portfolio-mcp-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: root });
  return remote;
}

test("push_changes previews then pushes HEAD to the configured bare remote once", async (t) => {
  const root = await fixtureRepo(t);
  const remoteRoot = await bareRemote(t, root);
  const calls = [];
  const workflow = createWorkflow({ run: async (command, args, options) => {
    calls.push([command, args]);
    return runCommand(command, args, options);
  } });
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "preview" });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.evidence, [{ remote: "origin", pushUrl: remoteRoot, refspec: "HEAD:refs/heads/main" }]);
  const executed = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "execute", approvalToken: preview.approvalToken, confirm: "PUSH" });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.evidence[0].refspec, "HEAD:refs/heads/main");
  assert.equal(executed.evidence[0].remoteHead, (await execFileAsync("git", ["--git-dir", remoteRoot, "rev-parse", "refs/heads/main"])).stdout.trim());
  const pushCall = calls.find(([command, args]) => command === "git" && args[2] === "push");
  assert.deepEqual(pushCall[1].slice(2), ["push", "--", remoteRoot, "HEAD:refs/heads/main"]);
  assert.equal((await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "execute", approvalToken: preview.approvalToken, confirm: "PUSH" })).ok, false);
});

test("push_changes rejects unsafe remote, branch, confirmation, and URL input", async (t) => {
  const root = await fixtureRepo(t);
  await bareRemote(t, root);
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  for (const input of [
    { remote: "missing", branch: "main" },
    { remote: "origin", branch: "other" },
    { remote: "origin", branch: "-main" },
    { remote: "origin", branch: "main:other" },
    { remote: "origin", branch: "main", remoteUrl: "https://example.invalid/replaced.git" }
  ]) {
    assert.equal((await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, ...input, mode: "preview" })).ok, false, JSON.stringify(input));
  }
  const preview = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "preview" });
  assert.equal((await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "execute", approvalToken: preview.approvalToken, confirm: "push" })).ok, false);
});

test("push_changes binds and reports the configured push URL", async (t) => {
  const root = await fixtureRepo(t);
  await bareRemote(t, root);
  const pushRemote = await mkdtemp(join(tmpdir(), "portfolio-mcp-push-remote-"));
  const replacementPushRemote = await mkdtemp(join(tmpdir(), "portfolio-mcp-replacement-push-remote-"));
  t.after(() => rm(pushRemote, { recursive: true, force: true }));
  t.after(() => rm(replacementPushRemote, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--bare", pushRemote]);
  await execFileAsync("git", ["init", "--bare", replacementPushRemote]);
  await execFileAsync("git", ["remote", "set-url", "--push", "origin", pushRemote], { cwd: root });
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "preview" });
  assert.equal(preview.evidence[0].pushUrl, pushRemote);
  await execFileAsync("git", ["remote", "set-url", "--push", "origin", replacementPushRemote], { cwd: root });
  assert.equal((await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "execute", approvalToken: preview.approvalToken, confirm: "PUSH" })).ok, false);
  const fresh = await workflow.inspectProject({ projectPath: root });
  const replacementPreview = await workflow.pushChanges({ projectPath: root, snapshot: fresh.snapshot, remote: "origin", branch: "main", mode: "preview" });
  const executed = await workflow.pushChanges({ projectPath: root, snapshot: fresh.snapshot, remote: "origin", branch: "main", mode: "execute", approvalToken: replacementPreview.approvalToken, confirm: "PUSH" });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.evidence[0].pushUrl, replacementPushRemote);
});

test("push_changes rejects a remote configured with multiple push destinations", async (t) => {
  const root = await fixtureRepo(t);
  const first = await bareRemote(t, root);
  const second = await mkdtemp(join(tmpdir(), "portfolio-mcp-second-push-"));
  t.after(() => rm(second, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--bare", second]);
  await execFileAsync("git", ["remote", "set-url", "--push", "origin", first], { cwd: root });
  await execFileAsync("git", ["remote", "set-url", "--add", "--push", "origin", second], { cwd: root });
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const result = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "origin", branch: "main", mode: "preview" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /exactly one push URL/);
});

test("push_changes redacts credentials from approved URL evidence", async (t) => {
  const root = await fixtureRepo(t);
  await execFileAsync("git", ["remote", "add", "secure", "https://alice:supersecret@example.invalid/portfolio.git"], { cwd: root });
  const workflow = createWorkflow();
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "secure", branch: "main", mode: "preview" });
  assert.equal(preview.ok, true, preview.summary);
  assert.equal(preview.evidence[0].pushUrl, "https://[REDACTED]@example.invalid/portfolio.git");
  assert.equal(JSON.stringify(preview).includes("alice"), false);
  assert.equal(JSON.stringify(preview).includes("supersecret"), false);
});

test("push_changes redacts credentials from Git failure output", async (t) => {
  const root = await fixtureRepo(t);
  await execFileAsync("git", ["remote", "add", "secure", "https://alice:supersecret@example.invalid/portfolio.git"], { cwd: root });
  const workflow = createWorkflow({ run: async (command, args, options) => {
    if (command === "git" && args[2] === "push") return { code: 1, stdout: "", stderr: "fatal: https://alice:supersecret@example.invalid/portfolio.git rejected\n" };
    return runCommand(command, args, options);
  } });
  const inspected = await workflow.inspectProject({ projectPath: root });
  const preview = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "secure", branch: "main", mode: "preview" });
  const result = await workflow.pushChanges({ projectPath: root, snapshot: inspected.snapshot, remote: "secure", branch: "main", mode: "execute", approvalToken: preview.approvalToken, confirm: "PUSH" });
  assert.equal(result.ok, false);
  assert.equal(result.summary.includes("alice"), false);
  assert.equal(result.summary.includes("supersecret"), false);
});

async function githubRemote(t, root) {
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:student/example-portfolio.git"], { cwd: root });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

function pagesRun(head, statuses = ["built"], buildCommit = head) {
  let statusIndex = 0;
  return async (command, args, options) => {
    if (command === "git" && args.includes("ls-remote")) return { code: 0, stdout: `${head}\trefs/heads/main\n`, stderr: "" };
    if (command === "gh") return { code: 0, stdout: JSON.stringify({ status: statuses[Math.min(statusIndex++, statuses.length - 1)], commit: buildCommit }) + "\n", stderr: "" };
    return runCommand(command, args, options);
  };
}

function staticPagesRun(head, status = "built", remoteUrl = "git@github.com:student/example-portfolio.git", ghCalls = [], buildCommit = head) {
  return async (command, args) => {
    if (command === "gh") {
      ghCalls.push(args);
      return { code: 0, stdout: JSON.stringify({ status, commit: buildCommit }) + "\n", stderr: "" };
    }
    const operation = args[2];
    if (operation === "rev-parse") return { code: 0, stdout: args[3] === "--show-toplevel" ? "C:/portfolio\n" : `${head}\n`, stderr: "" };
    if (operation === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (operation === "status") return { code: 0, stdout: "", stderr: "" };
    if (operation === "ls-files") return { code: 0, stdout: "", stderr: "" };
    if (operation === "config") return { code: 0, stdout: "origin\n", stderr: "" };
    if (operation === "remote") return { code: 0, stdout: `${remoteUrl}\n`, stderr: "" };
    if (operation === "ls-remote") return { code: 0, stdout: `${head}\trefs/heads/main\n`, stderr: "" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("verify_github_pages fully verifies a synchronized GitHub Pages site and expected text", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "Expected portfolio title" });
  const result = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl: publicLookup }).verifyGithubPages({
    projectPath: root,
    publicUrl: "https://example.invalid/portfolio/",
    expectedText: "Expected portfolio title",
    timeoutSeconds: 1
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.verification, "full");
});

test("verify_github_pages reports partial when gh is unavailable but HTTP succeeds", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const unavailableGh = async (command, args, options) => {
    if (command === "git" && args.includes("ls-remote")) return { code: 0, stdout: `${head}\trefs/heads/main\n`, stderr: "" };
    if (command === "gh") throw new Error("gh unavailable");
    return runCommand(command, args, options);
  };
  const result = await createWorkflow({ run: unavailableGh, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "live" }), lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "https://example.invalid/" });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.verification, "partial");
});

test("verify_github_pages fails when the remote branch is not at local HEAD", async (t) => {
  const root = await fixtureRepo(t);
  await githubRemote(t, root);
  const result = await createWorkflow({ run: pagesRun("0".repeat(40)), fetchImpl: async () => ({ ok: true, status: 200, text: async () => "live" }), lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "https://example.invalid/" });
  assert.equal(result.ok, false);
  assert.equal(result.verification, "failed");
});

test("verify_github_pages fails for unsuccessful HTTP or missing expected text", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const workflow = createWorkflow({ run: pagesRun(head), fetchImpl: async () => ({ ok: false, status: 503, text: async () => "offline" }), lookupImpl: publicLookup });
  const unavailable = await workflow.verifyGithubPages({ projectPath: root, publicUrl: "https://example.invalid/" });
  assert.equal(unavailable.verification, "failed");
  const missingText = await createWorkflow({ run: pagesRun(head), fetchImpl: async () => ({ ok: true, status: 200, text: async () => "other page" }), lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "https://example.invalid/", expectedText: "Expected title" });
  assert.equal(missingText.verification, "failed");
});

test("verify_github_pages aborts a non-settling public URL fetch at the timeout", async () => {
  const head = "1".repeat(40);
  let aborted = false;
  const fetchImpl = (_, { signal }) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; }));
  const result = await createWorkflow({ run: staticPagesRun(head), fetchImpl, lookupImpl: publicLookup }).verifyGithubPages({ projectPath: "C:/portfolio", publicUrl: "https://example.invalid/", timeoutSeconds: 0.02 });
  assert.equal(result.verification, "timeout");
  assert.equal(aborted, true);
});

test("verify_github_pages uses the exact Pages API path for HTTPS and SSH remotes", async () => {
  const head = "1".repeat(40);
  for (const [remoteUrl, owner, repository] of [
    ["https://github.com/https-owner/https-repo.git", "https-owner", "https-repo"],
    ["ssh://git@github.com:22/ssh-owner/ssh-repo.git", "ssh-owner", "ssh-repo"]
  ]) {
    const ghCalls = [];
    const result = await createWorkflow({ run: staticPagesRun(head, "built", remoteUrl, ghCalls) }).verifyGithubPages({ projectPath: "C:/portfolio" });
    assert.equal(result.verification, "partial");
    assert.deepEqual(ghCalls, [["api", `repos/${owner}/${repository}/pages/builds/latest`, "--jq", "{status: .status, commit: .commit} | @json"]]);
  }
});

test("verify_github_pages does not accept a built Pages deployment for an older commit", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const oldCommit = "b".repeat(40);
  const result = await createWorkflow({ run: pagesRun(head, ["built"], oldCommit), fetchImpl: async () => ({ ok: true, status: 200, text: async () => "old page" }), lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "https://example.invalid/", timeoutSeconds: 0.02 });
  assert.equal(result.verification, "timeout");
});

test("verify_github_pages gives every snapshot command the remaining total deadline", async () => {
  const head = "1".repeat(40);
  const timeouts = [];
  const delayedRun = async (command, args, options = {}) => {
    timeouts.push(options.timeoutMs ?? null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const operation = args[2];
    if (command === "git" && operation === "rev-parse") return { code: 0, stdout: args[3] === "--show-toplevel" ? "C:/portfolio\n" : `${head}\n`, stderr: "" };
    if (command === "git" && operation === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (command === "git" && operation === "status") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const result = await createWorkflow({ run: delayedRun }).verifyGithubPages({ projectPath: "C:/portfolio", timeoutSeconds: 0.02 });
  assert.equal(result.verification, "timeout");
  assert.ok(timeouts.length < 2, `snapshot kept running after the deadline: ${timeouts.length}`);
  assert.ok(timeouts[0] > 0 && timeouts[0] <= 20, `missing remaining deadline: ${timeouts[0]}`);
});

test("verify_github_pages times out while Pages remains building", async () => {
  const head = "1".repeat(40);
  const result = await createWorkflow({ run: staticPagesRun(head, "building"), fetchImpl: async () => ({ ok: true, status: 200, text: async () => "live" }) }).verifyGithubPages({ projectPath: "C:/portfolio", publicUrl: "https://example.invalid/", timeoutSeconds: 0.02 });
  assert.equal(result.ok, false);
  assert.equal(result.verification, "timeout");
});

test("verify_github_pages rejects loopback and private DNS targets before fetch", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, text: async () => "live" };
  };
  const loopback = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "http://127.0.0.1/" });
  assert.equal(loopback.verification, "failed");
  assert.match(loopback.summary, /public address/);
  const privateDns = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl: async () => [{ address: "10.0.0.4", family: 4 }] }).verifyGithubPages({ projectPath: root, publicUrl: "https://internal.example/" });
  assert.equal(privateDns.verification, "failed");
  assert.match(privateDns.summary, /public address/);
  assert.equal(fetchCalls, 0);
});

test("verify_github_pages rejects deprecated IPv6 site-local targets before fetch", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, text: async () => "live" };
  };
  const directLiteral = await createWorkflow({ run: pagesRun(head), fetchImpl }).verifyGithubPages({ projectPath: root, publicUrl: "http://[fec0::1]/" });
  assert.equal(directLiteral.verification, "failed");
  assert.match(directLiteral.summary, /public address/);
  const dnsTarget = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl: async () => [{ address: "fec0::1", family: 6 }] }).verifyGithubPages({ projectPath: root, publicUrl: "https://site-local.example/" });
  assert.equal(dnsTarget.verification, "failed");
  assert.match(dnsTarget.summary, /public address/);
  assert.equal(fetchCalls, 0);
});

test("verify_github_pages validates a redirect target before following it", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const fetched = [];
  const resolved = [];
  const fetchImpl = async (url, options) => {
    fetched.push([url, options.redirect]);
    return { ok: false, status: 302, headers: { get: () => "https://private.example/secret" }, text: async () => "" };
  };
  const lookupImpl = async (hostname) => {
    resolved.push(hostname);
    return [{ address: hostname === "private.example" ? "192.168.1.4" : "93.184.216.34", family: 4 }];
  };
  const result = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl }).verifyGithubPages({ projectPath: root, publicUrl: "https://safe.example/" });
  assert.equal(result.verification, "failed");
  assert.match(result.summary, /public address/);
  assert.deepEqual(fetched, [["https://safe.example/", "manual"]]);
  assert.deepEqual(resolved, ["safe.example", "private.example"]);
});

test("verify_github_pages follows a validated relative redirect manually", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const fetched = [];
  const fetchImpl = async (url, options) => {
    fetched.push([url, options.redirect]);
    if (url === "https://safe.example/start") {
      return { ok: false, status: 302, headers: { get: (name) => name.toLowerCase() === "location" ? "/portfolio/" : null }, text: async () => "" };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "Expected portfolio title" };
  };
  const result = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "https://safe.example/start", expectedText: "Expected portfolio title" });
  assert.equal(result.verification, "full", result.summary);
  assert.deepEqual(fetched, [["https://safe.example/start", "manual"], ["https://safe.example/portfolio/", "manual"]]);
  assert.equal(result.evidence.at(-1).publicUrl, "https://safe.example/portfolio/");
});

test("verify_github_pages rejects an oversized response body", async (t) => {
  const root = await fixtureRepo(t);
  const head = await githubRemote(t, root);
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "x".repeat(1_048_577) });
  const result = await createWorkflow({ run: pagesRun(head), fetchImpl, lookupImpl: publicLookup }).verifyGithubPages({ projectPath: root, publicUrl: "https://example.invalid/" });
  assert.equal(result.verification, "failed");
  assert.match(result.summary, /response body is too large/);
});
