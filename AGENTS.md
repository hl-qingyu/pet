# 项目协作约定

## 版本号与 GitHub Releases 发布

- 发布新版前必须更新 `package.json` 的 `version`，并同步更新 `package-lock.json`；可执行 `npm version <新版本号> --no-git-tag-version`，再提交并推送版本文件及本次改动。
- Windows 和 Mac 云端打包统一使用 `.github/workflows/build-mac.yml`，推送代码后在 GitHub Actions 中通过 `Run workflow` 选择对应分支运行；两个平台并行构建，全部成功后统一发布。
- Windows 使用 `npm run build:win -- --publish never`，再通过 `python scripts/package-release.py` 生成 ZIP 和 SHA256 校验文件并检查隐私文件；与 Mac 的两个 ZIP 一起上传到对应版本 Release。云端构建不替代本地 Windows 打包与交付要求。
- 工作流按构建代码中 `package.json` 的版本号，将产物发布到 `DragonDesk-<版本号>` 对应的 GitHub Release；不存在时创建，存在时更新附件。
- 分别上传 arm64 和 x64 的 ZIP，供 Apple M 系列和 Intel Mac 用户单独下载；同时保留 Actions 构建产物。
- 同一版本重复打包会覆盖 Release 中的同名 ZIP；正式发布新版必须先升级版本号，避免覆盖旧版产物。
- 发布使用工作流内置的 `github.token` 及 `contents: write` 权限，无需配置个人访问令牌；electron-builder 保持 `--publish never`，由工作流的 Release 步骤统一上传。

## Git 提交

- 所有 Git commit 的标题和正文均使用中文描述更新内容。
- 模型名、文件名、命令和其他必要的技术标识可保留原文。
- 提交说明应准确概括实际改动，并在需要时说明验证结果。

## Windows 打包与交付

- 最终 Windows 成品必须更新到项目原目录 `dist/win-unpacked`，使用 `npm run build:win` 打包。
- `work` 只能用于临时构建或验证，不能作为最终交付目录；验证完成后必须更新原目录并验证原成品。
- 保持根目录 `启动桌宠.cmd` 作为启动入口，沿用根目录 `config.json`，不要求用户改用临时目录中的启动脚本。
- 更新时处理好运行中的桌宠进程占用，保留用户配置和数据；需要重启时启动原目录中的新版。
## 更新与打包

- 更新代码或打包时，如果本项目已启动的应用造成文件占用、阻止覆盖或影响验证，可直接关闭对应的 DragonDesk 应用进程，无需再次确认；不要关闭其他无关应用。
- 每次代码更新完成后，必须执行 `npm run build:win`，将 Windows 版本打包到原目录 `dist/win-unpacked`。
- 打包失败时应排查并修复后重试，确认打包成功再报告完成。
- 更新并打包成功后，自动重启原目录 `dist/win-unpacked/DragonDesk.exe`，无需再次确认；若旧实例仍在运行，先关闭对应实例再启动新版。桌宠属于需要显示界面的应用，必须按正常窗口方式启动；禁止对 DragonDesk 使用 -WindowStyle Hidden。优先通过工作区的「启动桌宠.vbs」启动，该脚本使用正常窗口模式且不弹出终端。
- 自动重启必须沿用原实例的配置文件路径，不得因切换到打包目录而使用空白配置。本工作区日常使用 `D:\Project\pet\config.json`，启动打包版时传入 `--config=D:\Project\pet\config.json`；若原实例明确使用其他配置，则保留该路径。
