# QQ 本地模型机器人（官方 Webhook 原型）

用 Ollama 在自己的电脑生成回答，不需要 OpenAI API 密钥或额度。支持QQ官方的群@消息回调、本地“是否值得回复”判断测试、去重和队列。电脑、Ollama和本程序需要持续运行。它是独立的本地模型助手，不会继承当前ChatGPT会话、文件或技能。

**权限边界：本次核对的官方公开QQ群文档列出 `GROUP_AT_MESSAGE_CREATE`，没有可直接假定拥有的全部普通群消息事件。程序只接入被@的群消息。普通消息选择性回复目前仅能在控制台模拟，不读取真实群聊。频道私域的 `MESSAGE_CREATE` 不能当作QQ群权限使用。** 若以后平台为你的应用开放普通群事件，需要根据真实事件和发送权限另行适配，不是打开一个配置开关即可绕过。

## 先在本机运行

1. 安装 [Node.js 24 LTS](https://nodejs.org/) 和 [Ollama Windows版](https://ollama.com/download/windows)。
2. 启动Ollama，在Windows命令提示符执行：

   ```bat
   ollama pull qwen2.5:3b
   ```

   首次需下载模型。建议电脑至少8GB内存；资源紧张可改用 `qwen2.5:1.5b`，并在本机 `.env` 修改 `OLLAMA_MODEL`。实际速度取决于硬件。
3. 在源码根目录双击 **启动QQ机器人.bat**。第一次会复制 `.env.example` 为 `qq-local-bot/.env`，默认只是本地测试，不发QQ消息。没有额外npm依赖需要安装。
4. 浏览器会自动打开带本机控制台令牌的地址。点击刷新，确认模型就绪。
5. 输入一条消息：勾选“@了机器人”测试回答；取消勾选测试是否值得主动参与。模拟消息不发送到QQ。

手动启动：

```bat
cd qq-local-bot
npm start
```

控制台地址打印在启动窗口；只在本机使用，不要转发包含令牌的完整地址。重启后令牌会变化，请使用新启动窗口的地址。关闭启动窗口会停止程序，尚未完成的回复不会继续发送。

## 真实接入QQ群，需要管理员配合

你不必是群主才能写程序，但需要有可用的QQ机器人开发者应用，并请目标群管理员按平台提供的方式授权、添加机器人。资质、可用群类型、测试范围、审核发布要求以后台实际开放能力为准。

1. 在 [QQ机器人开放平台](https://q.qq.com/)创建支持群聊的机器人应用，获取AppID、AppSecret。**只填在本机 `.env`，不要提交Git、发到聊天或截图公开。** `.env`和本机数据目录已加入忽略规则。
2. 把本机服务通过你已有的反向代理/安全隧道接到可访问的HTTPS域名，提供 `https://你的域名/qq/events`。只填本机127.0.0.1地址，QQ服务器无法访问。HTTPS证书必须正常；本程序不提供公网域名、证书、隧道服务或云服务器。
3. 在开放平台订阅“群@消息”事件并配置回调。程序处理 `op=13` 地址验证及Ed25519签名；其余业务事件需要验签和5分钟内签名时间戳。应用ID须匹配。
4. 编辑本机 `qq-local-bot/.env`：

   ```dotenv
   QQ_LIVE=true
   QQ_APP_ID=你的应用ID
   QQ_APP_SECRET=你的应用密钥
   QQ_SANDBOX=true
   QQ_ALLOWED_GROUPS=
   ```

   若后台单独提供回调验签Secret，可设置 `QQ_WEBHOOK_SECRET`；否则使用AppSecret。沙箱/正式环境须与平台一致。
5. 重启程序，在平台配置允许的测试群，由群成员@机器人发送一条消息。此时允许列表为空，不会回复；本机控制台会显示收到事件中的 `group_openid`。
6. 将该 `group_openid` 填到 `QQ_ALLOWED_GROUPS` 后重启。它不是QQ群号码。多个值用英文逗号隔开。仅当你明确要回复所有已经授权添加机器人的群时才填 `*`。
7. 再@机器人发送测试问题。正式上线、正式API域名与群范围需要符合平台设置后再将 `QQ_SANDBOX=false`。

反向代理只开放回调路径，勿把本机控制台作为公共网页发布。示意（Caddy，与本机服务在同一台可达主机时）：

```caddyfile
bot.example.com {
    handle /qq/events {
        reverse_proxy 127.0.0.1:3939
    }
    handle {
        respond 404
    }
}
```

## 回复规则

- 官方QQ群@事件在群允许列表和频率限制内回复；普通群消息或未授权群不调用模型、不发送。
- 单个用户5秒内重复请求会跳过，全局同时最多5个等待/处理中请求。生成后再次检查消息时限，超过4分钟不发送，避免过期回复。
- 本地普通消息模拟：先过滤闲聊和非求助内容，再由本地模型返回JSON判断；模型自评分至少0.85才建议回复。模型不确定、报错、格式不符时沉默。自动参与模拟有60秒群级冷却，不代表已获得QQ全量消息权限。
- 内存对话按群和发送人隔离，只带最近3轮，超过10分钟不再作为上下文。群友消息不会自动执行命令或触发电脑操作。
- 模型输入不包含机器人密钥，不具备实时网页、跨群读取、管理群或操作电脑能力。模型回答仍可能错误。
- 不保存消息正文或完整回调日志；只持久保存消息ID哈希、去重状态和过期时间，内存上下文随程序退出清除。
- 同一消息只尝试发送一次，网络发送失败不盲目重试。回调快速确认，随后在内存队列处理；崩溃/关机可能丢失已确认但未完成的请求，原型不承诺可靠持久投递。请重新发送新的@消息。

## 测试与证据

```bat
cd qq-local-bot
npm test
```

测试使用本地假模型和QQ接口替身，实际运行HTTP服务验证回调，并对照QQ官方公开Ed25519公钥和握手签名向量。未接入真实群、未用真实应用凭证、未在当前云机运行Ollama模型；模型生成质量和QQ群联通性需要在配置好的电脑与平台实测。

参考官方来源（核对于2026-10-29，具体权限仍以后台为准）：

- [QQ官方事件推送文档](https://github.com/tencent-connect/bot-docs/blob/645787a45937e5d9c4f0f61afefdffde0f38696e/docs/develop/api-v2/dev-prepare/interface-framework/event-emit.md)：Webhook HTTPS回调与群@事件；文档明确WebSocket链路逐步下线。
- [QQ官方Ed25519验签算法](https://github.com/tencent-connect/bot-docs/blob/645787a45937e5d9c4f0f61afefdffde0f38696e/docs/develop/api-v2/dev-prepare/interface-framework/sign.md)。
- [官方Python SDK群消息发送接口](https://github.com/tencent-connect/botpy/blob/e25f3e84bad7217357d8200a9d12939b58285b84/botpy/api.py)，[鉴权实现](https://github.com/tencent-connect/botpy/blob/e25f3e84bad7217357d8200a9d12939b58285b84/botpy/robot.py)。本项目依其HTTP协议实现，不依赖已过时的WebSocket连接。
