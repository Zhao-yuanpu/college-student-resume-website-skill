[English](README.md) · [简体中文](README.zh-CN.md)

# Student Portfolio Website MCP

`student-portfolio-website-mcp` is a local stdio MCP server for safely working on student portfolio and resume websites. It keeps design judgment with your agent and user, while it inspects projects and performs explicitly approved Git and package-script steps.

## Prerequisites

- Node.js 18 or later, npm, Git, and an MCP-capable host.
- The target is a local Git repository. GitHub CLI is optional for GitHub Pages build-status checks.

Run without installing globally:

```powershell
npx -y student-portfolio-website-mcp
```

Or install it globally:

```powershell
npm install -g student-portfolio-website-mcp
student-portfolio-website-mcp
```

## Tools and safety

The server exposes exactly six tools:

- `inspect_project` — read a repository snapshot, package scripts, and constraint paths.
- `apply_patch` — validate and apply a unified patch to explicit paths.
- `run_checks` — run only named `package.json` scripts.
- `commit_changes` — stage and commit only explicit changed paths.
- `push_changes` — normally push the current configured branch and remote.
- `verify_github_pages` — read-only verification of branch, Pages state, and an optional public URL.

`apply_patch`, `run_checks`, `commit_changes`, and `push_changes` always use preview then execute. A preview returns a short-lived token bound to the current repository state and request. Execution also requires the exact confirmation: `WRITE`, `RUN`, `COMMIT`, or `PUSH` respectively. Tokens expire on changes or restart; no arbitrary commands, force pushes, credential files, or Git internals are supported.

The MCP host approval prompt remains the final authority. The server never authenticates npm or GitHub Pages: use your host, npm, Git, and GitHub CLI sign-in flows where needed.

## Preview and execute

Start with `inspect_project` and copy its snapshot unchanged into the next tool call. For example, preview two package checks:

```json
{
  "projectPath": "C:\\path\\to\\portfolio",
  "snapshot": {
    "repoRoot": "C:/path/to/portfolio",
    "head": "<head from inspect_project>",
    "branch": "main",
    "statusHash": "<statusHash from inspect_project>"
  },
  "scripts": ["test", "build"],
  "mode": "preview"
}
```

After reviewing the preview, repeat the same request with the returned token:

```json
{
  "projectPath": "C:\\path\\to\\portfolio",
  "snapshot": {
    "repoRoot": "C:/path/to/portfolio",
    "head": "<same inspected head>",
    "branch": "main",
    "statusHash": "<same inspected statusHash>"
  },
  "scripts": ["test", "build"],
  "mode": "execute",
  "approvalToken": "<token from preview>",
  "confirm": "RUN"
}
```

Tokens are single-use. If the repository or arguments change, inspect and preview again.

## Connect a host

### Codex

```powershell
codex mcp add student-portfolio -- npx -y student-portfolio-website-mcp
```

See [Codex MCP documentation](https://developers.openai.com/codex/mcp/).

### Claude Code

```powershell
claude mcp add --transport stdio student-portfolio -- npx -y student-portfolio-website-mcp
```

See [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Pi

Install the adapter:

```powershell
pi install npm:pi-mcp-adapter
```

Then create this project-level `.mcp.json` and restart Pi after installing the adapter:

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

See [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter).

### DeepSeek Harness

Add this row to the active Harness profile or overlay:

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

DeepSeek Harness exposes these as `mcp__student_portfolio__*`. See the [DeepSeek Harness official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md).

## Troubleshooting

- **`npx` is missing or cannot start the server:** run `node --version` and `npm --version`; install Node.js 18 or later and reopen the terminal if either command is unavailable. Use `npm view student-portfolio-website-mcp version` to distinguish registry/network access from MCP client configuration.
- **npm asks for authentication:** the public package does not require login to run. For publishing or a registry that requires an account, check `npm whoami`, then use `npm login`; the MCP never receives npm credentials.
- **Git push reports missing credentials:** verify the repository with `git -C C:\path\to\portfolio remote -v` and `git -C C:\path\to\portfolio ls-remote origin`. Authenticate Git normally (for GitHub CLI, `gh auth login` followed by `gh auth setup-git`) and preview `push_changes` again. Do not put tokens in tool input or remote URLs.
- **Pages verification is `partial`:** the branch or live URL check succeeded, but either no public URL was supplied or GitHub Pages build status was unavailable. Run `gh auth status`, restore repository/Pages access if needed, provide the public URL, and retry. `partial` is not proof that the Pages build completed.

## Optional skill

Clients that support skills can also install `building-student-portfolio-websites/SKILL.md`. With the package installed globally, copy it into Codex's user skill directory in PowerShell:

```powershell
$skillSource = Join-Path (npm root -g) "student-portfolio-website-mcp\building-student-portfolio-websites"
$skillParent = Join-Path $env:USERPROFILE ".codex\skills"
New-Item -ItemType Directory -Force $skillParent | Out-Null
Copy-Item $skillSource $skillParent -Recurse -Force
```

Restart the client after installation. For another skill-capable client, copy the same folder to that client's documented skills directory. The skill supplies project-specific judgment around confirmed designs, privacy, responsive motion, and separate edit/commit/push/deployment authority; the MCP tools carry out the guarded operations when available.




Forum：https://linux.do