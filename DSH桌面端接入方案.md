# DragonDesk 接入 DeepSeek Harness 桌面端执行状态 · 方案

> 状态：待确认，未实施  
> 目标版本：DragonDesk 1.0.x  
> 约束：不修改 DeepSeek Harness（DSH），不读取/展示对话正文，默认关闭

---

## 1. 目标

让 DragonDesk 桌宠在 DSH 桌面端执行任务时，用现有动画显示“思考中 / 执行工具 / 等待审批 / 完成 / 失败”等状态。

已确认的三项决策：

| 项目 | 决定 |
| --- | --- |
| 默认开关 | **默认关闭** |
| 关闭时行为 | **只展示当前实现的动态**，与现在完全一致，不监听、不轮询、不发状态 |
| 监听范围 | **所有工作区**，按状态优先级和最近活跃时间聚合 |
| 气泡 | 只显示**通用状态文案**，不显示工具参数、命令或对话正文 |

非目标（本期不做）：

- 不在桌宠里展示 DSH 对话内容。
- 不通过 DSH 插件或 Web API 注入/控制 DSH。
- 不支持远程 DSH、多机 DSH。
- 不做毫秒级同步，目标是 0.5–1.5 秒内反映状态。

---

## 2. 可行性结论

已在本机只读验证：

- DSH 桌面端会把执行过程实时追加到  
  `%USERPROFILE%\.dsh\sessions\<工作区>\<会话>\session.v4.jsonl.zstd`。
- 日志是**多个独立 zstd 帧 + 每帧一行或多行 JSON**，不是单个压缩流；按帧边界逐个解压即可增量读取。
- 事件里已经包含完整的执行状态：`turn/start`、`step/start`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`assistant/message`、`turn/end`、`job/registered`、`job/settled`、`llm/retry`。
- 本机 DragonDesk 使用 Electron 45.2.3，内置 Node 24.22.2，`zlib.zstdDecompressSync` 可用。
- 全程只读日志，不需要改 DSH 配置、插件或安装目录；DSH 升级不会因为本功能被破坏（最坏情况是桌宠不再跟随，见第 9 节）。

被否掉的方案：

| 方案 | 不采用的原因 |
| --- | --- |
| DSH 客户端插件推送 | 实时性最好，但要改 DSH profile、维护插件，DSH 升级可能失效 |
| DSH SDK（stdio JSON-RPC） | 那是另起一个 harness 运行时，不是桌面端当前会话 |
| 复用 Web GUI 的 WebSocket/API | 需要启动令牌和签名 Cookie，外部进程接入脆弱且易随版本失效 |

---

## 3. 总体架构

```
DSH 桌面端（完全不改）
  └─ 追加写 session.v4.jsonl.zstd
           │ 只读、增量、按帧
           ▼
DragonDesk 主进程
  ├─ DshObserver
  │    ├─ 发现：扫描 sessions 根目录（所有工作区）
  │    ├─ 读取：记录 offset，只解新追加的完整 zstd 帧
  │    ├─ 映射：DSH 事件 → running / waiting / review / failed / idle
  │    └─ 聚合：多会话按优先级选一个
  ├─ 状态仲裁：本地聊天 > 手动互动 > DSH 状态 > idle
  └─ 复用现有 pet:state IPC，驱动现有 9 套动画
```

设计原则：

1. **默认不启动**：开关关闭时，observer 不创建定时器、不扫描目录、不产生任何 IPC。
2. **只读、失败即降级**：日志格式变化、文件损坏、目录不存在，只影响桌宠状态，不影响聊天和设置。
3. **不引入新依赖**：只使用 Node 内置 `fs/path/os/zlib`。
4. **可单测**：observer 不依赖 Electron，纯 Node 模块。

---

## 4. 数据读取

### 4.1 路径

```
sessionsRoot（默认）= $DSH_HOME/sessions
                    或 %USERPROFILE%\.dsh\sessions
```

扫描层级：

```
sessions/
  └─ <workspace-key>/
       └─ session-<uuid>/
            └─ session.v4.jsonl.zstd
```

只认 `*.jsonl.zstd`；当前处理 `session.v4.*`，遇到其他版本记日志并跳过。

### 4.2 增量读取

每个文件维护：

