# EchoLens Model Gateway

独立的远程模型访问服务。它只代理服务端固定配置的模型上游，不读取工作区、不执行
文件工具或 Shell，也不保存客户端 Session/Event Store。

## 本地运行

服务启动前必须显式配置审批密钥和对应协议的上游 API Key：

```powershell
$env:GATEWAY_DEVICE_APPROVAL_SECRET = '仅在本机设置'
$env:GATEWAY_UPSTREAM_API_KEY = '仅在本机设置'
npm run gateway:server
```

默认监听 `127.0.0.1:8787`。生产环境应通过 HTTPS 反向代理暴露服务，不应直接公开
Node.js 监听端口。完整无秘密配置样例和 systemd/Nginx 模板见 `deploy/`。

## 协议配置

- `GATEWAY_PROTOCOLS`：逗号分隔的 `chat_completions`、`responses`。
- `GATEWAY_DEFAULT_PROTOCOL`：客户端模型目录采用的默认协议。
- `GATEWAY_UPSTREAM_CHAT_BASE_URL` / `GATEWAY_UPSTREAM_CHAT_API_KEY`：Chat 上游。
- `GATEWAY_UPSTREAM_RESPONSES_BASE_URL` / `GATEWAY_UPSTREAM_RESPONSES_API_KEY`：Responses 上游。
- `GATEWAY_UPSTREAM_BASE_URL` / `GATEWAY_UPSTREAM_API_KEY`：两种协议共用时的后备配置。

客户端不能提交或覆盖实际上游地址。`base_url`、`provider_url`、`upstream_url`、
`endpoint`、`api_key`、`authorization` 和 `headers` 字段会在转发前移除。

## 登录与凭据

```powershell
npm run gateway:login -- --url http://127.0.0.1:8787
npm run gateway:status -- --url http://127.0.0.1:8787
npm run gateway:refresh -- --url http://127.0.0.1:8787
npm run gateway:logout -- --url http://127.0.0.1:8787
```

`GATEWAY_DEVICE_APPROVAL_SECRET` 保护开发版 Device Flow 审批页；未配置时服务拒绝启动。
Windows 客户端使用当前用户范围的 DPAPI 文件 `%LOCALAPPDATA%\EchoLens\gateway-token.dpapi`。
非 Windows 客户端首版使用权限为 `0600` 的用户级 `~/.echolens/gateway-token.json`。
Token 不写入项目 `.env.local`，该文件只保存 `gateway-token:default` 凭据引用。

## 状态与边界

Gateway 使用 SQLite 保存哈希后的 Access/Refresh Token、Device Flow 状态和按 UTC 月份
分桶的用量。默认日志只有账号、模型、协议、状态、延迟、Usage 和 Request ID 元数据，
不记录 Prompt、源码、工具结果或模型完整输出。

当前部署单元适合单实例或粘性流量。水平扩展前应把账号限流迁移到共享存储，并使用
云 Secret Manager 管理上游 Key。生产账号系统还应替换开发版审批密钥页面。
