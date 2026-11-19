# 首次开源与 GitHub 发布

项目名称：**Claude Session Desk**；仓库名：**claude-session-desk**；中文介绍：**面向 Windows 的 Claude Code 会话工作台，支持项目导航、会话管理、内嵌对话与文件附件。**

项目仓库：[wj497840823/claude-session-desk](https://github.com/wj497840823/claude-session-desk)。以下流程也可用于自己的 fork；先检查当前分支、提交和远程地址，跳过已完成的初始化步骤。

本指南说明源码上传和二进制发布流程。仓库所有者由你登录的 GitHub 账号决定。

## 本地已准备

- 主分支名为 `main`；首次提交前配置自己的 Git 作者身份，首次推送前确认远程地址。
- `.gitignore` 排除依赖、构建目录、EXE、审计备份、内部开发记录、凭据文件与本机会话数据。
- 沿用 package.json 的 MIT 声明，补齐根目录 `LICENSE`；第三方依赖许可保存在 `THIRD_PARTY_NOTICES.md`，可用脚本更新。
- 补充贡献说明和 Windows CI；CI 执行安装、类型检查、单元测试、生产构建及隔离集成测试。
- 公开调试文档使用匿名化文件名，不附带真实会话或本机核查报告。

复查当前公开文件与生成干净源码压缩包：

```powershell
git status --short
git diff --cached --stat
node scripts/prepare-open-source.cjs
```

压缩包位于 `release-source/claude-session-desk-1.1.7-source.zip`，清单和 SHA256 位于同目录的 `source-manifest.json`。导出内容来自 Git 暂存区；修改源码后先 `git add`，再重新导出。检查脚本只报告问题类型、文件和行号，不打印可能的凭据内容。该检查是发布辅助，不替代人工复查。

## 1. 登录方式

如果曾在聊天、文档或命令中明文发送密码，先自行更换密码。不要把新密码、令牌或恢复码发给协作者，也不要写到 remote URL、仓库文件或脚本里。

GitHub 的 Git 推送不使用账号密码认证。推荐安装 GitHub CLI，然后通过网页授权；授权信息由 CLI 保存在本机。[GitHub CLI 登录说明](https://cli.github.com/manual/gh_auth_login)、[GitHub 认证方式](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github)。

```powershell
winget install --id GitHub.cli --exact --source winget
```

安装后重新打开 PowerShell，在项目目录中运行：

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh auth status
```

按提示在浏览器完成授权。这里不需要把密码或 token 提供给自动化助手。

## 2. 首次提交

先确认 Git 作者身份。未配置时，在当前仓库设置姓名和邮箱；下例的值必须替换为你自己的信息。若不公开邮箱，可从 GitHub Settings → Emails 复制 GitHub 提供的 noreply 地址。

```powershell
git config user.name "你的 GitHub 用户名"
git config user.email "从 GitHub 邮箱设置复制的 noreply 地址"
```

检查、暂存并提交：

```powershell
git add .
git diff --cached --stat
node scripts/prepare-open-source.cjs
git commit -m "Initial open-source release"
```

`.audit-backups/`、真实会话数据、`node_modules/`、`out/`、`dist/`、内部工作记录和 `release-source/` 不应出现在提交列表中。

## 3. 创建公开仓库并推送

网页登录确认是你要使用的账号后执行：

```powershell
gh repo create claude-session-desk --public --source . --remote origin --push
gh repo view --web
```

此命令会真正创建 Public 仓库并推送当前分支，执行前先复查暂存区和首次提交。如果账号下已存在同名仓库，先确认目标；不要用强制推送覆盖已有内容。[本地项目首次上传说明](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)。

也可以从 [GitHub 新建仓库](https://github.com/new) 创建 `claude-session-desk`，选择 Public，不勾选自动生成 README、许可证和 gitignore。然后在项目目录执行（先替换用户名）：

```powershell
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/claude-session-desk.git
git push -u origin main
```

只选择上面一种创建方式。如果 CLI 已添加 `origin`，无需再次添加。

## 4. EXE 放入 Releases

源码通过 Git 管理，便携版、安装版、ZIP 和校验值作为 Release 附件分发，不加入 Git 提交。[GitHub Releases 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[大文件说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)。

公开发布二进制前，按包含许可证的打包配置重新构建，确保发布的 EXE 对应当前源码和依赖声明。

```powershell
node scripts/generate-third-party-notices.cjs
npm run typecheck
npm test
npm run build
node scripts/run-smoke.cjs
npx electron-builder --win portable nsis --x64
node scripts/verify-package.cjs
```

生成与当前 EXE 对应的校验值（保持这些实际输出文件名）：

```powershell
$releaseVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$releaseFiles = @(
  "dist/ClaudeSessionDesk-$releaseVersion-portable.exe",
  "dist/ClaudeSessionDesk-$releaseVersion-setup.exe"
)
Get-FileHash -LiteralPath $releaseFiles -Algorithm SHA256 |
  ForEach-Object { '{0}  {1}' -f $_.Hash, (Split-Path $_.Path -Leaf) } |
  Set-Content "dist/ClaudeSessionDesk-$releaseVersion-SHA256.txt" -Encoding ascii
```

将最新源码和依赖声明提交并推送后，创建首个版本标签与草稿 Release：

```powershell
git add .
git commit -m "Prepare public release"
git push
git tag v1.1.7
git push origin v1.1.7
gh release create v1.1.7 --draft --verify-tag --title "Claude Session Desk 1.1.7" --notes-file docs/release-1.1.7.md
gh release upload v1.1.7 dist/ClaudeSessionDesk-1.1.7-portable.exe dist/ClaudeSessionDesk-1.1.7-setup.exe dist/ClaudeSessionDesk-1.1.7-SHA256.txt LICENSE THIRD_PARTY_NOTICES.md
```

如果没有新改动，则跳过第二次 `git commit`。在 GitHub Release 草稿页复核附件、说明和校验值，再发布。已公开的 tag 和附件建议保持不变；以后修复递增版本号，避免同版本不同内容。

## 后续更新

```powershell
git add .
git diff --cached --stat
git commit -m "Describe the change"
git push
```

新增依赖时同步更新锁文件与第三方声明；发布前运行现有检查。截图、Issue 和日志请使用虚构会话，隐藏令牌、个人目录和业务内容。
