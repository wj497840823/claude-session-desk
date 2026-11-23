# Git 变更面板设计

日期：2026-11-20
状态：已确认，待实现

## 1. 背景与目标

应用目前只能浏览和恢复 Claude 会话，无法感知项目本身的 Git 工作区状态。用户希望便捷地看到：

- 本次修改了多少文件；
- 哪些文件未被 Git 跟踪；
- 哪些文件已被跟踪但存在修改；
- 并能暂存、取消暂存和提交。

“本次修改”定义为：当前工作区相对 `HEAD` 的未提交变更（staged + unstaged），不包含已提交历史。

## 2. 范围

做：

- 项目栏展示变更徽章（唯一变更文件数、分组明细）。
- 点击徽章打开右侧 Git 面板：分支、上游差异、四组文件列表（冲突 / 已暂存 / 未暂存 / 未跟踪）。
- 按需加载 unified diff 预览。
- 暂存单个文件、取消暂存单个文件。
- 全部暂存、全部取消暂存。
- 提交已暂存内容，支持多行提交说明与“跳过 Git 钩子”。
- 冲突文件可通过“暂存”标记为已解决。
- 打开文件、在资源管理器中显示。

不做：

- 丢弃工作区修改（`discard` / `checkout` / `restore` / `clean`）。
- `reset --hard`、修改提交历史、amend。
- 拉取、推送、远程操作。
- hunk 级暂存。
- 仓库初始化、克隆、分支管理。

## 3. 总体架构

```
ProjectRail 徽章 ──┐
                   ├─> zustand store <── window.api ──> preload ──> IPC
GitPanel 面板 ─────┘        (status/diff/写操作)                    │
                                                                   v
                                                          GitService (main)
                                                                   │
                                                        execFile('git', [...])
```

- 主进程负责全部 Git 调用与路径校验。
- 渲染进程只能传 `projectKey` 与状态白名单中的相对路径。
- 项目路径由主进程从扫描索引 `index.projectPaths` 解析，沿用 `AppServices.getProjectPath()`。

## 4. 主进程

### 4.1 模块划分

- `src/main/gitPorcelain.ts`：纯函数解析器，不执行进程，便于单测。
- `src/main/gitGroup.ts`：纯函数，将文件条目分成四组并计算计数。
- `src/main/git.ts`：`GitService`，负责执行 git、缓存、串行化、路径校验。

### 4.2 Git 命令

所有命令使用 `execFile('git', args, options)`，参数数组形式，不经过 shell。

公共参数：

- `-c core.fsmonitor=false`：防止仓库配置触发 fsmonitor 外部命令。
- 环境变量 `GIT_OPTIONAL_LOCKS=0`：只读命令不写 index 锁。
- diff 命令额外加 `--no-ext-diff --no-textconv`：防止仓库配置的 external diff / textconv 执行命令。
- `windowsHide: true`，`maxBuffer` 有上限。

仓库根：

```
git -C <projectPath> rev-parse --show-toplevel
```

按项目路径缓存 60 秒。

状态：

```
git -C <repoRoot> status --porcelain=v2 --branch -z --untracked-files=all -- <项目相对路径|.>
```

路径统一以仓库根为基准，再转换为项目相对路径。项目位于 monorepo 子目录时，只统计该项目子树。

已暂存行数：

```
git -C <repoRoot> diff --numstat -z --cached -- <项目相对路径|.>
```

未暂存行数：

```
git -C <repoRoot> diff --numstat -z -- <项目相对路径|.>
```

不使用 `HEAD` 作为参数，以兼容尚无首次提交的空仓库。

Diff：

- 已暂存：`git -C <repoRoot> diff --cached --no-color --no-ext-diff --no-textconv -U3 -- <path>`
- 未暂存：`git -C <repoRoot> diff --no-color --no-ext-diff --no-textconv -U3 -- <path>`
- 未跟踪：`git -C <repoRoot> diff --no-index --no-color -U3 -- <NUL|/dev/null> <绝对路径>`
  - `--no-index` 在有差异时退出码为 1，视为成功。

