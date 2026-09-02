[English](README.md) · [简体中文](README.zh-CN.md)

# 大学生个人简历网站 MCP

`student-portfolio-website-mcp` 是一个本地 stdio MCP 服务器，用于安全地制作和维护大学生作品集与个人简历网站。它把设计判断留给你的智能体和你本人，同时负责检查项目，并执行经过明确批准的 Git 与 npm 脚本操作。

## 前置要求

- Node.js 18 或更高版本、npm、Git，以及支持 MCP 的客户端。
- 目标必须是本地 Git 仓库。GitHub CLI 不是必需项，仅用于检查 GitHub Pages 构建状态。

无需全局安装，直接运行：

```powershell
npx -y student-portfolio-website-mcp
```

或者全局安装：

```powershell
npm install -g student-portfolio-website-mcp
student-portfolio-website-mcp
```

## 工具与安全机制

服务器一共提供六个工具：

- `inspect_project` — 读取仓库快照、npm scripts 和约束路径。
- `apply_patch` — 校验并应用到明确路径的 unified diff。
- `run_checks` — 只运行 `package.json` 中指定的脚本。
- `commit_changes` — 只暂存并提交明确指定的变更路径。
- `push_changes` — 通常推送当前配置的分支和远程仓库。
- `verify_github_pages` — 只读检查分支、Pages 状态和可选的公开网址。

`apply_patch`、`run_checks`、`commit_changes` 和 `push_changes` 始终采用“预览 → 执行”流程。预览会返回一个与当前仓库状态和请求绑定的短期令牌；执行时还必须提供精确确认词：分别是 `WRITE`、`RUN`、`COMMIT` 或 `PUSH`。仓库发生变化或客户端重启后令牌会失效；服务器不支持任意命令、强制推送、凭据文件或 Git 内部操作。

MCP 客户端的批准提示仍然是最终权限来源。服务器不会替你登录 npm 或 GitHub Pages；需要账号时，请使用各自客户端、npm、Git 和 GitHub CLI 的正常登录流程。

## 预览与执行

先调用 `inspect_project`，再把它返回的快照原样复制到下一次工具调用中。例如，预览两个 npm 检查脚本：

```json
{
  "projectPath": "C:\\path\\to\\portfolio",
  "snapshot": {
    "repoRoot": "C:/path/to/portfolio",
    "head": "<inspect_project 返回的 head>",
    "branch": "main",
    "statusHash": "<inspect_project 返回的 statusHash>"
  },
  "scripts": ["test", "build"],
  "mode": "preview"
}
```

检查预览结果后，使用返回的令牌重复同一个请求：

```json
{
  "projectPath": "C:\\path\\to\\portfolio",
  "snapshot": {
    "repoRoot": "C:/path/to/portfolio",
    "head": "<同一个 head>",
    "branch": "main",
    "statusHash": "<同一个 statusHash>"
  },
  "scripts": ["test", "build"],
  "mode": "execute",
  "approvalToken": "<预览返回的令牌>",
  "confirm": "RUN"
}
```

令牌只能使用一次。如果仓库或参数发生变化，请重新检查并预览。

## 连接客户端

### Codex

在 PowerShell 中运行：

```powershell
codex mcp add student-portfolio -- npx -y student-portfolio-website-mcp
```

参见 [Codex MCP 文档](https://developers.openai.com/codex/mcp/)。

### Claude Code

在 PowerShell 中运行：

```powershell
claude mcp add --transport stdio student-portfolio -- npx -y student-portfolio-website-mcp
```

参见 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)。

### Pi

先安装适配器：

```powershell
pi install npm:pi-mcp-adapter
```

然后在项目根目录创建 `.mcp.json`，安装适配器后重启 Pi：

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

参见 [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter)。

### DeepSeek Harness

把下面这一项加入当前 Harness 配置或 overlay：

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

DeepSeek Harness 中的工具名称会显示为 `mcp__student_portfolio__*`。参见 [DeepSeek Harness 官方 MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)。

## 故障排查

- **找不到 `npx` 或无法启动服务器：** 运行 `node --version` 和 `npm --version`；如果任一命令不可用，请安装 Node.js 18 或更高版本并重新打开终端。使用 `npm view student-portfolio-website-mcp version`，可以区分 npm 仓库/网络问题和 MCP 客户端配置问题。
- **npm 要求登录：** 运行公开包不要求登录。发布包或访问要求账号的仓库时，先检查 `npm whoami`，再使用 `npm login`；MCP 不会接触 npm 凭据。
- **Git 推送提示缺少凭据：** 用 `git -C C:\path\to\portfolio remote -v` 和 `git -C C:\path\to\portfolio ls-remote origin` 检查仓库。按正常方式认证 Git（GitHub CLI 使用 `gh auth login`，随后运行 `gh auth setup-git`），然后重新预览 `push_changes`。不要把令牌放进工具参数或远程网址。
- **Pages 检查结果为 `partial`：** 分支或公开网址检查成功，但没有提供公开网址，或 GitHub Pages 构建状态暂时不可用。运行 `gh auth status`，恢复仓库/Pages 权限（如有需要），提供公开网址后重试。`partial` 不代表 Pages 构建已经完成。

## 可选技能

支持技能的客户端还可以安装 `building-student-portfolio-websites/SKILL.md`。全局安装 npm 包后，在 PowerShell 中复制到 Codex 用户技能目录：

```powershell
$skillSource = Join-Path (npm root -g) "student-portfolio-website-mcp\building-student-portfolio-websites"
$skillParent = Join-Path $env:USERPROFILE ".codex\skills"
New-Item -ItemType Directory -Force $skillParent | Out-Null
Copy-Item $skillSource $skillParent -Recurse -Force
```

安装后重启客户端。对于其他支持技能的客户端，请将同一个文件夹复制到该客户端文档指定的技能目录。该技能提供已确认设计、隐私、响应式动效，以及编辑/提交/推送/部署权限分离方面的项目判断；可用时由 MCP 工具执行受保护的操作。
