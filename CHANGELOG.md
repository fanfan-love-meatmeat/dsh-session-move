# CHANGELOG

## [Unreleased] — 2026-10-19 · 开源前脱敏

### Changed

- 测试夹具改用中性占位路径（`C:\work\...`），移除本机真实目录、用户名与内部项目代号；
  中文转义用例改为虚构示例，并同步更新期望值。
- `.gitignore` 补全凭据与环境配置的忽略项：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、
  `*.pfx`、`.npmrc`、`.netrc`，同时忽略本机专用的 `AGENTS.md`。

## [0.3.7+dsh.0.2.1-rc.2] — 2026-10-19 · 双语文档

### Changed

- README 拆成两份：**`README.md`（英文，主）** 与 **`README.zh.md`（中文）**，顶部互相跳转；
  两份结构一致，都以功能与用法开头，上游溯源压缩到末尾一小节。
- README 里不再陈述「本地留档、已 gitignore」这类内部约定——该约定移入 `AGENTS.md`。
- `files` 补上 `README.zh.md`，确保打包与发布都带上两份。
## [0.3.6+dsh.0.2.1-rc.2] — 2026-10-19 · 用词修正

### Changed

- 功能名称从「AI 起标题」改为 **「AI 重命名会话标题」**：它做的是**改写这条会话已有的标题**，
  不是自动生成一个新标题。README、`locale/zh.json`、`locale/en.json`、`package.json` 描述、
  以及对话框里的进度文案同步改正；`keywords` 补上 `rename-session` / `session-title` / `标题`。
## [0.3.4+dsh.0.2.1-rc.2] — 2026-10-19 · 版本号带上目标 dsh

### Changed

- 版本号改用 **build 元数据**标注目标宿主：`0.3.4+dsh.0.2.1-rc.2`。semver 忽略 build 元数据，
  不影响安装与范围匹配；`-dsh.…` 那种预发布写法会把自己标成预发布版且 `^0.3.4` 匹配不上，已否决。
- README 增加「版本号约定」一节，说明它与 `engines.dsh` 的分工：前者是人读的「验证过哪个版本」，
  后者是机器判定的门禁。
- 文档：README 溯源段重写（作者贡献、溯源表、同名仓库辨析、关于转载）；LICENSE 第一行恢复上游原文版权行。
  上游代码与文档副本移出发布树（`_backup/` 已 gitignore），仓库不再分发上游内容。
## [0.3.3] — 2026-10-19 · AI 重命名在 max-tokens 上误判失败

### Fixed

- **`title generation failed: unexpected finish {"kind":"max-tokens"}`**。`FinishReason` 的真实取值是
  `stop / tool-calls / max-tokens / aborted / error`（`dsh-llm/lib/types/types.d.ts:131-151`），
  **没有 `length`**。旧判断允许 `stop` 与 `length`，等于只允许 `stop` —— 模型一旦用完输出
  预算就判失败（这个错误判断是从上一版原样继承来的）。
  现在只拒绝 `tool-calls / aborted / error` 三种真正异常的收尾；`max-tokens` 下**只要有文本就接受**
  （截断的标题仍是一行可用标题），完全没文本时给出可操作的提示。
- 默认 `maxOutputTokens` 96 → 256，给会先"思考"的模型留出余量。

### Changed

- 重命名 0.3.2 之后的已知副作用保留：重命名冷会话后它保持 live（不 dispose），避免侧栏那一行被摘掉。
## [0.3.2] — 2026-10-19 · 重命名后侧栏会话"消失"

### Fixed

- **AI 重命名后，侧栏那一行会消失**（新建一个会话后又出现）。原因是重命名冷会话时先 `resume` 拉起、
  成功后 `dispose` 放回冷态：dispose 会拆掉 agent 与 session 并发出 `session/disposed`，
  Web 客户端把它读成「这条会话没了」，于是从列表面摘掉该行，直到下一次完整重投影才回来。
  现在**成功后不再 dispose**，让会话保持活着（这也是上一版的行为）；失败路径仍然释放。
  日志里新增 `resumed` 字段，可看出这次是否拉起过冷会话。

### Known

- 副作用：重命名冷会话后它会保持 live（一个闲置的 agent），由宿主的空闲生命周期回收。
  与「侧栏少一行」相比，这个代价更小。
## [0.3.1] — 2026-10-19 · 修复能力自检误报

### Fixed

