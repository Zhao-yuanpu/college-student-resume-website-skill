import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "build"]);
const binaryExtensions = new Set([".7z", ".avif", ".bmp", ".class", ".dll", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lock", ".mp3", ".mp4", ".pdf", ".png", ".rar", ".tar", ".ttf", ".wasm", ".webp", ".woff", ".woff2", ".zip"]);
const maxTextFileSize = 256 * 1024;

export function runCommand(command, args, { input, timeoutMs = 30_000, maxOutputBytes = 1_048_576 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    const append = (target, chunk) => {
      const text = chunk.toString();
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) return target;
      const clipped = Buffer.from(text).subarray(0, remaining).toString();
      outputBytes += Buffer.byteLength(clipped);
      return target + clipped;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function git(run, repoRoot, args, options = {}) {
  return run("git", ["-C", repoRoot, ...args], options);
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

export function createWorkflow({ run = runCommand, fetchImpl = globalThis.fetch, now = Date.now, randomUUIDImpl = randomUUID } = {}) {
  void fetchImpl;
  void now;
  void randomUUIDImpl;
  return { inspectProject: (input) => inspectProject(input, { run }) };
}