写操作：

| 操作 | 命令 |
|---|---|
| 暂存文件 | `git -C <repoRoot> add -A -- <path> [origPath]` |
| 取消暂存 | `git -C <repoRoot> reset -q HEAD -- <path> [origPath]` |
| 全部暂存 | `git -C <repoRoot> add -A -- <非冲突路径列表>`（分批传入） |
| 全部取消暂存 | `git -C <repoRoot> reset -q HEAD -- <项目相对路径\|.>` |
| 提交 | `git -C <repoRoot> commit -m <message>`，可选 `--no-verify` |
| 取短哈希 | `git -C <repoRoot> rev-parse --short HEAD` |

说明：

- 取消暂存使用 `reset -q HEAD`，而不是 `restore --staged`；后者在尚无首次提交的仓库中会失败。
- `add -A` 可同时暂存删除与新增。
- 重命名条目在取消暂存时需同时传入新路径与原路径。
- “全部暂存”不包含冲突文件；冲突必须逐行点击“标记已解决”，避免一键把未解决的冲突误标记为已解决。

### 4.3 解析

`git status --porcelain=v2 --branch -z` 以 NUL 分隔：

| 前缀 | 含义 | 解析 |
|---|---|---|
| `# branch.*` | 分支 / oid / upstream / ahead-behind | 按行处理 |
| `1` | 普通变更 | 前 8 个空格字段后剩余为路径；XY 分别为 index/worktree 状态 |
| `2` | 重命名 / 复制 | 路径后紧跟一个 NUL 分隔的原路径 |
| `u` | 冲突 | 前 10 个字段后为路径 |
| `?` | 未跟踪 | 整行剩余 |
| `!` | 被忽略 | 丢弃 |

`--numstat -z` 格式：

- 普通：`添加\t删除\t路径\0`
- 重命名：`添加\t删除\t\0旧路径\0新路径\0`

### 4.4 缓存与并发

- 状态缓存 5 秒 TTL，同一项目单飞（并发请求合并）。
- 负结果（非仓库 / 未安装 git）缓存 60 秒。
- 批量状态查询并发上限 4，单项目超时 6 秒。
- 写操作按 `projectKey` 串行化，避免 `index.lock` 竞争。
- 写操作成功后立即失效该项目状态缓存与文件白名单。

### 4.5 超时与输出限制

| 命令 | 超时 | 输出上限 |
|---|---|---|
| `rev-parse` | 3s | 1MB |
| `status` | 6s | 8MB |
| `numstat` | 6s | 4MB |
| `diff` | 10s | 2MB |
| `add` / `reset` | 15s | 1MB |
| `commit` | 120s | 4MB |
| `rev-parse --short` | 3s | 1MB |

Diff 超过 4000 行或 2MB 时标记 `truncated`，面板显示截断提示。

### 4.6 错误分类

- `not-a-repo`：`rev-parse` 非零退出。
- `git-missing`：`ENOENT`。
- `timeout`：超时被杀。
- `failed`：其他非零退出。

不解析本地化 stderr 文本；错误消息仅作为展示用途。

## 5. 共享类型

```ts
export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange'

export interface GitFileEntry {
  path: string
  origPath?: string
  indexKind: GitChangeKind | null
  worktreeKind: GitChangeKind | null
  untracked?: boolean
  conflict?: boolean
  stagedAdditions?: number
  stagedDeletions?: number
  worktreeAdditions?: number
  worktreeDeletions?: number
  binary?: boolean
}

export interface GitStatus {
  projectKey: string
  isRepo: boolean
  repoRoot?: string
  branch: string | null
  oid: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileEntry[]
  counts: {
    files: number
    staged: number
    unstaged: number
    untracked: number
    unmerged: number
    modified: number
    added: number
    deleted: number
    renamed: number
  }
  truncated: boolean
  error?: { code: 'not-a-repo' | 'git-missing' | 'timeout' | 'failed'; message: string }
  scannedAt: number
}

export interface GitDiff {
  path: string
  diff: string
  binary: boolean
  truncated: boolean
  additions: number
  deletions: number
}

export interface GitCommitResult extends ActionResult {
  commit?: string
}
```

