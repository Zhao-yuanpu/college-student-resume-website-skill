#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWorkflow } from "./workflow.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function toToolResult(result) {
  return {
    content: [{ type: "text", text: `${result.summary}\n${JSON.stringify(result)}` }],
    structuredContent: result,
    isError: result.ok === false
  };
}

export function createServer(workflow) {
  const server = new McpServer({ name: "student-portfolio-website-mcp", version: pkg.version });
  server.registerTool("inspect_project", {
    description: "Inspect a student portfolio repository and return a safe workflow snapshot.",
    inputSchema: { projectPath: z.string().min(1) }
  }, async (input) => toToolResult(await workflow.inspectProject(input)));
  server.registerTool("apply_patch", {
    description: "Preview and apply a guarded unified patch to explicit project paths.",
    inputSchema: {
      projectPath: z.string().min(1),
      snapshot: z.object({ repoRoot: z.string(), head: z.string(), branch: z.string(), statusHash: z.string() }),
      patch: z.string().min(1),
      allowedPaths: z.array(z.string().min(1)).min(1),
      mode: z.enum(["preview", "execute"]),
      approvalToken: z.string().optional(),
      confirm: z.string().optional()
    }
  }, async (input) => toToolResult(await workflow.applyPatch(input)));
  server.registerTool("run_checks", {
    description: "Preview and run only named package.json scripts with a guarded approval.",
    inputSchema: {
      projectPath: z.string().min(1),
      snapshot: z.object({ repoRoot: z.string(), head: z.string(), branch: z.string(), statusHash: z.string() }),
      scripts: z.array(z.string().min(1)).min(1),
      mode: z.enum(["preview", "execute"]),
      approvalToken: z.string().optional(),
      confirm: z.string().optional(),
      timeoutSeconds: z.number().positive().max(120).optional()
    }
  }, async (input) => toToolResult(await workflow.runChecks(input)));
  server.registerTool("commit_changes", {
    description: "Preview and commit only explicit changed paths with a guarded approval.",
    inputSchema: {
      projectPath: z.string().min(1),
      snapshot: z.object({ repoRoot: z.string(), head: z.string(), branch: z.string(), statusHash: z.string() }),
      paths: z.array(z.string().min(1)).min(1),
      message: z.string().min(1),
      mode: z.enum(["preview", "execute"]),
      approvalToken: z.string().optional(),
      confirm: z.string().optional()
    }
  }, async (input) => toToolResult(await workflow.commitChanges(input)));
  server.registerTool("push_changes", {
    description: "Preview and normally push the current branch to a configured remote with a guarded approval.",
    inputSchema: z.object({
      projectPath: z.string().min(1),
      snapshot: z.object({ repoRoot: z.string(), head: z.string(), branch: z.string(), statusHash: z.string() }),
      remote: z.string().min(1),
      branch: z.string().min(1),
      mode: z.enum(["preview", "execute"]),
      approvalToken: z.string().optional(),
      confirm: z.string().optional()
    }).strict()
  }, async (input) => toToolResult(await workflow.pushChanges(input)));
  server.registerTool("verify_github_pages", {
    description: "Read-only verification of the tracked GitHub branch, Pages build state, and optional public site URL.",
    inputSchema: z.object({
      projectPath: z.string().min(1),
      publicUrl: z.string().url().optional(),
      expectedText: z.string().min(1).optional(),
      timeoutSeconds: z.number().positive().max(60).optional()
    }).strict()
  }, async (input) => toToolResult(await workflow.verifyGithubPages(input)));
  return server;
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: student-portfolio-website-mcp [--help] [--version]

Tools: inspect_project, apply_patch, run_checks, commit_changes, push_changes, verify_github_pages
Confirmations: WRITE (apply_patch), RUN (run_checks), COMMIT (commit_changes), PUSH (push_changes)
`);
    return;
  }
  if (process.argv.includes("--version")) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const server = createServer(createWorkflow());
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
