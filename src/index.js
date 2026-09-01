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
    content: [{ type: "text", text: result.summary }],
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
  return server;
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: student-portfolio-website-mcp [--help] [--version]\n");
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
