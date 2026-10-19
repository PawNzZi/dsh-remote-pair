# dsh-remote-pair

给「Helm·DSH」手机端生成**配对链接与二维码**的 DeepSeek Harness 插件。

## 为什么需要它

DSH 的 Web 服务只监听 `127.0.0.1`，桌面版的端口还是随机的（`--port 0`），换证令牌只存在于 Host 进程内——不打印、不落盘、渲染层也看不见。手机既拿不到令牌，也访问不到回环地址。

插件运行在 Host 进程里，所以能直接拿到：

- `ctx.connection.authenticatedUrl(...)` —— 带 `token` 的完整地址；
- `ctx.webServer.port` —— 当前真实端口（包括桌面版的随机端口）。

它做三件事：

1. **局域网桥**：在 `0.0.0.0:<port>`（默认 8787）监听，把请求转发到 `127.0.0.1:<真实端口>`，并把 Host 改写成回环地址、剥掉 `Origin` / `Sec-Fetch-*`，让 DSH 的 Host 栅栏放行；WebSocket 也原样透传。
2. **`/pair` 页面**：`http://127.0.0.1:8787/pair` 显示二维码 + 可复制链接（只允许本机打开，令牌不会暴露给局域网）。
3. **`/pair` 斜杠命令**：在任意会话里发送，把配对链接交给 Agent，由它在**对话里**回复一条带链接的消息（可点击）。

## 安装

> 插件需要装进你实际在用的那个 profile：桌面版是 `desktop`，CLI 是 `web`。

### 桌面版（DeepSeek Harness 应用）

> 注意：新版 DSH 的 CLI 会拒绝 `dsh plugin --profile desktop ...`（desktop profile 由 Electron 应用独占管理），
> 请用桌面版的「插件」页安装，或按下述方式手动写入。**不要**同时写 bundle 和 patch insert，否则 `remote-pair` 会重复。

1. 安装依赖（用桌面版自带的 pnpm；`<本目录>` 换成绝对路径）：

```bash
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add <本目录>
```

2. 编辑同目录的 `package.json`，把包加入 bundle 列表（它会自动带上插件自带的 `cordis.patch.yml`）：

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-remote-pair"]
  }
}
```

3. 重新启动桌面版，访问 `http://127.0.0.1:8787/pair`。

> 也可以直接使用桌面版里的「插件管理器」安装本地插件，它会代为写入 bundle 列表。

### Web 版（CLI）

```bash
dsh plugin --profile web add <本目录路径或 npm 包名>
dsh web
```

`dsh plugin add` 会自动把 `dsh-remote-pair` 追加到 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
不需要再手动写 `insert` 片段。要改端口/公网地址时，在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: remote-pair
  config:
    port: 8787
    chatReply: true
```

## 使用

插件没有“启动按钮”。它是一个 Cordis 插件：DSH 启动时会按 profile 的插件树实例化它，
`apply(ctx, config)` 自动执行，桥在那一刻就开始监听，`/pair` 命令同时注册好。
所以「调起」= **重启 DSH**，之后用下面任意一种方式取链接：

1. 电脑浏览器打开 `http://127.0.0.1:8787/pair`（推荐，直接出二维码）；
2. 任意会话里发 `/pair`：插件会把配对地址交给 Agent，由 Agent 在**对话里**回复一条消息，
   里面是「二维码页面」和「手机配对链接」两行（Markdown 链接可点击）。
   这条回复由一次附加的模型调用产生（`chatReply: false` 可关掉，只在命令卡片里显示地址）；
3. 看 Host 日志，启动时会打印：
   ```
   [dsh-remote-pair] bridge listening on 0.0.0.0:8787 → 127.0.0.1:53458
   [dsh-remote-pair] 二维码页面：http://127.0.0.1:8787/pair
   [dsh-remote-pair] 手机可访问：http://192.168.0.23:8787
   ```

### 怎么确认它真的在跑

