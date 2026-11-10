# DragonDesk 接入 DeepSeek Harness 桌面端执行状态

> 2026-11-10：已实现并通过 Windows 成品验证。低内存优先，默认关闭；结果见文末。

## 1. 目标与隐私边界

只读本机 DSH 日志，用现有动画跟随 running / waiting / review / failed；不修改 DSH、不发起任务、不共享登录配置。所有工作区聚合，可指定目录及子目录。

角色绑定（后续 OpenAI 接入更新）：鲸鱼娘跟随 DSH，龙娘跟随 OpenAI / ChatGPT。两个开关独立保存，仅当前角色对应的 observer 启动，切换时先停止旧源。OpenAI 实现见 `ChatGPT桌面端接入方案.md`。

两源集成后的回归：65 项测试、源码 UI 冒烟、原目录 Windows 打包与成品冒烟均通过；包含角色切换后旧 observer 停止、恢复对应来源、正文不留存。

默认关闭：不实例化 observer、不扫描目录、不创建 DSH 定时器、不发送 DSH 状态 IPC。只使用 Node 内置模块，不新增进程或 Worker。

状态与正文混存在压缩日志中，解压和 JSON 解析会使正文短暂进入内存，不能承诺“完全不读取正文”。只提取有界状态元数据，立即丢弃其他内容，不存储、不展示、不上传、不写应用日志。气泡固定文案，不使用工具名、参数、审批原因、路径或正文。

## 2. 已验证基础

- 默认路径：`$DSH_HOME/sessions`，否则 `~/.dsh/sessions`。
- 文件：`sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`。
- 多个独立 zstd 帧串接，一帧可能多行。不能用一次解压读取整个文件，本机一次调用只返回首帧。
- Electron 45.2.3 / Node 24.22.2 支持内置 zstd。
- 真实事件结构：`{type,seq,time,data}`；完成原因是 `data.reason.kind`。
- 本次真实样本只有一个会话、18 帧，覆盖开始、步骤、完成和失败；工具/审批/后台任务需要额外样本验证，不能视为所有 DSH 版本的稳定协议。

## 3. 低内存架构

目录慢速发现 → 有界摘要表 → 已知日志快速轮询 → 全局串行异步逐帧解压 → 状态归约 → 聚合 → 显示仲裁。

解压并发固定为 **1**。多个会话同时参与监听，桌宠按帧/小批次轮转处理，使用异步流避免主线程同步解压。

| 资源 | 预算 / 行为 |
| --- | --- |
| 输入块 / 输出块 | 64 KiB / 16 KiB |
| 解码窗口 / 单帧展开量 | 各最多 4 MiB，超限销毁流并降级 |
| 单行 JSON | 最多 256 KiB，超长跳过至下一换行 |
| 单次会话处理 | 达到 16 帧或 1 MiB 后轮转；单个完整帧可跨越批次字节预算，但仍受输入/展开量上限约束 |
| 会话摘要 | 最多 256 个，优先近期；超限提示降级 |
| 每会话审批 / 后台任务 | 各最多 32 个短 ID |
| 启动恢复 | 近期文件从最后 256 KiB 起，最多搜索 1 MiB |

不保留历史事件、完整解压帧、每会话大 Buffer。半帧记录起点；半行记录起始帧，下轮重读并按 seq 去重；超长行仅保留跳过标志。资源预算不等于 Electron 总 RSS 上限。

超限、损坏或不支持的事件布局清除不可信状态，设置页提示降级，等待可信生命周期事件恢复。

## 4. 帧与文件生命周期

- 按 frame header / block header 计算边界，支持普通和 skippable 帧，不能用下一个 magic 切割正常帧。
- 半帧等待；坏帧在有限窗口搜索 magic 并验证结构。
- 文件身份、大小回退、已提交位置的少量指纹共同检测截断、同尺寸替换、原地改写。
- 尾窗首行只有通过完整 JSON 和事件结构校验才使用，残行跳过至下一换行。恢复不足时状态未知，不承诺必定恢复所有早期审批。
- 使用日志 time 判断活跃与完成截止时间，不把读旧日志的时间当活动时间，不重播旧完成动画。
- 关闭、退出、异常必须释放句柄和流，停止后的异步回调不能再发状态；重新启用要等待旧解压退出。

## 5. 发现、延迟、淘汰

已知日志默认每 500 ms stat，增长才读；全部工作区每 5 秒通过目录迭代器发现，不创建大量 watcher、不构造全部历史文件列表。仅恢复最近 1 小时更新的日志；旧摘要移除，有等待审批的摘要保留至独立超时。

已知会话正常负载目标约 0.5–1.5 秒；全新会话首次发现可能约 5 秒；积压或资源降级时不保证延迟。

## 6. 状态归约

