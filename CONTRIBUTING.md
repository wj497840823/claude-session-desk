# 参与开发

推荐仓库名：`claude-session-desk`。应用界面名称为“Claude 会话管理器”。

## 本地开发

需要 Windows x64、Node.js 24+ 和 Git。使用锁文件安装依赖：

```powershell
npm ci
npm run dev
```

修改后运行：

```powershell
npm run typecheck
npm test
npm run build
node scripts/run-smoke.cjs
```

隔离集成测试使用临时目录、剪贴板及终端 IPC 替身，不需要登录 Claude，不向真实对话发送测试消息。性能基准默认跳过。运行应用内真实对话时，需要自行安装并登录 Claude Code CLI。

## 提交变更

- 描述具体触发条件、修改后的行为和验证结果。
- 只提交相关源码、测试和文档，保留 package-lock.json。
- 不提交真实会话 JSONL、附件、用户目录、账号、令牌、核查备份或编译产物。调试样例使用虚构路径与内容。
- 依赖变化后运行 `node scripts/generate-third-party-notices.cjs` 更新依赖声明。
- 二进制放在 GitHub Releases；源码仓库保持可构建。

## 打包

```powershell
node scripts/generate-third-party-notices.cjs
npm run package
node scripts/verify-package.cjs
```

默认生成 Windows x64 便携版、安装版和 ZIP。许可证与第三方声明包含在新的应用包内。Electron 自带的 `LICENSE.electron.txt`、`LICENSES.chromium.html` 和 node-pty 的第三方许可仍需保留。

本项目按 [MIT](LICENSE) 开源；依赖保留各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
