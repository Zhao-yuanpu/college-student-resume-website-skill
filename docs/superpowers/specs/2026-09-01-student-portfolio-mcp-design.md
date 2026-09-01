# Student Portfolio Website MCP Design

## 用户审阅摘要

本次把现有网页 skill 升级为公开 npm 包 `student-portfolio-website-mcp`。它不绑定 DeepSeek、Codex 或 Claude 等模型，而是让用户正在使用的代理生成修改方案，再由 MCP 以受控方式扫描项目、应用补丁、运行测试、提交、普通推送并验证 GitHub Pages。

MCP 只提供六个工具：项目扫描、补丁修改、测试构建、Git 提交、Git 推送和 Pages 验证。修改、运行脚本、提交与推送都必须先预览，再分别使用 `WRITE`、`RUN`、`COMMIT`、`PUSH` 确认。它不能执行任意命令，不能强推，不能修改 Git 内部文件、密钥或凭据，也不能越出项目目录。

README 将提供 PowerShell npm 安装，以及 Pi、DeepSeek Harness、Codex、Claude Code 四套配置。包使用 MIT 许可证和 Node.js 18+，通过 npm 公开发布。当前 npm 包名可用，但发布前需要用户完成一次 npm 网页登录。

实现采用两个源码文件和一个测试文件，不增加内置模型、HTTP 服务、遥测、自动更新、GitHub Release 或无实际用途的脚手架。完整测试和打包检查通过后，才允许提交、推送和发布 npm。

## Goal

Turn the existing student-portfolio website skill into a public, cross-harness npm MCP server that can inspect, edit, validate, commit, push, and verify GitHub Pages projects through explicit staged approvals.

The package will be named `student-portfolio-website-mcp`, use the MIT license, require Node.js 18 or newer, and run as a local stdio server. The existing `SKILL.md` remains useful to clients that support skills, but every operational capability is exposed as an MCP tool so DeepSeek Harness can use it.

## Non-goals

- Do not embed DeepSeek, OpenAI, Anthropic, or any other model API.
- Do not provide arbitrary shell execution, generic filesystem access, force-push, branch deletion, remote replacement, or credential management.
- Do not silently configure GitHub Pages, purchase domains, or deploy to providers other than an already configured GitHub Pages site.
- Do not treat file count, generated boilerplate, or decorative documentation as professionalism.

## Package Layout

```text
src/index.js
src/workflow.js
tests/workflow.test.js
package.json
package-lock.json
.gitignore
README.md
LICENSE
building-student-portfolio-websites/SKILL.md
docs/superpowers/specs/2026-09-01-student-portfolio-mcp-design.md
```

`src/index.js` registers schemas and starts the stdio MCP server. `src/workflow.js` contains testable project, filesystem, process, Git, and Pages operations. The implementation uses ESM JavaScript and Node's built-in test runner; no TypeScript build or generated `dist/` directory is needed.

The only runtime dependencies are the current MCP SDK and its required schema dependency. Standard library APIs handle paths, hashing, files, and child processes.

## Tool Contract

All tools return a structured result:

```json
{
  "ok": true,
  "phase": "commit",
  "summary": "Committed 4 explicit paths",
  "evidence": [],
  "nextAction": "Preview push_changes before publishing"
}
```

### `inspect_project`

Input: `projectPath`.

Find the real Git root, HEAD, branch, remote, worktree status, package scripts, likely source/build directories, deployment hints, approved-design files, README delivery promises, and privacy-related evidence paths. It must ignore `.git`, dependency folders, large generated bundles, and binary files. Personal content is not returned; the report contains paths and constraint summaries only.

The result includes a snapshot containing the current HEAD and a deterministic worktree-status hash. Mutating tools recompute both and reject stale snapshots.

### `apply_patch`

Input: `projectPath`, snapshot, unified patch, explicit allowed paths, mode, and optional approval token.

In `preview` mode, validate every patch path, reject protected files, run `git apply --check`, summarize the planned files, and return a short-lived approval token. In `execute` mode, require that token plus `confirm: "WRITE"`, revalidate the snapshot and patch, then apply it once.

Successful execution returns a fresh snapshot for the next phase.

### `run_checks`

Input: `projectPath`, snapshot, package-script names, mode, and optional approval token.

Only scripts already present in `package.json` may run. Preview shows the exact commands. Execute requires `confirm: "RUN"`, uses bounded timeouts and output limits, and reports each exit code. There is no arbitrary command field.

Because project scripts may update generated assets, successful execution returns a fresh snapshot.

### `commit_changes`

Input: `projectPath`, snapshot, explicit paths, commit message, mode, and optional approval token.

Preview verifies the path list and displays the proposed commit scope without altering the index. Any pre-existing staged path outside the explicit list rejects the operation. Execute requires `confirm: "COMMIT"`, stages only those paths, runs the cached-diff whitespace check, and creates a normal commit. Amend, hooks bypass, all-files staging, and empty commits are unsupported. Success returns the new HEAD and a fresh snapshot.

### `push_changes`

Input: `projectPath`, snapshot, remote, branch, mode, and optional approval token.

Preview verifies that the configured remote and local branch match the request and shows the exact refspec. Execute requires `confirm: "PUSH"` and performs a normal push only. Force options, ref deletion, remote creation, and remote URL changes are unsupported. Success returns remote evidence and a fresh snapshot.