- `offset`：已读取到的字节位置；
- `pending`：尚未拼成完整帧的尾部字节；
- `lineRest`：解压后尚未换行的半行；
- `session`：该会话当前状态。

每轮：

1. `stat` 文件大小；
2. 大小等于 offset → 跳过；
3. 大小小于 offset → 视为截断/替换，重置后重建；
4. 读取 `[offset, size)`，拼到 pending；
5. 解析完整 zstd 帧，逐帧 `zstdDecompressSync`；
6. 按行 JSON 解析，应用事件；
7. 残帧留在 pending，残行留在 lineRest。

帧解析要求：

- 支持普通 zstd 帧和 skippable 帧；
- 帧不完整时严格等待下一轮，不丢数据；
- 遇到损坏帧时向后寻找下一个 zstd magic 重新同步；
- pending 超过 16 MB 时丢弃最旧部分，防止异常文件撑爆内存。

### 4.3 首次接入

桌宠启动时，会话可能已经执行到一半：

- 读取文件头 64 KB，解出 `session` 头里的 `cwd`，用于工作区过滤；
- 从文件尾部最多 8 MB 开始解码（超过时向前找帧边界），推导当前状态；
- 再把 offset 设为文件末尾，之后只处理新增事件。

这样不会把旧任务当成“正在执行”，也不会漏掉当前审批。

### 4.4 发现频率

- 默认每 500 ms 扫一次 sessions 根目录；
- 只对“最近有改动”的日志做 `stat`/读取；
- 1 小时无更新的会话从内存移除；
- 多工作区全部纳入，不做递归 `fs.watch`，避免句柄数量不可控。

---

## 5. 状态映射

DSH 事件 → 桌宠状态：

| DSH 事件 | 条件 | 桌宠状态 | 说明 |
| --- | --- | --- | --- |
| `turn/start` | — | `running` | 新一轮开始 |
| `step/start` | — | `running` | 模型/工具步开始 |
| `llm/retry` | — | `running` | 模型重试 |
| `tool/call` | — | `running` | 正在执行工具 |
| `tool/result` | — | `running` | 工具返回，继续处理 |
| `job/registered` | — | `running` | 后台任务登记 |
| `approval/asked` | — | `waiting` | 等待用户审批 |
| `approval/decided` | — | `running` | 审批完成，继续 |
| `assistant/message` | 含 `tool-call` 块 | `running` | 还要继续执行 |
| `assistant/message` | 不含 `tool-call` | `review` | 出现最终答复 |
| `turn/end` | `reason.kind = completed` | `review` → 4 秒后 `idle` | 本轮完成 |
| `turn/end` | `aborted` / `cancelled` / `interrupted` | `idle` | 被停止 |
| `turn/end` | `failed` / `error` | `failed` | 失败 |
| 超过 `activeSeconds` 无事件 | — | `idle` | 兜底，防止 DSH 崩溃后卡在 running |

说明：

- `tool/result.isError=true` **不单独判失败**，因为工具报错后模型往往还会继续；只有 `turn/end` 明确失败才显示 `failed`。
- 不根据 `approval/asked.reason`、`tool/call.arguments` 生成气泡，避免泄露命令和文件路径。
- 现有动画已经包含 `running`、`waiting`、`review`、`failed`，不需要新增图集。

### 5.1 气泡文案

| 状态 | 文案 |
| --- | --- |
| `running` | `DSH 正在处理……` |
| `waiting` | `DSH 正在等你审批……` |
| `review` | `这一步完成了。` |
| `failed` | `这一步没有完成。` |
| `idle` | 不弹气泡 |

`showBubble=false` 时只换动画、不弹气泡。

### 5.2 多会话聚合

所有工作区可能同时有多个会话：

1. 只考虑 `activeSeconds` 内有事件的会话；
2. 按优先级选：`waiting` > `running` > `failed` > `review`；
3. 同优先级取最近事件时间更新的；
4. 选中会话回到 idle 后，自动落到下一个活跃会话。

一期不做“同时显示两个会话”，避免动画来回抢。

---

## 6. 状态仲裁

现有主进程已经用 `status(state, bubble)` 广播 `pet:state`；DSH 状态不能直接覆盖本地聊天和互动。

引入三层：

