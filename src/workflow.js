import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "build"]);
const binaryExtensions = new Set([".7z", ".avif", ".bmp", ".class", ".dll", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lock", ".mp3", ".mp4", ".pdf", ".png", ".rar", ".tar", ".ttf", ".wasm", ".webp", ".woff", ".woff2", ".zip"]);
const maxTextFileSize = 256 * 1024;
const maxPagesBodyBytes = 1024 * 1024;
const protectedBasenames = new Set([".authinfo", ".git-credentials", ".htpasswd", ".netrc", ".npmrc", ".pypirc", ".yarnrc", ".yarnrc.yml", "_authinfo", "_netrc", "authorized_keys", "credentials", "credentials.json", "service-account.json", "service_account.json"]);
const protectedPaths = new Set([".docker/config.json", ".kube/config"]);
const blockedAddresses = new BlockList();

for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]]) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}
blockedAddresses.addSubnet("2001:db8::", 32, "ipv6");
blockedAddresses.addSubnet("3fff::", 20, "ipv6");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function terminateChild(child, closed) {
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
    try { child.kill(); } catch {}
    await closed;
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  const graceDeadline = Date.now() + 150;
  while (processGroupExists(child.pid) && Date.now() < graceDeadline) await wait(20);
  if (processGroupExists(child.pid)) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  await closed;
  while (processGroupExists(child.pid)) await wait(20);
}

