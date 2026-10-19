**中文** ｜ [English](./README.md)

# dsh-session-move

DeepSeek Harness（dsh）Web 界面的会话管理插件：**移动到别的工作区**、**永久删除**、**AI 重命名会话标题**。
三个操作同时以 agent 工具暴露，界面与模型共用同一套实现，每次改动都是带快照与操作日志的事务。

---

## 能做什么

| 功能 | 从哪用 | 结果 |
|:--|:--|:--|
| **移动会话** | 会话行「⋯」→ 移动到文件夹… | 会话改在目标目录工作；历史跟着走；失败自动还原 |
| **删除会话** | 会话行「⋯」→ 删除会话 | 停止 → 快照 → 删日志目录 + 清记账 + 清缓存 |
| **AI 重命名会话标题** | 会话行「⋯」→ AI 重命名 | 读你说过的话，把这条会话的标题改成一个更贴切的 |

三项在 agent 侧对应 `workbench_session_move` / `workbench_session_delete` / `workbench_session_rename_ai`。

## 用法

**移动**：点会话行「⋯」→「移动到文件夹…」→ 单选目标项目 →「移动」。
目标必须是**已经登记过的项目**（侧栏里已有的工作区）；界面会提示会话当前在哪个项目。
移动后的会话在目标目录下继续工作，可以正常打开、继续对话。

**删除**：点「⋯」→「删除会话」→ 勾选「我已了解」→「删除」。
删除前会**自动快照**，所以删错了还能从快照恢复（见「数据与恢复」）。

**AI 重命名会话标题**：点「⋯」→「AI 重命名」，几秒后标题更新。
它只读**你说过的话**（不读助手回复与工具结果），用会话自己的模型给这条会话**重写标题**；
冷会话会被临时拉起，失败时不会留下半截状态。不满意就再重命名一次——旧标题记在操作日志里。

## 给 agent 的三个工具

| 工具 | 参数 | 用途 |
|:--|:--|:--|
| `workbench_session_move` | `sessionId`、`workspaceId` | 把会话移到另一个工作区 |
| `workbench_session_delete` | `sessionId` | 永久删除（先快照） |
| `workbench_session_rename_ai` | `sessionId` | 用 AI 重写会话标题 |

工作区 id 可以从 `GET /__sessionmove/info` 取。工具与界面走同一个操作实现；
失败时**抛出错误**而不是返回一句「失败」文本，避免模型把失败读成成功。

## 数据与恢复

一次改动 = 一个事务：

```
判定（可拒绝，拒绝时磁盘未被触碰）
  → 变冷（停、落盘、从内存摘除，释放写锁）
  → 快照（整条会话目录 + 两份记录）
  → 分步写（改名 → 改 header → 对齐索引 → 挂回项目 → 修缓存）
  → 校验四条不变式 → 提交｜失败则用快照整体恢复再校验
```

四条不变式：日志位置 == 由 header 的 `cwd` 算出的位置；会话只记在目标项目名下；
投影缓存身份与 header 一致；首帧恰好一行 JSON。校验不过就回滚；回滚不干净会明确报
「部分还原」并给出快照路径，不会伪装成普通失败。

| 产物 | 位置 |
|:--|:--|
| 操作日志（每次操作两条：进行中 / 结果） | `~/.dsh/session-move/journal.jsonl` |
| 快照（永不自动删除） | `~/.dsh/session-move/snapshots/<操作编号>/` |

```powershell
node tools/restore-session.mjs --list              # 列出快照
node tools/restore-session.mjs <操作编号> --yes     # 还原（会替换目标目录）
```

还原只把**会话目录**放回去；记账与缓存留给插件自己的「只补挂」去修——不绕过宿主直接改它的持久数据。
做法：还原后重启，再用「移动到文件夹…」选原项目（`cwd` 已对上，会自动走只补挂）。

## 安装

**不要用 `link:`**。插件是纯 ESM，直接 `import '@deepseek-ai/dsh-tools'`；`link:` 时 Node 按符号链接的
真实路径解析，祖先目录里没有 `@deepseek-ai`，整包会在加载阶段 `ERR_MODULE_NOT_FOUND`。

```powershell
npm pack
dsh plugin --profile web add file:<仓库路径>\dsh-session-move-0.3.7+dsh.0.2.1-rc.2.tgz
# 重启 dsh web —— 插件只在启动时载入
```

改代码后要重新 `npm pack` + 重装 + 重启。安装前建议备份 `~/.dsh/sessions` 与 `~/.dsh/storages`。

## 验证

```powershell
npm test                          # 纯核心 / 事务 / 操作 / 快照，共 50 项，不需要 dsh
node tools/check-layers.mjs       # 依赖方向（21 个文件，0 违规）
node tools/check-dsh-contract.mjs # 对着已安装的 dsh 断言 15 项契约
node tools/check-session-dir.mjs <会话目录>   # 只读诊断一条真实会话
```

`check-dsh-contract` 是「跟着宿主升级还能活」的依据：直接 import 已安装包，断言
`defineTool` / `BlockAssembler` / `deadline` / `indexHeader` / `detachEntered` /
`session_projcache` / `projectKey` 仍在，并确认前端 bundle 仍导出 `MenuItemButton`。

## 版本号约定

```
version     = 0.3.7+dsh.0.2.1-rc.2
              ^^^^^             本插件自身语义版本
                   ^^^^^^^^^^^^ 实测通过的目标 dsh 版本
engines.dsh = ^0.2.1-rc.2       机器门禁：不满足的 dsh 会整包跳过
```

`+` 后面是 build 元数据，semver 在排序与范围匹配时忽略它，只用于人读。换目标 dsh 时才改它。

## 已知限制

1. **端到端覆盖有限**：帧改写、事务回滚、快照还原（真实目录、逐字节比对）都有测试；
   界面渲染与 AI 重命名的模型调用只做过手工验证。
2. **不支持拖拽**：跨文件夹拖拽需要给别人的行挂 DOM 监听，官方没有对应扩展点；只保留菜单路径。
3. **快照永不自动删除**：磁盘只涨不减，需要手工清 `~/.dsh/session-move/snapshots/`。
4. **只支持 `^0.2.1-rc.2`**：0.3 会被门禁拦下——那时要重新核对 `tools/check-dsh-contract.mjs`。

## 与上游的关系

本插件是 **dsh-session-move v0.1.5** 的重写版。原项目由 **[reinocheong](https://github.com/reinocheong)**
创建并以 MIT 发布——本插件的核心判断（会话归属不是关联表，而是 header 里的 `cwd`，而 `cwd` 决定
日志目录）来自他；三个功能、工具名与标题 prompt 的取舍也继承自他。

原仓库现已不可访问，因此本仓库基于本机已安装的 v0.1.5 独立重写。

## 许可

MIT，见 [LICENSE](./LICENSE)。第一行是上游原始版权行，其后是本次重写的溯源说明。