```
本地 API 聊天进行中        → 最高，始终 running
用户点击/摸头/拖动 1.7 秒内 → 次高，waving / jumping
DSH 活跃                   → 再次
本地 idle                  → 兜底
```

规则：

- `request` 存在时，DSH 状态不参与显示；
- 点击互动设置 `interactionUntil = now + 1700ms`，到期后自动回到当前有效状态；
- DSH 状态每收到一次事件刷新 `at`；
- `turn/end` 的 `review` 由 observer 计时 4 秒后转 `idle`；
- DSH 关闭时清空 observer 状态，立即回到现有 idle / 本地状态，不残留动画。

关闭开关时的保证：

- 不创建扫描定时器；
- 不读取 `sessions` 目录；
- 不发送 `pet:state`；
- 设置页只显示“未开启”；
- 现有聊天、互动、主动气泡、主题切换完全不变。

---

## 7. 配置设计

配置仍为 `version: 2`，新增可选段；旧配置加载时自动补默认值，不强制迁移版本、不破坏现有测试和用户配置。

```json
"integrations": {
  "dsh": {
    "enabled": false,
    "sessionsRoot": "",
    "workspace": "",
    "showBubble": true,
    "pollMs": 500,
    "activeSeconds": 600
  }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；关闭时零副作用 |
| `sessionsRoot` | `""` | 空 = `$DSH_HOME/sessions` 或 `%USERPROFILE%\.dsh\sessions` |
| `workspace` | `""` | 空 = 所有工作区；填写后只匹配该目录及其子目录 |
| `showBubble` | `true` | 是否弹通用状态气泡 |
| `pollMs` | `500` | 扫描间隔，允许 200–5000 |
| `activeSeconds` | `600` | 超过该时间无事件则回 idle，允许 10–3600 |

校验规则：

- `enabled`、`showBubble` 为布尔值；
- `sessionsRoot`、`workspace` 为字符串，长度上限 1000；
- `pollMs` 为 200–5000 的整数；
- `activeSeconds` 为 10–3600 的整数；
- 缺失 `integrations` 时由 `migrate` 补默认值，不报错。

设置页新增“04 DSH 桌面端”卡片：

- 开关：显示 DSH 执行状态（默认关）；
- 开关：状态气泡（默认开）；
- 输入：只监听指定工作区（可选，留空为全部）；
- 状态行：
  - 未开启；
  - 等待 DSH 会话……；
  - 正在监听 N 个 DSH 会话；
  - 未找到 DSH 会话目录：`<path>`；
  - DSH 状态读取失败：`<原因>`。

---

## 8. 改动清单

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `src/backends/dsh-observer.cjs` | 新增 | 帧解析、增量 tail、事件映射、多会话聚合、状态/错误回调；纯 Node |
| `src/config.cjs` | 修改 | 补默认 `integrations`；校验新字段 |
| `config.example.json` | 修改 | 增加 `integrations.dsh` 默认段 |
| `src/main.cjs` | 修改 | 创建/启停 observer；三层状态仲裁；`runtime.dsh` 状态；退出清理 |
| `renderer/panel.html` | 修改 | 新增 DSH 卡片 |
| `renderer/panel.js` | 修改 | 读写新配置；显示 DSH 运行状态 |
| `src/preload.cjs` | 不改 | 复用现有 `config:updated` / `runtime:updated` / `pet:state` |
| `README.md` | 修改 | 新增“DSH 桌面端状态（可选）”说明 |
| `test/dsh-observer.test.cjs` | 新增 | 帧解析、增量读取、状态映射、异常降级 |

规模预估：新增约 300–350 行实现 + 150–200 行测试，其余为小改。

---

## 9. 异常与边界

| 场景 | 行为 |
| --- | --- |
| DSH 没安装 / 没有 sessions 目录 | 设置页提示“未找到 DSH 会话目录”，桌宠保持 idle，不报错弹窗 |
| DSH 没运行 | 没有新事件，保持 idle；已有旧会话不会误显示 running |
| DSH 升级改了日志格式 | 解帧/解析失败 → 降级 idle，设置页提示读取失败；不影响聊天 |
| 日志被截断/替换 | 检测 `size < offset` 后重建该会话状态 |
| 长工具执行中长时间无事件 | 由 `activeSeconds` 兜底；默认 600 秒，可在配置中调大 |
| DSH 崩溃 | `activeSeconds` 到期后回 idle |
| 多会话同时活跃 | 按 `waiting > running > failed > review` 聚合成一个状态 |
| 桌宠正在聊天 | 本地聊天优先，DSH 状态不抢动画 |
| 用户点击桌宠 | 互动动画优先 1.7 秒，然后恢复 DSH 状态 |
| 关闭开关 | 立即停止定时器、清空状态、回到现有行为 |

隐私：

- 只读取事件类型、工具名、是否报错；
- 不显示、不记录 `arguments`、审批原因、文件路径、对话正文；
- observer 不写任何日志到磁盘；
- `sessionsRoot` 由用户本机配置，默认只读当前用户目录。

---

## 10. 测试计划

### 10.1 单元测试（`test/dsh-observer.test.cjs`）

1. 帧拆分：
   - 两个完整帧 → 返回两个事件；
   - 第二帧只写一半 → 第一帧生效，残帧留在 pending；
   - skippable 帧被跳过；
   - 垃圾字节后重新同步。
2. 增量读取：
   - 先写 `turn/start`，tick 后 running；
   - 追加 `approval/asked`，tick 后 waiting；
   - 追加 `turn/end(completed)`，tick 后 review；
   - 时间推进 4 秒，tick 后 idle。
3. 状态映射：
   - `assistant/message` 是否含 tool-call 的两种结果；
   - `turn/end` 的 completed / aborted / failed。
4. 聚合：
   - 两个会话，waiting 优先于 running；
   - 同优先级取最近活跃。
5. 配置：
   - 旧配置缺 `integrations` 时自动补默认值；
   - 非法 `pollMs` / `activeSeconds` 报配置错误。

### 10.2 回归

- `npm test`：现有 API、配置、主题测试全部通过；
- `npm run check`：语法、默认配置、图集检查通过；
- `npm run test:ui`：真实 Electron 冒烟通过；
- 关闭开关时与改动前行为逐项对比：聊天、点击互动、主动气泡、主题切换、托盘、快捷键。

### 10.3 手动验收

1. 打开 DSH，发一个会调用工具的任务；
2. 桌宠 1.5 秒内切到 `running`；
3. 出现审批时切到 `waiting`，审批后回 `running`；
4. 任务完成后 `review`，约 4 秒回 `idle`；
5. 桌宠聊天进行中，DSH 状态不抢动画；聊天结束后恢复跟随；
6. 关闭开关，确认不再跟随 DSH，现有动态完全不变。

---

## 11. 实施步骤

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| P1 | 新增 `dsh-observer.cjs`：帧解析、tail、映射、聚合 | 可独立单测的模块 |
| P2 | 配置默认值与校验、示例配置 | 旧配置自动兼容 |
| P3 | 主进程接入与三层状态仲裁 | 开关关闭零副作用 |
| P4 | 设置页卡片与状态提示 | 可手动开关、查看连接状态 |
| P5 | README、单元测试、回归与手动验收 | 可交付版本 |

每阶段完成后跑一次 `npm run check` 和相关测试，避免到最后一次性排错。

---

## 12. 验收标准

- [ ] 默认关闭；关闭时无定时器、无目录扫描、无额外 IPC。
- [ ] 开启后能跟随 DSH 的 running / waiting / review / failed。
- [ ] 状态延迟不超过约 1.5 秒（轮询 500 ms 时）。
- [ ] 多工作区、多会话不抢动画，按优先级聚合。
- [ ] 本地聊天和点击互动始终优先。
- [ ] DSH 关闭、崩溃、日志格式变化时不影响桌宠正常功能。
- [ ] 不展示命令参数、审批原因、文件路径或对话正文。
- [ ] `npm test`、`npm run check`、`npm run test:ui` 通过。

---

## 13. 待确认

1. 设置页是否需要在“04 DSH 桌面端”里显示当前选中的会话 ID？默认只显示状态和数量，避免界面变复杂。
2. `activeSeconds` 默认 600 秒是否合适？如果经常跑 10 分钟以上的命令，可以调大。
3. 是否需要“只在 DSH 窗口在前台时跟随”？一期按“所有工作区、最近活跃”处理，不判断窗口焦点。