export function runCommand(command, args, { cwd, input, timeoutMs = 30_000, maxOutputBytes = 1_048_576 } = {}) {
  return new Promise((resolve, reject) => {
    const isWindowsCommandScript = process.platform === "win32" && /\.cmd$/i.test(command);
    const child = isWindowsCommandScript
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(command, args, { cwd, detached: process.platform !== "win32", shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolve) => child.once("close", resolve));
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
    timer = setTimeout(async () => {
      timedOut = true;
      try {
        await terminateChild(child, closed);
      } finally {
        finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      if (timedOut) return;
      finish(reject, error);
    });
    child.once("close", (code, signal) => {
      if (timedOut) return;
      finish(resolve, { code, signal, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function redact(output) {
  return String(output)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\b((?:proxy-)?authorization)\s*:\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/(["']?[_-]*(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|auth[_-]?token|token|password|passwd|pwd|secret(?:[_-]access)?[_-]?key|secret|access[_-]?key|private[_-]?key|client[_-]?secret|session(?:[_-]?id)?|cookie|key)(?:[_-][a-z0-9]+)*)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|npm_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,})\b/gi, "[REDACTED]");
}

async function git(run, repoRoot, args, options = {}) {
  const result = await run("git", ["-C", repoRoot, ...args], options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result;
}

function normalized(path) {
  return path.replaceAll("\\", "/");
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function hashPart(hash, label, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label}\0${data.length}\0`);
  hash.update(data);
}

async function hashFile(hash, path, checkDeadline) {
  checkDeadline();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Snapshot path changed type while it was being read");
    hashPart(hash, "file-size", before.size);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0n;
    while (true) {
      checkDeadline();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += BigInt(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (total !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error("File changed while the snapshot was being created");
  } finally {
    await handle.close();
  }
}

async function statusFingerprint(run, repoRoot, commandOptions) {
  const status = (await git(run, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], commandOptions())).stdout;
  const index = (await git(run, repoRoot, ["ls-files", "--stage", "-z"], commandOptions())).stdout;
  const listed = (await git(run, repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], commandOptions())).stdout;
  const hash = createHash("sha256");
  hashPart(hash, "status", status);
  hashPart(hash, "index", index);
  for (const path of [...new Set(listed.split("\0").filter(Boolean))].sort()) {
    commandOptions();
    const absolutePath = resolve(repoRoot, path);
    if (!isInside(repoRoot, absolutePath)) throw new Error("Git returned a path outside the repository");
    hashPart(hash, "path", path);
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hashPart(hash, "missing", "");
      continue;
    }
    hashPart(hash, "mode", info.mode);
    if (info.isSymbolicLink()) hashPart(hash, "symlink", await readlink(absolutePath));
    else if (info.isFile()) await hashFile(hash, absolutePath, commandOptions);
    else hashPart(hash, "type", info.isDirectory() ? "directory" : "other");
  }
  return hash.digest("hex");
}

async function snapshot(run, start, commandOptions = () => ({})) {
  const repoRoot = (await git(run, start, ["rev-parse", "--show-toplevel"], commandOptions())).stdout.trim();
  const head = (await git(run, repoRoot, ["rev-parse", "HEAD"], commandOptions())).stdout.trim();
  const branch = (await git(run, repoRoot, ["branch", "--show-current"], commandOptions())).stdout.trim();
  return { repoRoot, head, branch, statusHash: await statusFingerprint(run, repoRoot, commandOptions) };
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

function sanitizedUrl(value, replacement = "[REDACTED]@") {
  return redact(String(value).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/i, `$1${replacement}`));
}

function summarizeWorktree(status) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const records = status.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index].slice(0, 2);
    if (code === "??") untracked += 1;
    else {
      if (code[0] !== " ") staged += 1;
      if (code[1] !== " ") unstaged += 1;
    }
    if (/[RC]/.test(code)) index += 1;
  }
  const clean = staged === 0 && unstaged === 0 && untracked === 0;
  return { clean, staged, unstaged, untracked, summary: clean ? "Worktree is clean" : `${staged} staged, ${unstaged} unstaged, ${untracked} untracked` };
}

async function configuredRemote(run, current) {
  const tracking = await run("git", ["-C", current.repoRoot, "config", "--get", `branch.${current.branch}.remote`]);
  let name = tracking.code === 0 ? tracking.stdout.trim() : "";
  if (!name) {
    const remotes = (await git(run, current.repoRoot, ["remote"])).stdout.split(/\r?\n/).filter(Boolean);
    name = remotes.includes("origin") ? "origin" : remotes[0];
  }
  if (!name || name === ".") return null;
  const url = (await git(run, current.repoRoot, ["remote", "get-url", name])).stdout.trim();
  return { name, url: sanitizedUrl(url, "") };
}

function projectHints(entries, packageJson, readme) {
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const sourceDirectories = ["src", "app", "pages", "public", "assets", "components"].filter((name) => directories.has(name));
  const buildDirectories = ["dist", "build", "out", ".next"].filter((name) => directories.has(name));
  const deploymentHints = [];
  if (/github\s+pages/i.test(readme) || files.has("CNAME") || files.has(".nojekyll")) deploymentHints.push("GitHub Pages");
  if (files.has("index.html")) deploymentHints.push("static entry: index.html");
  for (const name of ["build", "deploy"]) if (Object.hasOwn(packageJson.scripts ?? {}, name)) deploymentHints.push(`package script: ${name}`);
  const readmePromises = [];
  if (/(?:open|serve|直接打开)[^\n]{0,80}index\.html|index\.html[^\n]{0,80}(?:direct|直接)/i.test(readme)) readmePromises.push("direct index.html use");
  if (/github\s+pages/i.test(readme)) readmePromises.push("GitHub Pages delivery");
  if (/npm\s+run\s+(?:test|build)|production build/i.test(readme)) readmePromises.push("package checks or build");
  return { sourceDirectories, buildDirectories, deploymentHints, readmePromises };
}

async function inspectProject({ projectPath }, { run }) {
  try {
    const current = await snapshot(run, projectPath);
    const packageJson = JSON.parse(await readFile(join(current.repoRoot, "package.json"), "utf8").catch(() => "{}"));
    const entries = await readdir(current.repoRoot, { withFileTypes: true });
    const readmeEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "readme.md");
    const readme = readmeEntry ? await readFile(join(current.repoRoot, readmeEntry.name), "utf8") : "";
    const status = (await git(run, current.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    const evidence = await findEvidence(current.repoRoot);
    return {
      ok: true,
      phase: "inspect",
      summary: `Inspected ${normalized(current.repoRoot)}`,
      snapshot: { ...current, repoRoot: normalized(current.repoRoot) },
      packageScripts: Object.keys(packageJson.scripts ?? {}).sort(),
      remote: await configuredRemote(run, current),
      worktreeStatus: summarizeWorktree(status),
      ...projectHints(entries, packageJson, readme),
      evidence,
      nextAction: "Preview an allowed change before modifying the project"
    };
  } catch (error) {
    return { ok: false, phase: "inspect", summary: `Could not inspect project: ${redact(error.message)}`, evidence: [], nextAction: "Provide a local Git repository path" };
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
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const marker = line.slice(4).trimStart();
      const path = marker.startsWith('"') ? gitPathToken(marker, 0).path : marker.split("\t", 1)[0].trim();
      if (path !== "/dev/null") {
        const prefix = line.startsWith("--- ") ? "a/" : "b/";
        paths.push(path.startsWith(prefix) ? path.slice(2) : path);
      }
      continue;
    }
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
  if (lower.split("/").includes(".git") || (name.startsWith(".env") && name !== ".env.example") || protectedBasenames.has(name) || protectedPaths.has(lower) || /\.(?:jks|kdbx|key|keystore|p12|pem|pfx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:\.pub)?$/.test(name) || /(credential|password|passwd|secret|token)/.test(name)) {
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
      if (!isInside(root, resolved)) throw new Error("Path escapes the repository");
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

function runChecksBinding(current, scripts, timeoutSeconds, npmCommand) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, scripts, timeoutSeconds, npmCommand: normalized(npmCommand) };
}

function commitBinding(current, paths, message) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, paths, message };
}

function pushBinding(current, remote, branch, remoteUrl) {
  return { repoRoot: normalized(current.repoRoot), head: current.head, branch: current.branch, statusHash: current.statusHash, remote, branch, remoteUrl };
}

async function trustedNpmCommand(repoRoot) {
  const root = await realpath(repoRoot);
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(delimiter)];
  for (const rawDirectory of new Set(directories)) {
    const directory = rawDirectory.replace(/^"|"$/g, "");
    if (!directory) continue;
    try {
      const candidate = await realpath(join(directory, name));
      await access(candidate, constants.X_OK);
      if (!isInside(root, candidate)) return candidate;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Could not resolve a trusted ${name} outside the repository`);
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
    return { ok: false, phase: "patch", summary: `Could not apply patch: ${redact(error.message)}`, evidence: [], nextAction: "Preview a valid, allowed patch" };
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
    if (scripts.some((script) => !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(script))) throw new Error("scripts must use safe package script names without options or shell metacharacters");
    const packagePath = await realpath(join(current.repoRoot, "package.json"));
    if (!isInside(await realpath(current.repoRoot), packagePath)) throw new Error("package.json escapes the repository");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const available = packageJson.scripts ?? {};
    if (scripts.some((script) => !Object.hasOwn(available, script))) throw new Error("Requested script is not defined in package.json");
    if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive");
    const cappedTimeoutSeconds = Math.min(timeoutSeconds, 120);
    const npmCommand = await trustedNpmCommand(current.repoRoot);
    const binding = runChecksBinding(current, scripts, cappedTimeoutSeconds, npmCommand);
    if (mode === "preview") {
      const token = randomUUIDImpl();
      approvals.set(token, { operation: "run_checks", bindingHash: hashJson(binding), expiresAt: now() + 5 * 60 * 1000 });
      return { ok: true, phase: "checks", summary: `Checks are ready: ${scripts.join(", ")}`, evidence: scripts.map((script) => ({ script, command: `npm run ${script}` })), approvalToken: token, nextAction: "Execute with confirm: RUN" };
    }
    if (mode !== "execute" || confirm !== "RUN") throw new Error("Execution requires confirm: RUN");
    if (!approval || approval.operation !== "run_checks" || approval.expiresAt < now() || approval.bindingHash !== hashJson(binding)) throw new Error("Approval token is invalid, expired, stale, or already used");
    const timeoutMs = cappedTimeoutSeconds * 1000;
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
    return { ok: false, phase: "checks", summary: `Could not run checks: ${redact(error.message)}`, evidence, nextAction: "Preview only package scripts from a fresh snapshot" };
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
    for (const path of allowed) {
      await assertInsideRoot(current.repoRoot, path);
      try {
        const info = await lstat(join(current.repoRoot, path));
        if (info.isDirectory()) throw new Error("Commit paths must name files, not directories");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const pathspecs = literalPathspecs(allowed);
    if (typeof message !== "string" || !message.trim() || /[\r\n]/.test(message)) throw new Error("message must be a nonblank single line");
    const stagedBefore = (await git(run, current.repoRoot, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean).map(safePath);
    if (stagedBefore.some((path) => !allowed.includes(path))) throw new Error("Pre-existing staged paths are outside the commit scope");
    const changed = new Set((await git(run, current.repoRoot, ["diff", "--name-only", "-z", "HEAD", "--", ...pathspecs])).stdout.split("\0").filter(Boolean));
    for (const path of (await git(run, current.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs])).stdout.split("\0").filter(Boolean)) changed.add(path);
    if (changed.size === 0) throw new Error("No changes to commit");
    const changedPaths = [...changed].map(safePath);
    if (changedPaths.some((path) => !allowed.includes(path))) throw new Error("Git expanded the commit scope beyond the explicit file list");
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
    const stagedPaths = (await git(run, current.repoRoot, ["diff", "--cached", "--name-only", "-z", "--", ...pathspecs])).stdout.split("\0").filter(Boolean).map(safePath);
    if (stagedPaths.length === 0) throw new Error("No staged changes to commit");
    if (stagedPaths.some((path) => !allowed.includes(path))) throw new Error("Git staged a path outside the explicit file list");
    await git(run, current.repoRoot, ["commit", "-m", message]);
    const fresh = await snapshot(run, current.repoRoot);
    return { ok: true, phase: "commit", summary: `Committed ${allowed.join(", ")}`, evidence: allowed, head: fresh.head, snapshot: { ...fresh, repoRoot: normalized(fresh.repoRoot) }, nextAction: "Preview the next workflow phase" };
  } catch (error) {
    return { ok: false, phase: "commit", summary: `Could not commit changes: ${redact(error.message)}`, evidence: [], nextAction: "Preview explicit changed paths from a fresh snapshot" };
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
    const pushUrls = (await git(run, current.repoRoot, ["remote", "get-url", "--push", "--all", remote])).stdout.split(/\r?\n/).filter(Boolean);
    if (pushUrls.length !== 1) throw new Error("remote must have exactly one push URL");
    const pushUrl = pushUrls[0];
    const displayUrl = sanitizedUrl(pushUrl);
    const refspec = `HEAD:refs/heads/${branch}`;
    const binding = pushBinding(current, remote, branch, pushUrl);
    if (mode === "preview") {
      const token = randomUUIDImpl();
      approvals.set(token, { operation: "push_changes", bindingHash: hashJson(binding), expiresAt: now() + 5 * 60 * 1000 });
      return { ok: true, phase: "push", summary: `Push is ready for ${remote} ${refspec}`, evidence: [{ remote, pushUrl: displayUrl, refspec }], approvalToken: token, nextAction: "Execute with confirm: PUSH" };
    }
    if (mode !== "execute" || confirm !== "PUSH") throw new Error("Execution requires confirm: PUSH");
    if (!approval || approval.operation !== "push_changes" || approval.expiresAt < now() || approval.bindingHash !== hashJson(binding)) throw new Error("Approval token is invalid, expired, stale, or already used");
    await git(run, current.repoRoot, ["push", "--", pushUrl, refspec]);
    const remoteHead = (await git(run, current.repoRoot, ["ls-remote", "--heads", "--", pushUrl, `refs/heads/${branch}`])).stdout.trim().split(/\s+/)[0];
    if (remoteHead !== current.head) throw new Error("Remote branch does not match local HEAD after push");
    const fresh = await snapshot(run, current.repoRoot);
    return { ok: true, phase: "push", summary: `Pushed ${refspec} to ${remote}`, evidence: [{ remote, pushUrl: displayUrl, refspec, remoteHead }], snapshot: { ...fresh, repoRoot: normalized(fresh.repoRoot) }, nextAction: "Preview the next workflow phase" };
  } catch (error) {
    return { ok: false, phase: "push", summary: `Could not push changes: ${redact(error.message)}`, evidence: [], nextAction: "Preview a configured remote and current branch from a fresh snapshot" };
  }
}

function githubRepository(remoteUrl) {
  const match = remoteUrl.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repository: match[2] } : null;
}

function pagesResult(verification, summary, evidence, nextAction) {
  return { ok: verification === "full" || verification === "partial", phase: "pages", verification, summary, evidence, nextAction };
}

function withDeadline(promise, deadline, message, onTimeout = () => {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, remaining);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function parsePublicUrl(value) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("publicUrl must be a public HTTP(S) URL");
  return parsed;
}

async function publicTarget(url, lookupImpl, deadline) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const directFamily = isIP(hostname);
  const resolved = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await withDeadline(lookupImpl(hostname, { all: true, verbatim: true }), deadline, "Public URL DNS lookup timed out");
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.length === 0) throw new Error("Public URL hostname did not resolve");
  const normalizedAddresses = addresses.map((record) => {
    const address = typeof record === "string" ? record : record.address;
    const family = isIP(address);
    if (!family || blockedAddresses.check(address, `ipv${family}`)) throw new Error("Public URL must resolve only to public addresses");
    return { address, family };
  });
  return { url, ...normalizedAddresses[0] };
}

function pinnedRequest(target, signal) {
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url, {
      method: "GET",
      signal,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }
    }, (response) => resolve({
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      headers: { get: (name) => response.headers[name.toLowerCase()] ?? null },
      body: response
    }));
    request.once("error", reject);
    request.end();
  });
}

async function requestPublicUrl(fetchImpl, target, deadline) {
  const controller = new AbortController();
  const request = fetchImpl
    ? fetchImpl(target.url.href, { signal: controller.signal, redirect: "manual" })
    : pinnedRequest(target, controller.signal);
  const response = await withDeadline(request, deadline, "Public URL request timed out", () => controller.abort());
  return { response, controller };
}

function responseHeader(response, name) {
  if (typeof response.headers?.get === "function") return response.headers.get(name);
  return response.headers?.[name.toLowerCase()] ?? null;
}

async function discardBody(response) {
  try {
    if (typeof response.body?.cancel === "function") await response.body.cancel();
    else if (typeof response.body?.destroy === "function") response.body.destroy();
  } catch {}
}

async function responseText(response, deadline, controller) {
  const contentLength = responseHeader(response, "content-length");
  if (/^\d+$/.test(contentLength ?? "") && Number(contentLength) > maxPagesBodyBytes) throw new Error("Public URL response body is too large");
  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxPagesBodyBytes) throw new Error("Public URL response body is too large");
    chunks.push(buffer);
  };
  try {
    if (typeof response.body?.getReader === "function") {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await withDeadline(reader.read(), deadline, "Public URL request timed out", () => controller.abort());
        if (done) break;
        append(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    if (response.body?.[Symbol.asyncIterator]) {
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const { done, value } = await withDeadline(iterator.next(), deadline, "Public URL request timed out", () => controller.abort());
        if (done) break;
        append(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    const text = await withDeadline(response.text(), deadline, "Public URL request timed out", () => controller.abort());
    append(text);
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    controller.abort();
    await discardBody(response);
    throw error;
  }
}

async function fetchPublicUrl(fetchImpl, lookupImpl, initialUrl, deadline) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const target = await publicTarget(url, lookupImpl, deadline);
    const { response, controller } = await requestPublicUrl(fetchImpl, target, deadline);
    const status = Number(response.status ?? response.statusCode);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = responseHeader(response, "location");
      await discardBody(response);
      controller.abort();
      if (!location) throw new Error(`Public URL returned HTTP ${status} without a Location header`);
      if (redirects === 5) throw new Error("Public URL redirected too many times");
      url = parsePublicUrl(new URL(location, url).href);
      continue;
    }
    const ok = typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300;
    if (!ok) {
      await discardBody(response);
      return { response: { status, ok }, body: "", url };
    }
    return { response: { status, ok }, body: await responseText(response, deadline, controller), url };
  }
  throw new Error("Public URL redirected too many times");
}

async function verifyGithubPages({ projectPath, publicUrl, expectedText, timeoutSeconds = 60 }, { run, fetchImpl, lookupImpl }) {
  const evidence = [];
  let deadline = 0;
  try {
    if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0 || timeoutSeconds > 60) throw new Error("timeoutSeconds must be greater than 0 and no more than 60");
    if (expectedText !== undefined && (typeof expectedText !== "string" || !expectedText)) throw new Error("expectedText must be a nonblank string when provided");
    let parsedUrl;
    if (publicUrl !== undefined) {
      if (typeof publicUrl !== "string") throw new Error("publicUrl must be a string when provided");
      parsedUrl = parsePublicUrl(publicUrl);
    } else if (expectedText !== undefined) {
      throw new Error("expectedText requires publicUrl");
    }
    deadline = Date.now() + timeoutSeconds * 1000;
    const commandOptions = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Verification timed out");
      return { timeoutMs: remaining };
    };
    const current = await snapshot(run, projectPath, commandOptions);
    const configuredRemote = await run("git", ["-C", current.repoRoot, "config", "--get", `branch.${current.branch}.remote`], { cwd: current.repoRoot, ...commandOptions() });
    const remote = configuredRemote.code === 0 && configuredRemote.stdout.trim() ? configuredRemote.stdout.trim() : "origin";
    const remoteUrl = (await git(run, current.repoRoot, ["remote", "get-url", remote], commandOptions())).stdout.trim();
    const remoteHeadResult = await run("git", ["-C", current.repoRoot, "ls-remote", "--heads", "--", remoteUrl, `refs/heads/${current.branch}`], { cwd: current.repoRoot, ...commandOptions() });
    if (remoteHeadResult.code !== 0) throw new Error(remoteHeadResult.stderr.trim() || "Could not read the tracked remote branch");
    const remoteHead = remoteHeadResult.stdout.trim().split(/\s+/)[0];
    evidence.push({ remote, branch: current.branch, localHead: current.head, remoteHead: remoteHead || null, synchronized: remoteHead === current.head });
    if (remoteHead !== current.head) return pagesResult("failed", "Tracked remote branch does not match local HEAD", evidence, "Push the current branch, then verify again");

    const repository = githubRepository(remoteUrl);
    let buildUnavailable = !repository;
    if (repository) {
      while (true) {
        let options;
        try {
          options = commandOptions();
        } catch {
          return pagesResult("timeout", "Timed out waiting for GitHub Pages build status", evidence, "Try verification again after the Pages build completes");
        }
        let build;
        try {
          build = await run("gh", ["api", `repos/${repository.owner}/${repository.repository}/pages/builds/latest`, "--jq", "{status: .status, commit: .commit} | @json"], { cwd: current.repoRoot, ...options });
        } catch (error) {
          evidence.push({ buildState: "unavailable", reason: redact(error.message) });
          buildUnavailable = true;
          break;
        }
        if (build.code !== 0) {
          evidence.push({ buildState: "unavailable", reason: redact((build.stderr || build.stdout || "gh could not read Pages status").trim()) });
          buildUnavailable = true;
          break;
        }
        let buildInfo;
        try {
          buildInfo = JSON.parse(build.stdout.trim());
        } catch {
          return pagesResult("partial", "GitHub Pages returned an unreadable build record", evidence, "Retry verification after GitHub Pages returns build details");
        }
        const status = String(buildInfo.status ?? "").toLowerCase();
        const buildCommit = typeof buildInfo.commit === "string" ? buildInfo.commit : null;
        evidence.push({ buildState: status, buildCommit });
        if (status === "built" && buildCommit === current.head) break;
        if (status === "built" && buildCommit && buildCommit !== current.head) {
          const remainingAfterPoll = deadline - Date.now();
          if (remainingAfterPoll <= 0) return pagesResult("timeout", "Timed out waiting for the current GitHub Pages build", evidence, "Try verification again after the Pages build completes");
          await wait(Math.min(250, remainingAfterPoll));
          continue;
        }
        if (["errored", "error", "failed", "canceled", "cancelled"].includes(status)) return pagesResult("failed", `GitHub Pages build is ${status}`, evidence, "Fix the Pages build, then verify again");
        const remainingAfterPoll = deadline - Date.now();
        if (remainingAfterPoll <= 0) return pagesResult("timeout", "Timed out waiting for GitHub Pages build status", evidence, "Try verification again after the Pages build completes");
        await wait(Math.min(250, remainingAfterPoll));
      }
    } else {
      evidence.push({ buildState: "unavailable", reason: "Configured remote is not a recognizable GitHub URL" });
    }

    if (!parsedUrl) return pagesResult("partial", "Remote branch is synchronized, but no public URL was provided", evidence, "Provide the GitHub Pages public URL for live verification");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return pagesResult("timeout", "Timed out before fetching the public URL", evidence, "Try verification again with a longer timeout");
    let fetched;
    try {
      fetched = await fetchPublicUrl(fetchImpl, lookupImpl, parsedUrl, deadline);
    } catch (error) {
      return pagesResult(error.message.includes("timed out") ? "timeout" : "failed", `Could not fetch public URL: ${redact(error.message)}`, evidence, "Check the public URL and try again");
    }
    evidence.push({ publicUrl: fetched.url.href, status: fetched.response.status, ok: fetched.response.ok });
    if (!fetched.response.ok) return pagesResult("failed", `Public URL returned HTTP ${fetched.response.status}`, evidence, "Fix the deployed site, then verify again");
    if (expectedText !== undefined && !fetched.body.includes(expectedText)) return pagesResult("failed", "Public URL did not contain the expected text", evidence, "Check the deployed content, then verify again");
    return pagesResult(buildUnavailable ? "partial" : "full", buildUnavailable ? "Public URL is live, but GitHub Pages build status is unavailable" : "GitHub Pages deployment is verified", evidence, buildUnavailable ? "Restore GitHub CLI Pages access for a full build-state check" : "Delivery is verified");
  } catch (error) {
    if (deadline && Date.now() >= deadline) return pagesResult("timeout", "Timed out while verifying GitHub Pages", evidence, "Try verification again with a longer timeout");
    return pagesResult("failed", `Could not verify GitHub Pages: ${redact(error.message)}`, evidence, "Provide a local repository with a configured tracked remote");
  }
}

export function createWorkflow({ run = runCommand, fetchImpl, lookupImpl = lookup, now = Date.now, randomUUIDImpl = randomUUID } = {}) {
  const approvals = new Map();
  return {
    inspectProject: (input) => inspectProject(input, { run }),
    applyPatch: (input) => applyPatch(input, { run, now, randomUUIDImpl, approvals }),
    runChecks: (input) => runChecks(input, { run, now, randomUUIDImpl, approvals }),
    commitChanges: (input) => commitChanges(input, { run, now, randomUUIDImpl, approvals }),
    pushChanges: (input) => pushChanges(input, { run, now, randomUUIDImpl, approvals }),
    verifyGithubPages: (input) => verifyGithubPages(input, { run, fetchImpl, lookupImpl })
  };
}
