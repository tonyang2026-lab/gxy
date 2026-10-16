# 小星 · Windows AI 桌宠

形象采用原创黄色墨镜机器人特工，配有待机浮动、思考摇摆和回答致意动效（单张透明图片配合 CSS 动画）。素材位于 `src/assets/agent-pet.png`。

Electron 桌宠原型：透明置顶窗口、拖动、全局快捷键、AI 对话、截图预览后提问。
目前提供回答和操作建议，不会自动点击、输入或修改文件。窗口目前包含聊天面板，尚未实现收起成独立小宠物或鼠标穿透。

## Windows 开发

安装 Node.js 24 LTS，然后在仓库目录运行：

```powershell
npm ci
npm start
```

点击 ⚙，填写兼容 OpenAI Chat Completions 的 HTTPS 接口（默认 `https://api.openai.com/v1`）、模型名称和自己的 API 密钥。截图分析需要所选服务和模型支持图片输入；服务可能产生费用。
密钥使用 Electron safeStorage 调用系统加密后保存在应用用户数据目录，不写入仓库。没有内置密钥，也没有模拟 AI 回答。

- 拖动标题栏移动窗口；窗口始终置顶。
- 点击减号隐藏，按 `Ctrl + Shift + Space` 呼出；点击 × 完全退出。
- 点击“截取屏幕”捕获鼠标所在显示器，检查预览后点击“发送”。截图不自动上传，可以移除。
- Enter 发送，Shift + Enter 换行。清空会删除当前内存中的对话与截图。
- 对话和截图会发送至设置中的 API 服务，请仅填写可信地址。截图不会写入本地文件；后续对话保留文本，不重复发送先前截图。

## 验证和打包

```powershell
npm test
npm run build:win
```

安装程序输出在 `dist/`。未配置代码签名，Windows 可能提示未知发布者。
`.github/workflows/windows.yml` 可在 Windows runner 上测试、构建并保留安装包；需要先把代码推送到 GitHub，当前不会自动替你推送。

Node 测试覆盖请求组装、密钥保留、接口校验和消息角色校验，使用隔离的 Electron/API 替身，不代表真实模型连通或 Windows 桌面功能验证。

## 网络代理

AI 请求使用 Electron 网络接口，跟随 Windows 系统代理。使用 v2rayN 时保持其运行并开启“自动配置系统代理”，更改代理后重启桌宠。无需将 API 接口地址改为本地代理地址。
