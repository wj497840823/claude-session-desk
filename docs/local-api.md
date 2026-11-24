# 本地 HTTP 接口

默认关闭。打开「设置 → 启用本地 HTTP 接口」并保存后，应用会在 `127.0.0.1` 启动一个随机端口，设置页会显示接口地址和 Bearer Token。

- 只监听回环地址，不对局域网或公网开放。
- 所有请求都需要 `Authorization: Bearer <token>`。
- Token 保存在应用数据目录的 `local-api-token`；删除该文件后重启会生成新 Token。
- 应用退出后接口停止；需要应用保持运行（可隐藏到托盘）。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/health` | 健康检查 |
| GET | `/v1/status` | 版本、任务、待处理数量、用量 |
| GET | `/v1/tasks` | 任务列表 |
| GET | `/v1/inbox` | 待处理收件箱（审批、提问、任务结果） |
| GET | `/v1/usage` | 定时任务用量 |
| POST | `/v1/tasks/:id/run` | 立即运行一次 |
| POST | `/v1/tasks/:id/pause` | 暂停；`{"minutes":60}` 或 `{"until":时间戳,"reason":"..."}` |
| POST | `/v1/tasks/:id/resume` | 恢复 |
| POST | `/v1/tasks/:id/replay` | 补跑暂停期间跳过的触发 |
| POST | `/v1/approvals/:id` | 回答权限审批；`{"decision":"allow"}` 或 `"deny"` |
| POST | `/v1/asks/:taskId` | 回答任务提问；`{"choice":0}` 或 `{"text":"回答"}` |
| POST | `/v1/asks/:taskId/ignore` | 忽略本次提问 |
| POST | `/v1/events` | 提交外部事件，触发匹配的事件任务 |

## 示例

```bash
TOKEN=...   # 设置页显示的 Token
BASE=http://127.0.0.1:端口

curl -H "Authorization: Bearer $TOKEN" $BASE/v1/status
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/v1/tasks/<任务ID>/run
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"allow"}' $BASE/v1/approvals/<审批ID>
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"choice":0}' $BASE/v1/asks/<任务ID>
```

## 外部事件

先在任务编辑页把「附加触发」设为「外部事件（本地 HTTP）」，填写事件类型，例如 `github.issues.opened` 或 `github.*`（支持精确类型和 `prefix.*`）。

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "type":"github.issues.opened",
    "subject":"#42",
    "summary":"Issue 标题",
    "detail":"Issue 正文",
    "link":"https://github.com/org/repo/issues/42"
  }' $BASE/v1/events
```

安全边界：

- 事件只能选择事件类型；不能指定 `cwd`、Agent 或权限，这些只由本机任务配置决定。
- `type`、`subject`、`link` 会做字符集和协议校验；多余字段被丢弃。
- `summary` / `detail` 写入应用数据目录 `event-context/` 下的资料文件，提示词里只有事件类型、对象和文件路径，不拼接外部正文。
- 事件资料文件目前不会自动删除，可定期手动清理 `event-context/`。
- 任务正在运行或等待回答时，事件会记录为跳过，可在任务列表补跑。