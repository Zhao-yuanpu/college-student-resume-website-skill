# 大学生个人简历网站 Skill

这是一个面向 Codex 的网页制作 skill，用于构建或优化大学生个人简历、作品集与个人主页。

它总结了真实项目中最容易被忽略的部分：严格对照已确认设计、保护个人信息、精准修改 React 与动效代码、兼容桌面和手机、保留键盘与减少动态效果支持，以及安全完成 Git 和 GitHub Pages 交付。

## 仓库结构

```text
building-student-portfolio-websites/
└── SKILL.md
```

## 安装

### 方式一：让 Codex 安装

在 Codex 中发送：

```text
请从 https://github.com/Zhao-yuanpu/college-student-resume-website-skill 安装 building-student-portfolio-websites skill。
```

### 方式二：Windows 手动安装

在 PowerShell 中执行：

```powershell
git clone "https://github.com/Zhao-yuanpu/college-student-resume-website-skill.git"

$skillRoot = Join-Path $env:USERPROFILE ".codex\skills"
$skillTarget = Join-Path $skillRoot "building-student-portfolio-websites"

New-Item -ItemType Directory -Force -Path $skillRoot | Out-Null
if (Test-Path -LiteralPath $skillTarget) {
    throw "目标 skill 已存在：$skillTarget"
}

Copy-Item -Recurse -LiteralPath ".\college-student-resume-website-skill\building-student-portfolio-websites" -Destination $skillTarget
```

安装后，该 skill 会在 Codex 的下一轮对话中可用。

## 使用

可以显式调用：

```text
使用 $building-student-portfolio-websites，按我确认的设计稿优化这个个人简历网站。先检查现有项目并给出方案，得到同意后再修改。
```

也可以直接描述需求；当任务涉及学生个人网站、简历网站、已确认视觉稿、响应式动效或 GitHub Pages 交付时，Codex 可以自动选择它。

## 主要能力

- 在编码前定位真实仓库、文件结构、内容证据与隐私边界
- 忠实实现已确认设计，避免无依据的通用装饰
- 精准处理 React、Anime.js、GSAP 或 Three.js 动效
- 验证桌面、390px 手机、键盘、触屏和减少动态效果
- 区分编辑、提交、推送与部署权限
- 验证 GitHub Pages 构建状态和线上内容

本仓库只提供工作方法，不包含个人简历资料、证书、联系方式或原网站源码。
