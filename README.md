# DragonDesk · 独立龙娘桌宠

白发紫瞳的小龙娘，独立运行在 Windows 和 macOS 桌面。双击聊天、单击摸头、按住拖动、右键打开菜单。聊天直接连接你的 API，不依赖 Codex 桌面端，不包含任何 harness、CLI 调用、工具执行或共享登录配置。

外观随当前模型自动切换：**DeepSeek → B 版蓝发鲸鱼娘与海蓝色界面；Codex / GPT → 龙娘与紫色界面**。设置页选择接口或修改模型名时可预览，点击“保存设置”后立即应用到桌宠、聊天头像和托盘图标，无需重启。优先识别模型名，因此自定义中转接口也适用；模型名无法识别时，DeepSeek 接口使用鲸鱼娘，其他接口使用龙娘。两套主题均支持 9 种动作和 16 向视线跟随。

名字、性格和互动台词也随角色独立切换：默认龙娘叫“小龙”，温柔、沉稳、偶尔俏皮；鲸鱼娘叫“小鲸”，活泼、机灵、略带傲娇。设置页会标出“正在编辑：龙娘 / 鲸鱼娘”，修改只影响该角色；切换角色时会保留尚未保存的文字草稿，最后统一保存。聊天请求、点击气泡、主动气泡、名字显示和托盘菜单均使用当前角色配置。新回复会记录当时的角色名字，切换角色不会给旧回复改名。

旧版配置会自动升级为版本 2：原有全局名字、性格和台词完整迁移到龙娘，鲸鱼娘使用独立默认配置。API 密钥、接口、置顶、位置和其他桌面设置均保留。

## Windows：现在就用

双击项目根目录的 **`启动桌宠.vbs`**。也可双击 `启动桌宠.cmd`。

- 已构建程序位于 `dist/win-unpacked/DragonDesk.exe`。请保留 `win-unpacked` 整个目录，不能只复制一个 EXE。
- 根目录启动器会明确使用根目录的 `config.json`，配置和聊天数据都留在本项目。
- 双击桌宠打开聊天窗口；右键 → **设置与性格** 填写接口。
- 默认快捷键：Windows `Alt + X`；macOS `Option + X`。本项目的快捷键会切换显示/隐藏；注册结果可在设置中查看，冲突时可更改。
- 隐藏后可从托盘菜单恢复；关闭聊天窗口会留在托盘。彻底退出使用托盘 → **退出 DragonDesk**。

## 配置 API

所有可编辑设置都在一个 UTF-8 JSON 文件 `config.json`。设置页保存也只更新这个文件；手动修改有效 JSON 后会自动加载。非法配置会保留当前有效状态并显示错误。

| 配置项 | 用途 |
| --- | --- |
| `chat.provider` | 当前使用的接口 ID：`deepseek`、`openai`、`custom`，也可自行增加 |
| `providers.<id>.protocol` | `chat-completions` 或 `responses` |
| `providers.<id>.baseUrl` | API 基础地址，可直接填完整的 `/responses` 或 `/chat/completions` 地址 |
| `providers.<id>.apiKey` | 你自己的 API 密钥；本机无鉴权服务可留空 |
| `providers.<id>.model` | API 平台实际支持的模型 ID |
| `providers.<id>.reasoning.format` | 推理参数格式：`openai` 或 `deepseek`，自定义中转也可手动选择 |
| `providers.<id>.reasoning.effort` | `default` 跟随模型；OpenAI 可选 `none/minimal/low/medium/high/xhigh/max`（由具体模型支持情况决定）；DeepSeek 可选 `none/low/high/max` |
| `providers.<id>.extraBody` | 可选请求参数，例如 `reasoning`、`thinking`；不要覆盖消息、模型、流式或工具配置 |
| `characters.dragon.name` / `characters.whale.name` | 龙娘 / 鲸鱼娘的名字，各自独立 |
| `characters.<角色>.systemPrompt` | 对应角色的性格、说话方式和设定；当前名字会自动附到聊天指令中 |
| `characters.<角色>.greetings` | 对应角色的点击、主动气泡台词，不调用 API；角色为 `dragon` 或 `whale` |
| `pet.idleTalkMinutes` | 本地主动气泡间隔，0 关闭，不调用 API |
| `pet.alwaysOnTop` | 仅控制桌宠置顶；聊天和设置窗口始终使用普通窗口层级 |
| `pet.scale` | 桌宠大小，默认 `0.85`（85%） |
| `startup.enabled` | 是否登录系统后自动启动，默认 `false` |
| `shortcuts.togglePet` | 显示 / 隐藏快捷键，空字符串禁用 |
| `chat.saveHistory` | 是否把新的完整对话保存到本机，关闭后不再写入，但不会删除以前的记录 |
| `chat.historyMessages` | 每轮发送的历史消息上限，默认 30 |

