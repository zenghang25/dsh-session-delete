# dsh-session-delete

给 DSH（DeepSeek Harness）侧栏补上**删除单个会话**：在会话行的「…」菜单末尾加一项「删除会话」，点击后弹窗确认；确认后把该会话及其日志目录**移到 Windows 回收站**，而不是永久删除。

适用于 DSH `0.2.1-rc.2`（Web / Desktop profile）。

---

## 功能

| 入口 | 菜单项 | 行为 |
|---|---|---|
| 会话行 `…` 菜单（末位，带分隔线，红色危险样式） | **删除会话** | 确认后把 `~/.dsh/sessions/<项目键>/<会话 id>/` 整个目录移入系统回收站 |

确认弹窗会显示会话标题，并明确说明「日志会移入 Windows 回收站」。如果该会话仍有正在运行的任务，弹窗直接以「停止并删除」的形态打开，一次点击完成停止与删除。

删除后：

- 侧栏中的该会话行立即消失（归档机制负责隐藏）；
- 会话日志目录出现在回收站里，可以还原；
- 还原文件后，该会话仍处于 DSH 的「已归档」状态，到侧栏的「已归档」视图里点「取消归档」即可重新显示。

## 安装

```powershell
git clone https://github.com/zenghang25/dsh-session-delete.git
dsh plugin --profile desktop add "D:\path\to\dsh-session-delete"
```

`add` 的参数必须是**绝对路径**。包清单里的 `dsh.bundle.patch` 会让它自动成为 profile 的一个 bundle 层，不需要手改 `cordis.patch.yml`。

装完刷新 DSH 页面（`Ctrl+R`）。运行中的 profile 由 HMR 重新组合，Host 半会直接挂载；客户端半在页面刷新后加载。若 HMR 未生效，退出桌面端再打开即可。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-session-delete
```

## 实现

**不依赖 DOM / React 内部结构**，只用 0.2.1 的官方扩展点：

- `sidebar.workspaces.session.menu.item` — 会话 `…` 菜单行列表 slot，本插件 order = 500（官方 pin/rename/fork/archive/session-id 之后）。
- `shell.overlay` — 全局浮层，用于确认弹窗。

Host 半注册两个同源路由，都先过 `ctx.connection.requestRejection(req)`：

| 路由 | 作用 |
|---|---|
| `POST /dsh-session-delete/probe` | 预检：这个会话能不能删、是否需要先停任务、是否由本进程持有；不做任何修改 |
| `POST /dsh-session-delete/delete` | 执行：归档 → 排空 live 会话缓冲 → 注销工作区账目 → 移到回收站 |

两个路由共用同一份前置检查 `resolveDeletableTarget`，所以预检结论和真正删除不会分歧。

删除顺序是有意设计的：

1. **定位持久化记录**：从 `sessionPersistence.list()` 的 `{ header, formatStatus, revision, sizeBytes }` 快照里按 `header.id` 匹配，再把 `header` 交给 `locate()`。`locate()` 返回的是**日志文件路径**，删除目标是它所在的目录。
2. **先归档**：`archiveSession` 负责把行从侧栏隐藏；它内部会重新列举持久化，所以必须在文件还在时执行。归档集也是 `agent/pre-step` 的闸门，写完后该会话不会再产生事件。
3. **排空 live 会话**：若本进程持有该会话，调用 `ctx.sessions.flush(session)` 把内存里未落盘的事件写干净。失败则中止删除。
4. **注销工作区账目**：`detachSession(id)`，仅簿记。
5. **移到回收站**：调用 `powershell.exe` 执行 `SHFileOperationW`（`FO_DELETE` + `FOF_ALLOWUNDO`），Windows 会把整个目录放入回收站并记录原始位置。

删除前还有一道独立安全闸：目标必须是绝对路径、至少两层深、且目录里确实存在 `.jsonl` / `.jsonl.zstd` 文件；否则中止。

### 为什么用 PowerShell

Host 进程是纯 Node（Electron 以 `ELECTRON_RUN_AS_NODE` 启动），拿不到 Electron 的 `shell.trashItem`。Windows 的 Node 也没有回收站 API，所以插件调用系统自带的 `powershell.exe`（Windows PowerShell 5.1）执行一次 `SHFileOperationW`。

目标路径通过**环境变量**传给脚本，不拼进命令行，因此包含空格、引号或中文的路径也不会改变脚本语义。PowerShell 脚本以 `-EncodedCommand`（UTF-16LE Base64）传递，不依赖执行策略；`windowsHide` 确保不弹控制台窗口。

## 安全边界

- 只移动**该会话自己的日志目录**；不动其他会话、其他插件数据、缓存、附件对象、工作区文件或云端副本。
- 附件是内容寻址的共享对象（`~/.dsh/attachments/v1/objects/…`），可能被多条会话引用，所以不随会话删除。
- 回收站移动失败时，会话已经归档（行已隐藏）但文件仍在原处；路由会如实报错，修好权限或关闭占用后重试即可。
- 回收站删除可还原；本插件不会调用 `fs.rm` 做永久删除。

## 验证

```powershell
node test\host-smoke.mjs     # 假 ctx + 真实临时目录，驱动真实路由
node test\trash-smoke.mjs    # 真实调用系统回收站，并从回收站命名空间验证整棵目录
node test\client-smoke.mjs   # 迷你 React runtime，驱动真实注册组件
```

`trash-smoke.mjs` 会真实地把一个临时目录移入回收站（结束后清理），需要在普通 Windows 会话里运行；在受限沙箱（例如禁止管道 stdio 的 AppContainer）里会以 `spawn EPERM` 失败，这是环境限制，不是插件缺陷。

三份测试覆盖：认证栅栏、方法/体积/JSON/参数校验、预检不改动任何状态、busy 与 live 的处理、归档必须先于移动文件、安全闸拒绝非会话目录、回收站失败时目录保持原状、真实回收站路径与嵌套文件、菜单项/弹窗/错误码/竞态升级。

## 已知限制

- **仅 Windows**。非 Windows 平台会返回 `trash-unsupported` 并保留文件。
- 移动回收站后，该会话在内存里的对象会留到 DSH 退出；归档闸门保证它不再写入。
- 如果系统关闭了回收站或目标卷不支持回收站，`SHFileOperationW` 可能直接删除（Windows 自身行为），插件无法在移动后再验证。普通本地固定磁盘不受影响。
- UI 文案在页面加载时按当前语言确定；切换语言后刷新页面。

## 许可证

MIT
