# 1.1.4：复制文件或图片直接插入终端

Windows x64：便携版 `dist/ClaudeSessionManager-1.1.4-portable.exe`，安装版 `dist/ClaudeSessionManager-1.1.4-setup.exe`。

- 在资源管理器复制文件或图片后，按 Ctrl+V、Shift+Insert 或点击粘贴按钮，带引号的路径直接插入当前 Claude 输入框，无需再点“仅插入终端”，也不会自动提交。
- 附件记录仍显示在“已引用”中，可逐个移除或清空记录，不删除源文件；已插入终端的路径可像普通输入一样用退格/删除编辑。
- 选择文件、拖放和在待发送草稿文本框内的粘贴仍进入草稿，保持可编辑、可移除与去重。
- 包含 1.1.3 的文件链接核验、活动会话布局及此前全部修复。

源码验证：106 项单元测试、44 项隔离 Electron 集成检查通过，1 项可选性能基准跳过；类型检查与生产构建通过。

打包验证：核对包内版本及构建资源，检查 12 个原生终端的启动和退出。报告为 `.audit-backups/package-1.1.4.json`，校验值为 `dist/ClaudeSessionManager-1.1.4-SHA256.txt`。