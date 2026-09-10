# First portfolio task / 第一次制作个人网站

This walkthrough uses fictional data only. Replace it with verified information before editing a real website.

本示例只使用虚构资料。制作真实网站前，请替换为已经核实的内容。

## 1. Give the host a bounded request / 提出范围明确的请求

```text
Inspect this local Git repository first. The site is for “Lin Yue”, a fictional
first-year computer science student. Use only these facts: “Interested in
frontend accessibility”, “Built one class project”, and “Looking for a summer
practice opportunity”. Propose a single-page resume layout for desktop and
390px mobile. Do not edit, commit, push, or deploy until I approve each preview.
```

## 2. Expected workflow / 预期流程

1. `inspect_project` reports the actual repository root, scripts, existing design evidence, and privacy constraints.
2. The host proposes a minimal page and calls `apply_patch` in `preview` mode. Review the file list before approving `WRITE`.
3. Run the named test/build scripts through `run_checks` and approve `RUN` only after reviewing the commands.
4. Check keyboard focus, reduced motion, desktop layout, and a 390px viewport. Then preview `commit_changes` and approve `COMMIT`.
5. Push only after reviewing the branch and remote in the `push_changes` preview. Approve `PUSH`, then use `verify_github_pages` with the public URL and expected page title.

## 3. What success looks like / 成功标准

- The page uses only the verified fictional facts and does not expose private identifiers.
- Desktop and mobile layouts remain usable; hover-only information is also reachable by keyboard focus.
- Reduced-motion preferences are respected and the console has no new errors.
- Each write, check, commit, and push has a visible preview and the matching confirmation.
- Pages verification matches the commit that was just pushed before calling the site released.