### DeepSeek

预置 `https://api.deepseek.com`、`chat-completions` 协议、模型 `deepseek-flash`。在设置中填入自己的 DeepSeek API Key 并保存。

### OpenAI / Codex 模型、兼容中转

选择 `openai` 配置，默认地址 `https://api.openai.com/v1`，协议 `responses`。填入 API Key 和平台实际提供的模型名称。Codex 模型按普通 Responses 请求接入；这里没有 Codex CLI 或编程代理。不读取或复用 Codex 桌面端的账户与配置。

`custom` 预置本机 OpenAI 兼容服务地址 `http://127.0.0.1:11434/v1`，可改为任意兼容服务的 HTTPS 地址和模型。远程地址要求 HTTPS，本机地址允许 HTTP。API 流式输出支持 Responses 事件及 Chat Completions SSE；也兼容返回普通 JSON 的网关。

### 推理强度

在聊天接口卡片中直接选择“推理参数格式”和“推理强度”。每个接口独立保存，不会影响另一个接口的选择。

- `default` 不额外发送推理字段，也保留旧 `extraBody` 中手写的参数，旧配置不需要迁移。
- OpenAI / Codex：Responses 发送 `reasoning.effort`；Chat Completions 发送 `reasoning_effort`，显式推理档位使用 `max_completion_tokens` 控制总输出预算。不是所有模型都支持所有档位，请按平台的模型说明选择。
- DeepSeek：Chat Completions 下，`none` 发送 `thinking.type=disabled`；`low/high/max` 发送 `thinking.type=enabled` 加 `reasoning_effort`。Responses 下使用 `reasoning.effort`，其中 `none` 关闭思考。
- 显式选择档位会覆盖 `extraBody` 中的旧推理强度，并去掉另一种协议的冲突字段；其他附加参数保留。
- 推理与最终答复共用输出 token 预算。档位较高时，可同时增加输出上限和请求超时，避免还未输出正文就达到上限。