## 6. IPC

```
git:status        (projectKey, force?)
git:status-batch  (projectKeys[])
git:diff          (projectKey, path, group: 'staged' | 'unstaged' | 'untracked' | 'conflict')
git:file-action   (projectKey, path, 'open' | 'reveal')
git:stage-file    (projectKey, path)
git:unstage-file  (projectKey, path)
git:stage-all     (projectKey)
git:unstage-all   (projectKey)
git:commit        (projectKey, message, skipHooks)
```

参数校验：

- `projectKey` 必须能在索引中解析出路径。
- 批量项目数上限 50。
- 文件路径必须非绝对、不含 NUL、位于仓库根内，且出现在该项目最近一次 status 返回的白名单中。
- `unstage` 仅允许 `indexKind !== null` 的路径。
- 提交说明 `trim()` 后非空、长度 ≤ 8000、不含 NUL。
- 存在冲突时拒绝提交，返回“存在未解决的冲突”。

## 7. 渲染层

### 7.1 store

```ts
gitStatuses: Record<string, GitStatus>
gitPanelProject: string | null
setGitStatuses(list: GitStatus[]): void
openGitPanel(projectKey: string): void
closeGitPanel(): void
```

### 7.2 项目栏徽章

- 位置：项目名之后、会话数之前。
- 内容：`●N`，N 为唯一变更文件数；无变更不显示。
- 颜色：有冲突为红色；有已跟踪变更为琥珀色；仅未跟踪为蓝色。
- `title`：`已暂存 a · 未暂存 b · 未跟踪 c · 冲突 d`。
- 点击徽章 `stopPropagation()`，只打开面板。
- 非仓库、Git 未安装、本项目不存在时不显示。
- 右键菜单增加“查看 Git 变更”。

### 7.3 Git 面板

右侧抽屉，位于 `.workspace-pane` 内，宽 `min(620px, 46vw)`，带半透明遮罩，点击遮罩关闭。不改变现有三栏布局计算。

结构：

1. 头部：项目名、分支、`HEAD@短哈希`（分离 HEAD）、上游 ahead/behind、刷新、关闭。
2. 摘要：`N 个文件变更 · 已暂存 a · 未暂存 b · 未跟踪 c · 冲突 d`。
3. 四个可折叠分组：冲突 / 已暂存 / 未暂存 / 未跟踪。
4. 行：状态字母、路径（目录弱化）、`+/−`、展开 diff、行操作。
5. 提交区：多行输入、跳过钩子复选框、提交按钮、错误输出。
6. 空状态：无变更 / 非 Git 仓库 / Git 未安装 / 读取失败。

行操作：

- 已暂存组：`−` 取消暂存。
- 未暂存组、未跟踪组：`+` 暂存。
- 冲突组：`标记已解决`（执行 `add`）。
- 展开：按分组加载对应 diff。
- 文件操作：打开文件、在资源管理器中显示；已删除文件禁用“打开”。

提交区：

- 提交按钮仅在“有暂存变更 + 说明非空 + 无冲突 + 无进行中操作”时可用。
- `Ctrl/Cmd + Enter` 提交。
- 提交失败展示 git stderr。
- 成功后清空说明、刷新状态与徽章、toast 显示短哈希。

### 7.4 刷新策略

| 场景 | 行为 |
|---|---|
| 首次 snapshot 加载 | 对项目栏可见项目批量拉取状态 |
| 每 30 秒（窗口可见且聚焦） | 批量刷新徽章 |
| 窗口重新获得焦点 | 刷新徽章 |
| 面板打开 / 切换项目 | 立即刷新当前项目 |
| 面板打开期间 | 每 5 秒刷新当前项目（页面隐藏时暂停） |
| 手动刷新 | 刷新当前项目并清空 diff 缓存 |
| 任一写操作成功 | 强制刷新当前项目与徽章 |

