# 优选AI

Chrome 扩展（Manifest V3，纯 JS 无构建）：一个输入框同时问 Claude / ChatGPT / Gemini 网页版并对比回答。
GitHub 仓库：https://github.com/erniaodoudoufei/youxuan-ai （公开）

## 每次完成功能或修复后都要发布
用户希望每次更新后自动发布到 GitHub，不需要再单独询问：
1. 按改动大小提升 `manifest.json` 的 `version`（新功能升第二位，如 0.2.0 → 0.3.0；修复升第三位，如 0.3.0 → 0.3.1）。
2. 用 `node --check` 检查改过的 JS 文件。
3. 提交（提交信息用中文概括改动）。
4. 运行 `bash scripts/release.sh`：推送代码，并为新版本号创建 GitHub Release（附可安装的 zip）。
5. 告诉用户新版本号和 Release 链接，并提醒在 `chrome://extensions` 点刷新。

## 适配网站
- 各网站的页面选择器都集中在 `sites.js`；网站改版时优先只改这里。
- 修改选择器前用 Claude in Chrome 只读查看用户已登录的真实页面，不要凭经验猜。
- 插件的工作标签页在后台，`setTimeout` 会被 Chrome 限速；内容脚本里等待一律用 `sleep()`（由 background.js 代为计时）。