| 检查项 | 期望结果 |
| --- | --- |
| `curl http://127.0.0.1:8787/pair` | 返回一段 HTML（含二维码） |
| `netstat -ano \| findstr 8787` | 有进程在 LISTENING |
| 会话里发 `/pair` | 对话里出现一条带 `?token=` 的配对链接（同时有一张命令卡片） |
| Host 日志 | 有 `[dsh-remote-pair] bridge listening` 这一行 |
| `dsh plugin --profile desktop list`（或 `web`） | 列表里有 `dsh-remote-pair` |

### 装好了却“没反应”的常见原因

- **只装了包，没加 bundle**：包在 `node_modules` 里但没进 `dsh.profile.bundles`，`apply` 不会执行。
  需要 `package.json` 的 `dsh.profile.bundles` 里出现 `dsh-remote-pair`（或用插件管理器安装）。
- **装错 profile**：桌面版用 `desktop`，CLI 用 `web`；装到另一个 profile 里不算数。
- **端口被占用**：会顺延到 8788..8797，看日志里实际端口。
- **桌面版没完全退出**就执行 `dsh plugin`：profile 被占用，安装可能失败或没生效。
- **改完配置没重启**：`config` 是启动时读取的，改 `port`/`publicUrl` 后要重启 DSH。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件不做任何事 |
| `host` | `0.0.0.0` | 桥监听地址；只想本机用可改 `127.0.0.1` |
| `port` | `8787` | 桥端口；被占用时自动往后找最多 10 个 |
| `publicUrl` | `""` | 公网地址（花生壳/frp/Tailscale）。配了就用它生成二维码，否则用局域网 IP |
| `chatReply` | `true` | `/pair` 是否把配对地址交给 Agent、在对话里回复一条可点链接；`false` 则只在命令卡片里显示 |

### 人在外面：配合花生壳 / frp / Tailscale

把隧道指到桥端口（不是 DSH 的随机端口）：

```
花生壳/域名  →  127.0.0.1:8787
```

然后在配置里填：

```yaml
config:
  publicUrl: https://your-name.vicp.net
```

二维码里就是 `https://your-name.vicp.net/?token=…`，手机在外面也能扫。桥会把 Host 改写成 `127.0.0.1:<真实端口>`，所以 DSH 的 Host 栅栏与令牌换证都能通过。

## 安全

- `/pair` 页面只对本机（127.0.0.1 / ::1）开放，局域网里的其他人打不开它；
- 但**二维码/链接本身等于你桌面端的控制权**，不要截图外传；
- 桥默认监听 `0.0.0.0`：只想局域网内使用没问题；不想暴露就把 `host` 改成 `127.0.0.1`（那样只能配合本机隧道用）；
- 公网请使用 HTTPS，避免令牌在链路上明文传输；
- 怀疑泄露：重启 DSH，并在 `~/.dsh/.credentials.yaml` 里轮换 `browser-session` 密钥，使旧凭证全部失效。

## 卸载

```bash
dsh plugin --profile <web|desktop> remove dsh-remote-pair
```

并删掉 `cordis.patch.yml` 里对应的 `insert` 条目。

## 开发

```bash
# 用真实桌面版端口做上游，验证桥、鉴权、WebSocket 与二维码
node test/local-bridge.mjs 53458

# 端到端能力审计：经桥把手机端要用的每个 remote 都调一遍（需要 ws）
npm i ws
node test/audit.mjs
```

脚本会打印各项 PASS/FAIL，并把二维码导出到 `.tmp/qr-check.png`。

## 目录

```
dsh-remote-pair/
├── package.json
├── cordis.patch.yml      # 插件自带的插入片段
├── lib/
│   ├── index.js          # cordis 插件：配置、桥、/pair 命令
│   ├── bridge.js         # HTTP/WS 转发（Host 改写、/pair 页面）
│   ├── pair.js           # 局域网地址、二维码、页面模板
│   └── qr.cjs            # 内置二维码生成（qrcode-generator, MIT）
└── test/local-bridge.mjs
```

## 许可

MIT。内置的 `lib/qr.cjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（Kazuhiko Arase，MIT），见 `THIRD_PARTY_NOTICES.md`。