只请求 `snapshot.projects` 中有活动会话的项目；批量上限 50。

## 8. 安全

- 渲染进程不能传任意路径；项目路径只从主进程索引取。
- 文件路径必须在最近一次 status 返回的白名单内，且限制在仓库根内。
- `execFile` 参数数组，禁止 shell。
- 只读命令通过 `core.fsmonitor=false`、`--no-ext-diff --no-textconv` 关闭仓库配置驱动的外部命令。
- 提交默认执行 Git 钩子（与命令行一致），超时 120 秒、`stdin` 关闭；面板提供“跳过 Git 钩子”复选框（`--no-verify`）。
- 写操作仅限 index 与 commit，不提供任何丢弃/回滚入口。

## 9. 边界情况

| 情况 | 处理 |
|---|---|
| Git 未安装 | 不显示徽章；打开面板提示“未检测到 Git”；负缓存 60 秒 |
| 项目不是仓库 | 不显示徽章；提示“该项目不是 Git 仓库” |
| monorepo 子目录 | 以仓库根执行，paths `-- <项目相对路径>` 限定子树，路径显示为项目相对路径 |
| 尚无首次提交 | numstat / diff 不带 `HEAD`；取消暂存用 `reset HEAD` |
| 分离 HEAD | `branch = null`，显示 `HEAD@abc1234` |
| 重命名 / 空格 / 中文路径 | `-z` 解析；取消暂存同时传新路径与原路径 |
| 文件被删除 | 仍显示 diff；“打开文件”禁用 |
| `MM` 文件 | 同时出现在已暂存与未暂存组，各自独立 diff |
| 冲突 | 单独分组；暂存即标记已解决；存在冲突时禁止提交 |
| 超大仓库或超时 | 返回 `timeout`，徽章显示未知，不阻塞 UI |
| 子模块 | 按普通修改展示，不递归 |
| CRLF 警告等 stderr | 忽略；只依据退出码与 stdout |

## 10. 测试

- `tests/gitPorcelain.test.ts`：分支头、普通、重命名、冲突、未跟踪、空格与中文路径、`MM`、`-z`、numstat 重命名。
- `tests/gitGroup.test.ts`：四组划分与计数。
- `tests/gitService.test.ts`（临时仓库）：
  - 状态、计数、重命名；
  - 暂存 / 取消暂存单个文件；
  - 空仓库取消暂存；
  - 全部暂存 / 全部取消暂存；
  - 提交成功并返回短哈希；
  - 空说明、无暂存内容、存在冲突时拒绝提交；
  - 白名单外路径被拒绝；
  - 并发两次暂存不产生 `index.lock` 错误。
- 手工验证：`npm run dev` 走完“修改 → 暂存 → 取消暂存 → 再暂存 → 提交”，确认徽章与面板同步。

## 11. 实施顺序

1. 共享类型与 IPC 通道。
2. `gitPorcelain.ts`、`gitGroup.ts` 与单测（先写测试）。
3. `GitService` 读操作 → 写操作（串行化、缓存失效）与集成测试。
4. 主进程接线、preload。
5. store 与刷新逻辑。
6. 项目栏徽章与右键菜单。
7. `GitPanel`（分组、diff、行操作、提交区）与样式。
8. `App.tsx` 挂载与轮询，typecheck、全量测试。

## 12. 已确认决策

- 展示入口：项目栏徽章 + 右侧抽屉面板。
- 功能范围：状态 + diff 预览 + 暂存/取消暂存 + 提交。
- 实现方式：调用系统 Git CLI。
- 提交默认执行钩子，提供跳过选项。
- 暂存/取消暂存按整文件操作，不做 hunk 级暂存。