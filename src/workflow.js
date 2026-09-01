import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "build"]);
const binaryExtensions = new Set([".7z", ".avif", ".bmp", ".class", ".dll", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lock", ".mp3", ".mp4", ".pdf", ".png", ".rar", ".tar", ".ttf", ".wasm", ".webp", ".woff", ".woff2", ".zip"]);
const maxTextFileSize = 256 * 1024;

export function runCommand(command, args, { cwd, input, timeoutMs = 30_000, maxOutputBytes = 1_048_576 } = {}) {
  return new Promise((resolve, reject) => {
    const isWindowsCommandScript = process.platform === "win32" && command.endsWith(".cmd");
    const child = isWindowsCommandScript
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(command, args, { cwd, detached: process.platform !== "win32", shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const append = (target, chunk) => {
      const text = chunk.toString();
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) return target;
      const clipped = Buffer.from(text).subarray(0, remaining).toString();
      outputBytes += Buffer.byteLength(clipped);
      return target + clipped;
    };
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
      else {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
      }
      child.kill();
      finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      finish(reject, error);
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      finish(resolve, { code, signal, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function redact(output) {
  return output.replace(/\b(token|password|secret|key)\b\s*([=:])\s*("[^"]*"|'[^']*'|[^\s]+)/gi, "$1$2[REDACTED]");
}

async function git(run, repoRoot, args, options = {}) {
  const result = await run("git", ["-C", repoRoot, ...args], options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result;
}

function normalized(path) {
  return path.replaceAll("\\", "/");
}

async function snapshot(run, start) {
  const repoRoot = (await git(run, start, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const head = (await git(run, repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await git(run, repoRoot, ["branch", "--show-current"])).stdout.trim();
  const status = (await git(run, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  return { repoRoot, head, branch, statusHash: createHash("sha256").update(status).digest("hex") };
}

function categoriesFor(path, text) {
  const haystack = `${path}\n${text}`.toLowerCase();
  const categories = [];
  if (/(design|direction|approved|reference|mockup|设计|视觉)/.test(haystack)) categories.push("design");
  if (/(deliver|deploy|github pages|publish|上线|交付|部署)/.test(haystack)) categories.push("delivery");
  if (/(privacy|private|redact|personal|隐私|遮挡|证书编号)/.test(haystack)) categories.push("privacy");
  return categories;
}

async function findEvidence(root, directory = root, evidence = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await findEvidence(root, join(directory, entry.name), evidence);
      continue;
    }
    if (!entry.isFile() || binaryExtensions.has(extname(entry.name).toLowerCase())) continue;
    const absolutePath = join(directory, entry.name);
    const data = await readFile(absolutePath);
    if (data.length > maxTextFileSize || data.includes(0)) continue;
    const path = normalized(relative(root, absolutePath));
    const categories = categoriesFor(path, data.toString("utf8"));
    if (categories.length) evidence.push({ path, categories });
  }
  return evidence;
}

async function inspectProject({ projectPath }, { run }) {
  try {
    const current = await snapshot(run, projectPath);
    const packageJson = JSON.parse(await readFile(join(current.repoRoot, "package.json"), "utf8").catch(() => "{}"));
    const evidence = await findEvidence(current.repoRoot);
    return {
      ok: true,
      phase: "inspect",
      summary: `Inspected ${normalized(current.repoRoot)}`,
      snapshot: { ...current, repoRoot: normalized(current.repoRoot) },
      packageScripts: Object.keys(packageJson.scripts ?? {}).sort(),
      evidence,
      nextAction: "Preview an allowed change before modifying the project"
    };
  } catch (error) {
    return { ok: false, phase: "inspect", summary: `Could not inspect project: ${error.message}`, evidence: [], nextAction: "Provide a local Git repository path" };
  }
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function gitPathToken(input, start) {
  if (input[start] === '"') {
    let path = "";
    for (let index = start + 1; index < input.length; index += 1) {
      if (input[index] === '"') return { path, next: index + 1 };
      if (input[index] !== "\\") {
        path += input[index];
        continue;
      }
      const escape = input[++index];
      if (escape === undefined) break;
      const escaped = { a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[escape];
      if (escaped !== undefined) path += escaped;
      else if (/[0-7]/.test(escape)) {
        let octal = `${escape}${input[index + 1] ?? ""}${input[index + 2] ?? ""}`;
        if (!/^[0-7]{3}$/.test(octal)) break;
        const bytes = [Number.parseInt(octal, 8)];
        index += 2;
        while (input[index + 1] === "\\") {
          octal = input.slice(index + 2, index + 5);
          if (!/^[0-7]{3}$/.test(octal)) break;
          bytes.push(Number.parseInt(octal, 8));
          index += 4;
        }
        path += Buffer.from(bytes).toString("utf8");
      } else if (escape === "\\" || escape === '"') path += escape;
      else throw new Error("Patch contains an invalid quoted file path");
    }
    throw new Error("Patch contains an invalid quoted file path");
  }
  const end = input.indexOf(" ", start);
  return { path: input.slice(start, end === -1 ? input.length : end), next: end === -1 ? input.length : end };
}

function patchPaths(patch) {
  const paths = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const input = line.slice("diff --git ".length);
    let oldPath;
    let newPath;
    if (input.startsWith('"')) {
      oldPath = gitPathToken(input, 0);
      const rest = input.slice(oldPath.next + 1);
      if (input[oldPath.next] !== " ") throw new Error("Patch contains an invalid file path");
      const parsedNewPath = rest.startsWith('"') ? gitPathToken(rest, 0) : null;
      newPath = parsedNewPath ? parsedNewPath.path : rest;
      if (!newPath || (parsedNewPath && rest.slice(parsedNewPath.next).trim())) throw new Error("Patch contains an invalid file path");
      oldPath = oldPath.path;
    } else {
      const separator = input.indexOf(" b/");
      if (separator === -1) throw new Error("Patch contains an invalid file path");
      oldPath = input.slice(0, separator);
      newPath = input.slice(separator + 1);
    }
    if (!oldPath.startsWith("a/") || !newPath.startsWith("b/")) throw new Error("Patch contains an invalid file path");
    paths.push(oldPath.slice(2), newPath.slice(2));
  }
  if (!paths.length) throw new Error("Patch does not contain file paths");
  return [...new Set(paths)].sort();
}

function safePath(path) {
  const normalizedPath = normalized(path);
  if (!path || path.includes("\0") || isAbsolute(path) || normalizedPath.startsWith("/") || normalizedPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Patch path must be a relative path without traversal");
  }
  const lower = normalizedPath.toLowerCase();
  const name = lower.split("/").at(-1);
  if (lower.split("/").includes(".git") || (name.startsWith(".env") && name !== ".env.example") || /\.(pem|key)$/.test(name) || /(credential|password|secret|token|id_rsa)/.test(name)) {
    throw new Error("Patch path is protected");
  }
  return normalizedPath;
}

function literalPathspecs(paths) {
  return paths.map((path) => `:(literal)${path}`);
}

async function assertInsideRoot(repoRoot, path) {
  const root = await realpath(repoRoot);
  let candidate = resolve(root, path);
  while (true) {
    try {
      const resolved = await realpath(candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error("Patch path escapes the repository");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = resolve(candidate, "..");
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function equalSnapshot(expected, actual) {
  return expected && normalized(expected.repoRoot) === normalized(actual.repoRoot) && expected.head === actual.head && expected.branch === actual.branch && expected.statusHash === actual.statusHash;
}

function approvalBinding(current, patch, allowedPaths) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, patchHash: createHash("sha256").update(patch).digest("hex"), allowedPaths: [...allowedPaths].sort() };
}

function runChecksBinding(current, scripts, timeoutSeconds) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, scripts, timeoutSeconds };
}

function commitBinding(current, paths, message) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, paths, message };
}

function pushBinding(current, remote, branch, remoteUrl) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, remote, branch, remoteUrl };
}

async function applyPatch({ projectPath, snapshot: requestedSnapshot, patch, allowedPaths, mode, approvalToken, confirm }, { run, now, randomUUIDImpl, approvals }) {
  const approval = mode === "execute" ? approvals.get(approvalToken) : null;
  if (mode === "execute") approvals.delete(approvalToken);
  try {
    const current = await snapshot(run, projectPath);
    if (!equalSnapshot(requestedSnapshot, current)) throw new Error("Snapshot is stale");
    const paths = patchPaths(patch).map(safePath);
    const allowed = allowedPaths.map(safePath).sort();
    if (new Set(allowed).size !== allowed.length) throw new Error("allowedPaths must not contain duplicates");
    if (paths.length !== allowed.length || paths.some((path, index) => path !== allowed[index])) throw new Error("Patch paths must exactly match allowedPaths");
    for (const path of paths) await assertInsideRoot(current.repoRoot, path);
    await git(run, current.repoRoot, ["apply", "--check", "--whitespace=error-all", "-"], { input: patch });
    const binding = approvalBinding(current, patch, allowed);
    if (mode === "preview") {
      const token = randomUUIDImpl();
      approvals.set(token, { operation: "apply_patch", bindingHash: hashJson(binding), expiresAt: now() + 5 * 60 * 1000 });
      return { ok: true, phase: "patch", summary: `Patch is ready for ${paths.join(", ")}`, evidence: paths, approvalToken: token, nextAction: "Execute with confirm: WRITE" };
    }
    if (mode !== "execute" || confirm !== "WRITE") throw new Error("Execution requires confirm: WRITE");
    if (!approval || approval.operation !== "apply_patch" || approval.expiresAt < now() || approval.bindingHash !== hashJson(binding)) throw new Error("Approval token is invalid, expired, stale, or already used");
    await git(run, current.repoRoot, ["apply", "--check", "--whitespace=error-all", "-"], { input: patch });
    await git(run, current.repoRoot, ["apply", "--whitespace=error-all", "-"], { input: patch });
    const fresh = await snapshot(run, current.repoRoot);
    return { ok: true, phase: "patch", summary: `Applied patch to ${paths.join(", ")}`, evidence: paths, snapshot: { ...fresh, repoRoot: normalized(fresh.repoRoot) }, nextAction: "Preview the next workflow phase" };
  } catch (error) {
    return { ok: false, phase: "patch", summary: `Could not apply patch: ${error.message}`, evidence: [], nextAction: "Preview a valid, allowed patch" };
  }
}

async function runChecks({ projectPath, snapshot: requestedSnapshot, scripts, mode, approvalToken, confirm, timeoutSeconds = 120 }, { run, now, randomUUIDImpl, approvals }) {
  const approval = mode === "execute" ? approvals.get(approvalToken) : null;
  if (mode === "execute") approvals.delete(approvalToken);
  const evidence = [];
  try {
    const current = await snapshot(run, projectPath);
    if (!equalSnapshot(requestedSnapshot, current)) throw new Error("Snapshot is stale");
    if (!Array.isArray(scripts) || scripts.length === 0 || new Set(scripts).size !== scripts.length || scripts.some((script) => typeof script !== "string" || !script)) throw new Error("scripts must be a non-empty duplicate-free list");
    const packageJson = JSON.parse(await readFile(join(current.repoRoot, "package.json"), "utf8"));
    const available = packageJson.scripts ?? {};
    if (scripts.some((script) => !Object.hasOwn(available, script))) throw new Error("Requested script is not defined in package.json");
    if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive");
    const cappedTimeoutSeconds = Math.min(timeoutSeconds, 120);
    const binding = runChecksBinding(current, scripts, cappedTimeoutSeconds);
    if (mode === "preview") {
      const token = randomUUIDImpl();
      approvals.set(token, { operation: "run_checks", bindingHash: hashJson(binding), expiresAt: now() + 5 * 60 * 1000 });
      return { ok: true, phase: "checks", summary: `Checks are ready: ${scripts.join(", ")}`, evidence: scripts.map((script) => ({ script, command: `npm run ${script}` })), approvalToken: token, nextAction: "Execute with confirm: RUN" };
    }
    if (mode !== "execute" || confirm !== "RUN") throw new Error("Execution requires confirm: RUN");
    if (!approval || approval.operation !== "run_checks" || approval.expiresAt < now() || approval.bindingHash !== hashJson(binding)) throw new Error("Approval token is invalid, expired, stale, or already used");
    const timeoutMs = cappedTimeoutSeconds * 1000;
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    for (const script of scripts) {
      try {
        const result = await run(npmCommand, ["run", script], { cwd: current.repoRoot, timeoutMs, maxOutputBytes: 64 * 1024 });
        evidence.push({ script, exitCode: result.exitCode ?? result.code, stdout: redact(result.stdout ?? ""), stderr: redact(result.stderr ?? "") });
        if ((result.exitCode ?? result.code) !== 0) return { ok: false, phase: "checks", summary: `Check failed: ${script}`, evidence, nextAction: "Fix the first failing script and preview again" };
      } catch (error) {
        evidence.push({ script, exitCode: null, stdout: "", stderr: redact(error.message) });
        return { ok: false, phase: "checks", summary: `Check failed: ${script}`, evidence, nextAction: "Fix the first failing script and preview again" };
      }
    }
    const fresh = await snapshot(run, current.repoRoot);
    return { ok: true, phase: "checks", summary: `Completed ${scripts.length} check${scripts.length === 1 ? "" : "s"}`, evidence, snapshot: { ...fresh, repoRoot: normalized(fresh.repoRoot) }, nextAction: "Preview the next workflow phase" };
  } catch (error) {
    return { ok: false, phase: "checks", summary: `Could not run checks: ${error.message}`, evidence, nextAction: "Preview only package scripts from a fresh snapshot" };
  }
}

async function commitChanges({ projectPath, snapshot: requestedSnapshot, paths, message, mode, approvalToken, confirm }, { run, now, randomUUIDImpl, approvals }) {
  const approval = mode === "execute" ? approvals.get(approvalToken) : null;
  if (mode === "execute") approvals.delete(approvalToken);
  try {
    const current = await snapshot(run, projectPath);
    if (!equalSnapshot(requestedSnapshot, current)) throw new Error("Snapshot is stale");
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths must be a non-empty list");
    const allowed = paths.map(safePath).sort();
    if (new Set(allowed).size !== allowed.length) throw new Error("paths must not contain duplicates");
    for (const path of allowed) await assertInsideRoot(current.repoRoot, path);
    const pathspecs = literalPathspecs(allowed);
    if (typeof message !== "string" || !message.trim() || /[\r\n]/.test(message)) throw new Error("message must be a nonblank single line");
    const stagedBefore = (await git(run, current.repoRoot, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean).map(safePath);
    if (stagedBefore.some((path) => !allowed.includes(path))) throw new Error("Pre-existing staged paths are outside the commit scope");
    const changed = new Set((await git(run, current.repoRoot, ["diff", "--name-only", "-z", "HEAD", "--", ...pathspecs])).stdout.split("\0").filter(Boolean));
    for (const path of (await git(run, current.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs])).stdout.split("\0").filter(Boolean)) changed.add(path);
    if (changed.size === 0) throw new Error("No changes to commit");
    const binding = commitBinding(current, allowed, message);
    if (mode === "preview") {
      const token = randomUUIDImpl();
      approvals.set(token, { operation: "commit_changes", bindingHash: hashJson(binding), expiresAt: now() + 5 * 60 * 1000 });
      return { ok: true, phase: "commit", summary: `Commit is ready for ${allowed.join(", ")}`, evidence: allowed, approvalToken: token, nextAction: "Execute with confirm: COMMIT" };
    }
    if (mode !== "execute" || confirm !== "COMMIT") throw new Error("Execution requires confirm: COMMIT");
    if (!approval || approval.operation !== "commit_changes" || approval.expiresAt < now() || approval.bindingHash !== hashJson(binding)) throw new Error("Approval token is invalid, expired, stale, or already used");
    await git(run, current.repoRoot, ["add", "--", ...pathspecs]);
    await git(run, current.repoRoot, ["diff", "--cached", "--check", "--", ...pathspecs]);
    const staged = (await git(run, current.repoRoot, ["diff", "--cached", "--name-only", "-z", "--", ...pathspecs])).stdout;
    if (!staged) throw new Error("No staged changes to commit");
    await git(run, current.repoRoot, ["commit", "-m", message]);
    const fresh = await snapshot(run, current.repoRoot);
    return { ok: true, phase: "commit", summary: `Committed ${allowed.join(", ")}`, evidence: allowed, head: fresh.head, snapshot: { ...fresh, repoRoot: normalized(fresh.repoRoot) }, nextAction: "Preview the next workflow phase" };
  } catch (error) {
    return { ok: false, phase: "commit", summary: `Could not commit changes: ${error.message}`, evidence: [], nextAction: "Preview explicit changed paths from a fresh snapshot" };
  }
}

async function pushChanges(input, { run, now, randomUUIDImpl, approvals }) {
  const { projectPath, snapshot: requestedSnapshot, remote, branch, mode, approvalToken, confirm } = input;
  const approval = mode === "execute" ? approvals.get(approvalToken) : null;
  if (mode === "execute") approvals.delete(approvalToken);
  try {
    const allowedFields = new Set(["projectPath", "snapshot", "remote", "branch", "mode", "approvalToken", "confirm"]);
    if (Object.keys(input).some((key) => !allowedFields.has(key))) throw new Error("push_changes does not accept remote URLs or Git arguments");
    const current = await snapshot(run, projectPath);
    if (!equalSnapshot(requestedSnapshot, current)) throw new Error("Snapshot is stale");
    if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error("remote must be a configured remote name");
    if (typeof branch !== "string" || branch.startsWith("-") || branch.includes(":")) throw new Error("branch must be a normal branch name");
    if (current.branch !== branch) throw new Error("branch must match the current branch");
    await git(run, current.repoRoot, ["check-ref-format", "--branch", branch]);
    const remoteUrl = (await git(run, current.repoRoot, ["remote", "get-url", remote])).stdout.trim();
    if (!remoteUrl) throw new Error("remote has no configured URL");
    const refspec = `HEAD:refs/heads/${branch}`;
    const binding = pushBinding(current, remote, branch, remoteUrl);
    if (mode === "preview") {
      const token = randomUUIDImpl();
      approvals.set(token, { operation: "push_changes", bindingHash: hashJson(binding), expiresAt: now() + 5 * 60 * 1000 });
      return { ok: true, phase: "push", summary: `Push is ready for ${remote} ${refspec}`, evidence: [{ remote, refspec }], approvalToken: token, nextAction: "Execute with confirm: PUSH" };
    }
    if (mode !== "execute" || confirm !== "PUSH") throw new Error("Execution requires confirm: PUSH");
    if (!approval || approval.operation !== "push_changes" || approval.expiresAt < now() || approval.bindingHash !== hashJson(binding)) throw new Error("Approval token is invalid, expired, stale, or already used");
    await git(run, current.repoRoot, ["push", remote, refspec]);
    const remoteHead = (await git(run, current.repoRoot, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])).stdout.trim().split(/\s+/)[0];
    if (remoteHead !== current.head) throw new Error("Remote branch does not match local HEAD after push");
    const fresh = await snapshot(run, current.repoRoot);
    return { ok: true, phase: "push", summary: `Pushed ${refspec} to ${remote}`, evidence: [{ remote, refspec, remoteHead }], snapshot: { ...fresh, repoRoot: normalized(fresh.repoRoot) }, nextAction: "Preview the next workflow phase" };
  } catch (error) {
    return { ok: false, phase: "push", summary: `Could not push changes: ${error.message}`, evidence: [], nextAction: "Preview a configured remote and current branch from a fresh snapshot" };
  }
}

export function createWorkflow({ run = runCommand, fetchImpl = globalThis.fetch, now = Date.now, randomUUIDImpl = randomUUID } = {}) {
  void fetchImpl;
  const approvals = new Map();
  return {
    inspectProject: (input) => inspectProject(input, { run }),
    applyPatch: (input) => applyPatch(input, { run, now, randomUUIDImpl, approvals }),
    runChecks: (input) => runChecks(input, { run, now, randomUUIDImpl, approvals }),
    commitChanges: (input) => commitChanges(input, { run, now, randomUUIDImpl, approvals }),
    pushChanges: (input) => pushChanges(input, { run, now, randomUUIDImpl, approvals })
  };
}
