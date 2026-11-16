# 1.1.2：文件粘贴、附件草稿与操作修复

Windows x64：便携版 `dist/ClaudeSessionManager-1.1.2-portable.exe`，安装版 `dist/ClaudeSessionManager-1.1.2-setup.exe`。

- 支持资源管理器复制文件后 Ctrl+V 或 Shift+Insert；复制的图片文件保留原路径，截图另存 PNG。
- 附件先进入可编辑的待发送草稿，支持去重、逐个移除与清空；点击发送或 Ctrl+Enter 提交，也可仅插入终端。
- 写入或移除失败保留草稿/引用，关闭再打开会话恢复未发送草稿；附件记录可清空，保留原文件与历史答复链接。
- 活动会话、收藏可再次点击收起；历史记录收起同步隐藏列表。
- 修复新建对话项目目录、标签切换残留菜单/拖放遮罩、窄窗口标题和附件清空按钮可见性。

源码验证：100 项单元测试、40 项隔离 Electron 集成检查通过，1 项可选性能基准跳过；类型检查、生产构建通过。打包验证核对版本与构建资源，并测试 12 个原生终端的启动和退出；报告为 `.audit-backups/package-1.1.2.json`。

校验值：`dist/ClaudeSessionManager-1.1.2-SHA256.txt`。