参数格式依据 [OpenAI 推理文档](https://developers.openai.com/api/docs/guides/reasoning) 和 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)。

**没有填 API 时**，桌宠仍能动画、拖动、摸头和展示预设台词；自由聊天会提示先配置密钥。密钥保存在本机配置文件中，不在日志中输出。不要把自己的 `config.json` 上传到仓库或分享。

## DSH 桌面端状态（可选）

在伙伴设置的 **04 DSH 桌面端** 打开“显示 DSH 执行状态”并保存。**鲸鱼娘绑定 DSH，龙娘绑定 OpenAI / ChatGPT**；角色仍随接口和模型选择，两项开关独立保存，切换角色时先停止旧源、再启动对应源，同一时刻最多一个监听器。

设置页根据当前选择的模型，只显示对应的监听配置：DeepSeek 显示 DSH，OpenAI / GPT / Codex 显示 ChatGPT；自定义接口也优先按模型名判断。两套配置和未保存的编辑内容分别保留，来回切换不会互相覆盖。切换模型时立即预览对应配置，保存后切换实际监听源。

DSH 默认关闭；关闭或当前是龙娘时不扫描 DSH 日志，也不启动其监听定时器。可以跟随运行、等待审批、完成和失败动画，本地聊天与手动互动优先。

默认读取 `$DSH_HOME/sessions`，未设置时使用 `~/.dsh/sessions`。可填写其他会话根目录，或只监听指定工作区及其子目录；留空则监听所有工作区。只支持本机 `session.v4.jsonl.zstd` 日志，不修改 DSH 或共享账户配置。

日志分块读取、异步逐帧解压，并发固定为 1；只保留有界状态摘要，不缓存聊天历史。正文会随压缩帧短暂解压进入内存，但不会被保存、展示、上传或写进日志。状态气泡只有固定文案，可单独关闭。

已知会话通常约 0.5–1.5 秒更新，新会话最多约 5 秒发现；日志积压、格式变化或资源超限时设置页提示降级。无活动运行状态默认 600 秒过期，审批最多保留 1 小时；这些是日志推断，不能精确判断 DSH 是否崩溃。高级配置 `integrations.dsh.pollMs` 支持 200–5000，`activeSeconds` 支持 10–3600。解码窗口和单帧展开量各限制为 4 MiB、单行 256 KiB、会话摘要 256 个，超限降级，不代表整个 Electron 程序的内存上限。

## ChatGPT 桌面端状态（可选）

选择 OpenAI / GPT / Codex 模型后，在 **04 ChatGPT 桌面端** 开启“显示 OpenAI 执行状态”并保存；当前为龙娘时生效。跟随本机桌面端发布的普通聊天与 Codex / Work 状态，使用统一入口，避免依赖产品名称划分。鲸鱼娘期间暂停此连接。

“只监听指定工作区”填写本地项目目录，例如 `D:\Project\pet`，匹配这个目录及其子目录。留空监听全部；填写后只纳入本机会话，没有本地目录信息的普通聊天和远程主机会话会被排除。与 DSH 的工作区设置分别保存，修改后保存生效。

只连接已运行桌面端的本地状态通道，不启动新运行时，不修改 OpenAI 配置、登录或安装文件，不发送聊天消息、工具调用或审批决定。按流跳过正文与工具参数，只保留有限状态摘要；不保存、展示或上传聊天内容。该通道属于内部协议，升级后可能需要适配；不支持的版本或布局会显示读取降级。

最多跟随 32 个桌面端广播的会话，优先级与 DSH 一致。网页/手机上的聊天，以及未通过此桌面端发布状态的会话不在监听范围内。首次订阅会使 OpenAI 桌面端发送一次快照，其发送开销与已加载历史有关；DragonDesk 不构造整份快照对象。高级配置 `integrations.openai.socketPath` 留空自动使用本机默认通道；`activeSeconds` 为 10–3600 的超时兜底。

`npm run test:openai-memory` 验证 32 会话、大体积正文的流式过滤和状态内存；`npm run test:dsh-memory` 验证 DSH。报告位于 `work/`，均不代表整个 Electron 或 OpenAI 桌面端的内存上限。接入细节见 `ChatGPT桌面端接入方案.md`。

## 键盘录入快捷键

在设置的“03 桌面与启动”中点击快捷键旁的“键盘录入”，按下组合键并松开主键即可记录，点击“保存设置”后生效；也可继续手动输入。支持 Ctrl、Alt、Shift、Win / Cmd 等修饰键和字母、数字、功能键。普通按键需搭配 Ctrl、Alt 或 Win / Cmd，F1–F24 可直接录入。

按 Esc 或点“取消”保留录入前的设置；点“清空”并保存可禁用快捷键。键盘录入时暂时停用桌宠原快捷键，结束、取消、切换页面、窗口失焦或 30 秒超时后恢复。保存时显示注册成功、被占用或格式无效的结果。

## 开机自启

在设置中打开 **开机自启** 并保存，或修改 `startup.enabled`。仅注册 DragonDesk 自己的系统登录项，关闭开关会撤销该登录项。

- Windows：使用 Electron 的登录项 API，启动路径为当前 EXE，传递当前配置路径。
- macOS：打包为 `.app` 后支持登录项。源码开发模式会明确提示先打包，不会假装已经启用。请使用打包 `.app` 默认的配置位置；开发启动脚本使用项目目录，适合开发调试。
- 移动 Windows 程序文件夹后，请先关再开一次自启，让登录项更新到新路径。

## 数据位置

- 项目启动器：`D:\Project\pet\config.json`；同级 `data/` 保存聊天记录、Electron 缓存和日志。
- Windows 直接运行打包 EXE：默认在 EXE 同级目录生成配置及 `data/`，使用根目录启动器可统一指向本项目配置。
- macOS 打包 `.app`：默认 `~/Library/Application Support/DragonDesk/config.json`，同级 `data/`。
- 可以通过一个启动参数指定其他位置：`--config=/absolute/path/config.json`。
- 点击“清空聊天”会同时清空运行内存和本机聊天历史。失败或被停止的回复不会写入下一轮上下文。
- 清空后恢复当前角色的欢迎页和快捷话题，同时清除上一轮错误提示；再次发送消息后进入正常聊天。
- 切换 API 配置后，当前聊天的近期上下文会发送给新选择的接口；需要隔离时先清空聊天。

## 开发、测试和打包

需要 Node.js 22.15 或以上（DSH 使用内置 zstd）。开发与测试依赖都安装在本项目。API 模式不需要 Python。

```sh
npm install
npm start
npm run check
npm test
npm run test:ui
npm run test:packaged
```

`npm test` 使用回环模拟接口验证流式 UTF-8、请求协议、取消、失败、密钥遮蔽和本地存储。`test:ui` 启动真实 Electron 窗口，连接本地模拟 API，检查成功与失败交互并输出 `work/ui-smoke/data/` 下的截图和报告，不访问外部 API。`test:packaged` 对已经打包的 Windows EXE 执行同样的验证，需先完成 Windows 打包。

Windows 打包：

```sh
npm run build:win
```

正式分发时，先提交版本变更，再用 Python 3.11+ 整理分发目录和 ZIP：

```sh
python scripts/package-release.py
```

输出 `dist/DragonDesk-版本-windows-x64.zip` 及 SHA-256 校验文件。压缩包内使用 `DragonDesk/` 目录，自动附带使用说明、空白配置示例、版本信息和“许可与来源”，不打包个人配置或聊天数据。若程序正在运行，可将构建输出指向其他目录，再通过 `--app-dir` 指定该目录中的 `win-unpacked`。脚本会检查源码提交状态、程序资源版本、配置示例和压缩包完整性；不会覆盖已有分发包。

macOS 打包（在 Mac 上执行）：

```sh
npm install
npm run build:mac
```

生成 Apple Silicon、Intel 两种 ZIP 包。解压 `.app` 后放入“应用程序”。当前未配置开发者签名与公证；如要向他人正式分发，请配置自己的 Apple Developer 签名和 notarization。此项目在 Windows 上构建并测试；macOS 运行和登录项仍需在真机验收，不能在 Windows 上确认。

## 参考与素材

- [OpenAI Responses 流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[登录项](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)
- 龙娘图集来自 [weit0529/gpt-pet](https://github.com/weit0529/gpt-pet)，本项目未修改原图集，署名和许可见 `assets/ATTRIBUTION.md`。
- 鲸鱼娘 B 版图集来自 [Chih-Kai-Wang/deepseek-girl-codex-pet](https://github.com/Chih-Kai-Wang/deepseek-girl-codex-pet)，保留原图集及上游 MIT 许可，详见 `assets/ATTRIBUTION.md`、`assets/whale/LICENSE.txt`。
