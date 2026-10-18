# dsh-session-delete

给 DSH（DeepSeek Harness）侧栏补上**删除单个会话**：会话行「⋯」菜单的最后一项是红色
「删除会话」，点击后**直接删除，不弹确认框**，并立刻从侧栏消失。

同时给每个对话建立独立的产出目录（`.dsh-sessions/<session-id>/`），删除对话时连同
它产生的文件一起删除。

适用于 DSH `0.2.1-rc.2`（Web / Desktop profile，主要面向 Windows 桌面端）。

---

## 功能

| 入口 | 菜单项 | 行为 |
|---|---|---|
| 会话行 `⋯` 菜单（末位，分隔线 + 红色危险样式） | **删除会话** | 一键永久删除该会话及其本地记录，无确认弹窗 |

一次点击清空以下内容：

| 内容 | 路径 |
|---|---|
| 会话日志（含子代理子会话） | `~/.dsh/sessions/<项目>/<session-id>/` |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<session-id>.json` |
| 该对话的产出目录 | `<会话工作目录>/.dsh-sessions/<session-id>/` |
| 工作区账目 / 置顶 / 归档集合 | `detachSession`、`unpinSession`、`unarchiveSession` |

运行中的会话会先被安全停止：写归档集合（`agent/pre-step` 门禁）→ `sessions.flush`
持久化屏障 → 等待 live 会话关闭视图 → 再动文件。无法停止时返回 `409 active`，
**一个文件都不动**。删除是幂等的：只有投影缓存残留的幽灵会话、甚至完全不存在的 id，
都返回成功而不是 `missing`。

## 每个对话一个编号目录

会话 id 就是编号，shell 里可通过 `DSH_SESSION_ID` 读取（PowerShell
`$env:DSH_SESSION_ID`，bash `$DSH_SESSION_ID`）。插件为每个对话建立：

```text
<工作目录>/.dsh-sessions/<session-id>/
  outputs/    交付给用户的文件
  memory.md   该对话的持久记忆/结论
  tmp/        临时文件
```

- 每个 agent 创建时，插件在 **per-agent 系统提示词**里写明该目录，要求所有生成文件
  必须写进去；workspace 的 `AGENTS.md` 可作为同样的兜底约定。
- 子代理（subagent）沿 `parentSession` 归属顶层对话，产出写进同一个编号目录。
- 删除顶层对话时整个目录一并删除，因此「删除对话 = 删除这个对话产生的所有文件」。

## 版本历史

- **0.4.0（当前）**：合并路线。保留 0.2.0 的一键直删、删除范围与每对话产出目录；
  并入 0.3.0 的 Host 安全设计（`connection.requestRejection` 认证/Host-Origin 栅栏、
  64 KiB 请求体上限、live 会话的 `sessions.flush` 持久化屏障）。
  按用户要求**去掉 0.3.0 的确认弹窗和回收站流程**，改为直接删除。
- **0.3.0**：确认弹窗 + 移到 Windows 回收站的版本（已废弃，见 git 历史）。
- **0.2.0**：重写。修复「点击删除永远报 missing」（旧代码从 `persistence.list()` 快照
  的错误层级读 id）；菜单从 MutationObserver 克隆 DOM 改为官方 slot 注册。
- **0.1.x**：早期 DOM 注入版本（已废弃，菜单会重复）。

## 安装

```powershell
git clone https://github.com/zenghang25/dsh-session-delete.git C:\Users\<you>\Documents\dsh-plugins\dsh-session-delete
dsh plugin --profile desktop add "C:\Users\<you>\Documents\dsh-plugins\dsh-session-delete"
```

`add` 的参数必须是**绝对路径**。包 manifest 里的 `dsh.bundle.patch` 会让它自动成为
profile 的一个 bundle 层，无需手改 `cordis.patch.yml`。

装完**完全退出桌面端再启动**（Host 半与 Client 半都会重新加载）。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-session-delete
```

## 实现

**不依赖 DOM / React 内部结构**，只用 DSH 0.2.x 的官方扩展点：

- `sidebar.workspaces.session.menu.item`：会话「⋯」菜单行列表 slot，本插件 `order = 500`
  （官方 pin/rename/fork/archive/session-id 之后），渲染一个 danger 样式的
  `MenuItemButton`，`useMenuOpenState` 负责关菜单。
- `agent/created`（Host 事件）：建立产出目录并注册 per-agent 系统提示词段。
- `ctx.webServer` 同源路由。

| 路由 | 作用 |
|---|---|
| `POST /dsh-session-delete/delete` | `{ sessionId }` → 删除；最多 64 KiB JSON |
| `GET /dsh-session-delete/ping` | 健康检查：`{ ok: true, version }` |

两个路由都先过 `ctx.connection.requestRejection(req)`（浏览器认证 + Host/Origin 栅栏）。

删除顺序（有意设计）：

1. 枚举会话 header（live + `sessionPersistence.list()` 快照，id 在 `header.id`），
   并沿 `parentSession` 收集子代理子会话；
2. `archiveSession(id, { stopActivity: true })`：durable 归档集合是 `agent/pre-step`
   门禁，先写它再停工作；已归档的会话先 `unarchive` 再归档，确保停止逻辑真的执行；
3. live 会话 `sessions.flush(session)`，失败则中止（不冒损坏日志风险）；
4. 等 live 会话退出；仍有 live 会话则返回 `active`，不删文件；
5. 先 `detachSession`（`workspace.sessionIds` getter 会按会话是否仍存在过滤，
   必须赶在删文件之前）；
6. 删除日志目录（`persistence.locate()` 精确路径 + 扫描会话根兜底）、投影缓存、
   `.dsh-sessions/<id>/` 产出目录；
7. `unpinSession` / `unarchiveSession` 清理账目。

启动时做一次轻量对账：清掉已不存在会话的归档 id 与孤立投影缓存。

## 安全边界

- 只删该会话自己的日志目录 / 投影缓存 / 产出目录：id 白名单、路径必须位于会话根或
  由持久化 header 的 cwd 构造；`rmrf` 拒绝根目录式路径。
- 附件对象（`~/.dsh/attachments/v1/objects/…`）是内容寻址共享资源，不随会话删除。
- **删除是永久的，不可恢复**（0.3.0 的回收站行为已移除）。
- 文件删除带重试；若最终仍失败会返回失败详情（已删部分不回滚，重试即可收尾）。
- cost-meter 账本不清理。

## 验证

```powershell
node test\host.test.mjs     # 假 ctx + 真实临时目录，驱动真实路由
node test\client.test.mjs   # 迷你 React/slot runtime，驱动真实注册组件
```

覆盖：认证栅栏、方法/参数校验、正常删除、子会话、幽灵会话、已归档会话、live 会话
flush 与无法停止时的中止、产出目录、启动对账、ping。

## 已知限制

- 主要面向 Windows 桌面组合（删除逻辑跨平台，但测试主要在 Windows 上跑）。
- 删除当前正在看的对话会先停掉它的运行工作并关闭视图。
- UI 文案在页面加载时按当前语言确定；切换语言后刷新页面。

## 许可证

MIT
