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