### `verify_github_pages`

Input: `projectPath`, optional public URL, optional expected text, and bounded timeout.

Compare local HEAD with the tracked remote, query Pages build state when authenticated GitHub CLI access is available, and verify the public URL plus optional expected content. If build-state access is unavailable, return a clearly labeled partial result rather than guessing. This tool is read-only and does not require an approval token.

## Approval and Safety Model

Every mutating operation is two-phase: preview, then execute. Preview returns an in-memory, expiring approval token bound to the project root, snapshot, parameters, and operation. A changed HEAD, changed worktree status, changed arguments, expired token, or server restart invalidates it.

The confirmation words are fixed:

| Operation | Confirmation |
| --- | --- |
| Apply patch | `WRITE` |
| Run package scripts | `RUN` |
| Commit | `COMMIT` |
| Push | `PUSH` |

These tokens make stage boundaries visible but cannot prove a human personally typed them. The MCP host's own tool-approval UI remains the final authorization boundary, and the README must say so explicitly.

All target paths are resolved against the real repository root. Existing targets use `realpath`; new targets validate the nearest existing parent. Reject absolute patch paths, `..` traversal, symlink escape, `.git` internals, `.env` files other than `.env.example`, private keys, and common credential files.

Subprocesses use argument arrays without shell interpolation. Output is length-limited and redacts values associated with token, password, secret, and key names. Mutating failures stop immediately and are never automatically retried.

## Cross-harness Installation

The README provides a PowerShell prerequisite and one stdio command shared by every client:

```powershell
npx -y student-portfolio-website-mcp
```

It also documents global installation for users who prefer it:

```powershell
npm install -g student-portfolio-website-mcp
student-portfolio-website-mcp
```

### Codex

```powershell
codex mcp add student-portfolio -- npx -y student-portfolio-website-mcp
```

### Claude Code

```powershell
claude mcp add --transport stdio student-portfolio -- npx -y student-portfolio-website-mcp
```

### Pi

Install the MCP adapter:

```powershell
pi install npm:pi-mcp-adapter
```

Then add the server to project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "student-portfolio": {
      "command": "npx",
      "args": ["-y", "student-portfolio-website-mcp"]
    }
  }
}
```

Restart Pi after installing the adapter.

### DeepSeek Harness

Add an official MCP-client row to the active harness profile or overlay:

```yaml
- id: mcp-student-portfolio
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: student_portfolio
    transport: stdio
    command: npx
    args: ['-y', 'student-portfolio-website-mcp']
    toolCallTimeoutMs: 120000
```

DeepSeek Harness exposes the tools under the `mcp__student_portfolio__*` namespace. Its current MCP client bridges tools but not MCP resources or prompts, which is why the server does not depend on those surfaces.

## README and Skill Updates

The README will lead with the npm MCP rather than the Codex skill. It will contain:

- capabilities and safety boundaries;
- Node.js and Git prerequisites;
- PowerShell npm installation;
- Pi, DeepSeek Harness, Codex, and Claude Code setup;
- tool reference and preview/execute examples;
- troubleshooting for `npx`, npm authentication, Git credentials, and unavailable Pages status;
- a short section for installing the optional Codex-compatible `SKILL.md`.

The skill will be updated to prefer the MCP tools when available while keeping its judgment guidance useful without the server. It will not claim the MCP can independently generate design decisions or code.

## Testing

Use TDD with Node's built-in test runner. The minimum suite covers:

- real Git-root discovery and deterministic snapshots;
- path traversal, symlink escape, `.git`, secret-file, and protected-file rejection;
- stale snapshots and invalid/expired approval tokens;
- patch preview, `git apply --check`, and one-time execution;
- package-script allowlisting, timeout, output truncation, and failure propagation;
- explicit staging that preserves unrelated tracked and untracked files;
- commit refusal on whitespace errors or empty scope;
- push argument construction that cannot express force or deletion;
- Pages full, partial, failed, and timeout reports through injected command/HTTP adapters;
- MCP stdio smoke test that connects, lists all six tools, and calls `inspect_project` against a fixture repository.

Before release, run:

```powershell
npm test
npm pack --dry-run
```

The packed file list must contain the executable source, package metadata, license, README, and optional skill, while excluding tests, local notes, credentials, and design artifacts not needed at runtime.

## Release and Verification

The package starts at `1.0.0`. The npm name is currently available, but this machine is not authenticated to npm. Publication therefore pauses for interactive `npm login` before the final release step.

Release order:

1. Run the full tests and package dry run.
2. Inspect Git status and the complete diff.
3. Explicitly stage the intended files and run the cached-diff check.
4. Commit and push the GitHub repository after authorization.
5. Run `npm publish --access public` after npm authentication and explicit publication authorization.
6. Verify `npm view student-portfolio-website-mcp`, run the published package through a temporary MCP client, and confirm the six-tool roster.
7. Re-read the GitHub README and compare the remote commit with local HEAD.

No GitHub tag, release page, CI workflow, telemetry, HTTP transport, configuration generator, or embedded updater is included in this first release. Add them only when real usage shows a need.

## Configuration Sources

- [Codex MCP documentation](https://developers.openai.com/codex/mcp/)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter)
- [DeepSeek Harness official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/mcp/mcp-client/README.md)