| 事件 | 行为 |
| --- | --- |
| turn/start | 新轮次 running，清理上一轮审批/反馈 |
| step/start、llm/retry、tool/call、tool/result | running；仍有审批时保持 waiting |
| approval/asked、approval/decided | 按 ID 加入/移除未决集合，未清空则 waiting |
| job/registered、job/settled | 按 ID 登记/结算，主轮结束仍有后台任务时 running |
| assistant/message | 不判断完成，不检查正文 tool-call |
| turn/end completed | 清理审批；有后台任务则 running，否则 review 4 秒 |
| turn/end aborted/cancelled/interrupted | 清理审批；有后台任务则 running，否则 idle |
| turn/end failed/error | failed 短暂显示后 idle |
| 不认识的结束原因 / 无法关联审批或任务 ID | 状态未知，提示降级 |

有 seq 时去重，有 turn 时忽略旧轮次。只从白名单生命周期事件提取状态字段，ID 限长。activeSeconds 默认 600，只让无活动的 running 过期；waiting 使用独立 1 小时兜底。仅凭日志不能精确区分长任务与崩溃。

聚合 waiting > running > failed > review，同级最近事件优先。只在显示状态或气泡变化时广播，避免每条日志刷新气泡。

## 7. 显示仲裁

启用时统一入口：本地请求 running > 用户互动 1.7 秒 > 本地完成/失败反馈约 3.2 秒 > DSH > idle。拖动期间渲染端维持拖动动画。

所有恢复计时器重新计算有效状态，不能直接覆盖 idle；连续互动替换旧计时器。关闭 DSH 停止 observer、清空 DSH 气泡并恢复本地。关闭功能时保留原有聊天/互动语义。

## 8. 配置与界面

保持 version 2，v1/v2 缺字段补默认值，显式非法值报错。

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

布尔严格校验，路径最多 1000 字符；pollMs 为 200–5000 整数；activeSeconds 为 10–3600 整数。工作区规范化后按路径边界匹配，不用裸 startsWith。

设置页新增“04 DSH 桌面端”：启用、气泡、会话根目录、工作区；显示未开启/等待会话/监听数量/目录缺失/读取降级。渲染端只接收通用状态文案，不接收原始异常或日志路径。

## 9. 文件改动

- src/backends/dsh-observer.cjs：发现、帧扫描、异步解压、归约、聚合。
- src/pet-state.cjs：独立可测的显示仲裁。
- src/main.cjs：延迟加载、启停/更新/退出、IPC。
- src/config.cjs、config.example.json：兼容补全和校验。
- renderer/panel.html/js：设置与状态；renderer/pet.js：按需清除气泡。
- README.md：使用方式、隐私和资源/延迟边界。

## 10. 验证与验收

覆盖拆帧、skippable、坏帧、半帧、跨帧 UTF-8/JSON、超长行、解压超限；审批并发、后台任务、旧轮次、超时与聚合；截断/同尺寸替换、尾窗、目录恢复；停止中解压、快速开关、不重叠轮询、默认关闭不读目录；仲裁计时器与气泡；配置补全与非法值。

内存验证记录开启前后 heapUsed / external / arrayBuffers / RSS，覆盖多会话和高度可压缩数据，区分 observer 预算与分配器保留的 RSS。

回归运行 npm test、npm run check、npm run test:ui。没有运行中的 DSH 时，工具/审批只能用构造日志验证，真实桌面端仍需验收。

## 11. 实现与验证结果（2026-11-10）

- 已实现上述 observer、默认配置兼容、设置页、仲裁和关闭清理；不新增运行依赖。
- `npm test`：51 项通过，包含 258 会话索引限额、单并发、读取中停止、跨帧 UTF-8、资源超限与仲裁回归。
- `npm run check`、`npm run test:ui` 通过。
- `npm run build:win`、`npm run test:packaged` 通过；原 `dist/win-unpacked/DragonDesk.exe` 已更新，继续使用原启动器。
- 真实本机日志只读兼容检查通过（1 会话，状态 idle，无降级）。工具/并发审批/后台任务以构造日志验证，尚未对正在执行任务的 DSH 做现场验收。
- `npm run test:dsh-memory`：100 个活跃会话、500 个历史会话、1 个超限压缩帧，6 轮处理；历史会话未进入摘要表，超限输入被隔离。
- 本次独立 Node observer 测量：GC 后稳定 RSS 增量 4.95 MiB，采样峰值增量 10.78 MiB；稳定 heapUsed 增量 1.26 MiB。报告在 `work/dsh-memory-report.json`，不是整个 Electron 的内存承诺。
- Windows 成品测试覆盖：默认关闭、界面保存启用、并发审批、本地聊天优先、互动后恢复、气泡关闭、完成/失败、停用后不再跟随。