- **把「暂时不可用」误判成「永久不兼容」**。`ctx.get(name)` 默认 `strict`：只返回**提供方 fiber 已 ACTIVE**
  的服务。`workspaceRegistry` 的初始化要 `await storageDomain.open(...)`，而插件在 `webServer`
  注入回调里（启动早期）做探测，那一刻它是 `undefined`，而结果被缓存了下来 —— 于是 27 个项目的界面
  一直显示「当前 dsh 版本不兼容（缺 workspaceRegistry.indexHeader, workspaceRegistry.attachSession）」，
  点击「移动」直接 501。
  现在每次请求都重新探测，只有**首次**发现不兼容时才写一条告警，且不再缓存。
- **索引重算静默跳过**：`registry.index()` 在服务不可用时原来直接 `return`，会让事务「成功」却没对齐索引；
  现在直接抛错，交给事务回滚。
- 能力报告新增 `services` 字段（每个宿主服务 `present` / `absent`），用于区分「探测太早」与「真的缺能力」。

### Changed

- 移除 `apply` 阶段的一次性探测（那时 registry 一定还没就绪，只会产生假告警）。
## [0.3.0] — 2026-10-19 · 重写

面向 DSH **0.2.1-rc.2** 的整体重写。功能与工具名不变，实现与内部结构全部替换。
上游 v0.1.5 的完整留档在 `_backup/202610191630_原插件/`。

### Added

- **事务骨架**：判定 → 变冷 → 快照 → 分步执行 → 校验四条不变式 → 提交｜失败整体恢复。
  不再有「逐步撤回」：磁盘状态整体存在于快照里，恢复是一段固定序列。
- **操作日志** `journal.jsonl`（追加式）：每次操作写「进行中」与「结果」两条，
  含时间、类型、来源（界面／工具／脚本）、原/新位置、失败步骤。被拒绝的操作同样记录。
- **快照**（`snapshots/<操作编号>/`）：整条会话目录 + 两份持久记录 + 说明，**永不自动删除**。
- **能力自检**：启动时探测宿主能力，缺失则报「与当前 dsh 不兼容，请升级插件」；
  `/info` 一并返回，操作时按缺失项直接 501。
- **四条不变式**（I1 位置 / I2 记账 / I3 缓存身份 / I4 首帧形状），写成可判定的函数。
- **四层测试**：纯函数（27）· 事务（8）· 操作（9）· 快照还原（6）；另有依赖方向守卫，
  以及对着真实安装包的契约测试（15 项）。

### Changed

- 客户端从 DOM 注入改为官方 slot `sidebar.workspaces.session.menu.item`：
  不再查询 DOM、不再从 React fiber 挖 id、不再按标题反查会话、不再注入拖拽。
  自维护的对话框取代 `Modal`（只保留 `MenuItemButton` 一个外部组件）。
- HTTP 表面收敛为两条路由（`/info` 与 `/op`），错误码单一出口。
- 工具失败改为抛出（此前返回 `move failed: ...`，模型会读成成功）。
- `package.json`：兼容性改由 `engines.dsh` 单字段声明，删除 5 条 `peerDependencies`
  与失效的 `dsh.client.inject`。

### Fixed

- **AI 重命名必失败**：`targetWords` / `targetCjkCharacters` 会让
  `resolveSessionTitleLlmConfig` 因未知键抛错；`[...session.events]` 在 0.2.1 上也不存在
  （应为 `snapshotEvents()`）。
- **移动「当前打开的会话」后界面卡死**：客户端 `sessions` 服务没有 `current` 也没有 `open()`，
  旧代码据此判断「是不是当前会话」始终为假，恢复路径空转。
- 会话目录在摘出内存（变冷）**之前**就被改名，导致内存与磁盘的 header 短暂不一致。
- `sd.flush()` 不存在，三处「持久化屏障」是死代码。
- 手写 registry 的三个私有 Map 改为一次 `indexHeader`，顺带补上 `missingSessionPaths`。
- 世代文件名正则接受 `.v0` 与前导零（官方不认），收紧为官方口径。
- 改写首帧时「读两遍 + 丢弃续接残帧 + 无 fsync」：改为读一次、保留尾部全部字节、原子写 + fsync。

### Removed

- DOM 注入、`MutationObserver`、fiber id 挖掘、标题反查、拖拽投放、移动后的「来回切重开」。
- 启动期全量投影缓存修复（改为命令行脚本）。
- `tools/stub-loader.mjs` 等为旧实现服务的测试脚手架（被纯函数测试取代）。
