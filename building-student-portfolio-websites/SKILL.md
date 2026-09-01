---
name: building-student-portfolio-websites
description: Use when building or improving a student portfolio or personal resume website with approved visual references, responsive motion, static-file compatibility, or GitHub Pages delivery.
---

# 构建大学生个人简历网站

## 核心原则

把用户确认的内容与设计稿当作视觉事实，把实际文件树当作技术事实。先查证，再做最小改动；编辑、提交、推送和部署是不同权限。

## MCP 工具

当 `inspect_project`、`apply_patch`、`run_checks`、`commit_changes`、`push_changes` 和 `verify_github_pages` 可用时，优先使用它们执行本 skill 的受控工作流。每次写入先预览，获得对应阶段授权后再执行；MCP 不替代设计判断，也不扩大用户对编辑、提交、推送或部署的授权。

## 开始前

1. 定位真正的 Git 仓库、入口文件、构建脚本、生成产物和部署方式；不要根据外层文件夹名猜路径。
2. 搜索已确认设计、内容来源、隐私要求和 README 中的交付约束。若设计稿在仓库外，也要纳入检查。
3. 查看 `git status --short`，记录已有删除、修改和未跟踪文件；它们默认不属于本次任务。
4. 说明假设与成功标准。已有确认稿时做忠实实现；没有确认方向时先给少量方案，得到同意再编码。

## 实现约束

- 复用现有组件、样式、动效入口和已安装依赖。不要借“优化”重做相邻页面。
- 不添加确认稿中没有的通用装饰、章节轨道、计数器或箭头。个人经历、奖项和联系方式只能来自用户证据，并持续满足隐私要求。
- React 动效优先修改现有动效所有者；使用 `transform`/`opacity`，清理 scope、observer 和监听器，并支持 `prefers-reduced-motion`。
- hover 信息也必须能通过键盘 focus 获取；触屏端不得依赖永久 hover。保持可见焦点与足够对比度。
- 若网站承诺可直接打开 `index.html`，使用相对资源路径并实际验证 `file://`；不要只验证开发服务器。

## 最小验收矩阵

| 范围 | 必查项 |
| --- | --- |
| 自动化 | 现有测试通过，生产构建成功，生成产物已更新 |
| 视觉 | 桌面与约 390px 手机，对照确认稿而非主观判断 |
| 交互 | hover、focus、键盘、触屏、减少动态效果 |
| 运行 | 控制台无新增错误或警告；目标入口与资源可加载 |
| Git | 只显式暂存本次文件，检查暂存差异与空白错误 |

非平凡逻辑至少留下一个能因回归而失败的最小检查。验证失败时修根因，不通过改测试掩盖问题。

## 提交与发布

只有获得相应授权才执行 commit、push 或部署。提交前确认暂存范围；认证失败时恢复正常凭据，不强推。

“发布到 GitHub”不自动等于“部署网站”。若用户明确要求 GitHub Pages，上线完成必须同时满足：远端分支含目标提交、Pages 构建成功、线上 HTTP 可访问、预期标题或新内容存在。报告每一阶段结果，并列出保留在工作树中的无关改动。

## 常见错误

- 在仓库外运行 Git：先定位 `.git` 边界。
- 假设组件路径：先列出真实源码树并查找调用者。
- 广泛暂存：按文件暂存，保留用户原有工作。
- 只看整站风格：逐页对照已批准构图。
- 本地构建成功就宣称上线：继续验证远端、部署状态和线上内容。
