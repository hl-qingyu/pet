# 桌宠素材来源

## 龙娘

- 图集来源：https://github.com/weit0529/gpt-pet
- 下载文件：`spritesheet.webp`（未改动原动画图集）
- 上游项目标注：社区创作者 ZipZipPipe、这个刀子真甜；非官方 GPT 龙娘二创。
- 上游发布的许可证原文保存在 `ARTWORK-LICENSE.txt`。图标由同一图集裁剪制作。
- 本项目是独立桌宠播放器，与 OpenAI、DeepSeek 及原角色作者不存在官方合作或背书关系。商标和原角色设计权利归各自权利人，发布衍生素材时请自行核对原作者的使用条件。

## 鲸鱼娘（B 版）

- 图集维护源：https://github.com/Chih-Kai-Wang/deepseek-girl-codex-pet
- 下载入口：https://github.com/Chih-Kai-Wang/dsh-deepseek-girl-pet
- 文件：`whale/spritesheet.webp`，基于上游图集清理跨帧的尾巴、头发碎片，保留 1536×2288、8×11 格及原有动作和视线方向。
- 上游 `atlas-source.json` 记录的维护源提交：`2572709632b0e81401b9e92994f2c3786c186397`，路径：`pet/spritesheet.webp`。
- 上游原图 SHA-256：`234f24a97c18195a00c6093da0090773e675993c169e92e7e13a24c37b323fa2`。
- 2026-11-10 修复了挥手、等待回应、检查结果中 5 帧残留的边缘尾巴 / 头发碎片，并清理极淡的孤立残影。未重画角色；所有保留的可见像素、16 个视线方向及中性头像均保持不变。图集以无损 WebP 编码。
- 当前图集 SHA-256：`47b6d236127a974919db5a7b895b8e00380f5bfb65890b980db6f66cd90227d7`。逐帧修复记录见 `whale/cleanup-report.json`，复现脚本为 `scripts/repair-whale-atlas.py` 和 `scripts/repair-whale-residue.py`，脚本使用每一阶段修复前图集的固定 SHA-256 校验来源。
- 2026-11-10 追加清理等待动作第 5 帧（row 6 / column 4）左侧的 353 像素尾巴残影；等待动作六帧与其他动作保持不变，16 个视线方向未改动。
- 上游图集声明采用 MIT License，版权署名为 `Copyright (c) 2026 f0909172434`；许可原文保存在 `whale/LICENSE.txt`。
- `whale/icon.png`、`whale/tray.png` 由同一图集的中性站姿（第 0 行第 6 列）裁剪、缩放制作。
- 鲸鱼娘社区原角色署名：上善无形；DeepSeek 女仆二次设计：ZipZipPipe。上游图集许可不改变原角色与商标的权利归属。
