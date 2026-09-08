## 🚀 katabump 自动续期（GitHub Actions）

这是一个基于 GitHub Actions 的自动化脚本，用于定时登录自动续期[katabump](https://dashboard.katabump.com) 应用。

⚠️ 有cf盾,太垃圾的机房节点可能过不了，建议用稍微干净点的节点。

━━━━━━━━━━━━━━━━━━━━━

🔐 Secrets 配置说明

| Secret 名称         | 是否必填 | 说明                                              |
|---------------------|----------|---------------------------------------------------|
| USERS_JSON         | ❌ 可选  | 多账号 JSON（配置后优先于单账号，格式见下）        |
| KATABUMP_EMAIL     | ❌ 可选  | katabump 登录邮箱（未配置 USERS_JSON 时使用）      |
| KATABUMP_PASSWORD  | ❌ 可选  | katabump 登录密码（未配置 USERS_JSON 时使用）      |
| NODE_LINK          | ❌ 可选  | 代理分享链接（与 HTTP_PROXY 二选一）vless:// vmess:// tuic:// hysteria2:// anttls:// socks5:// |
| HTTP_PROXY         | ❌ 可选  | HTTP(S) 代理地址，如 http://127.0.0.1:7890（脚本优先读取）|
| TG_BOT_TOKEN       | ❌ 可选  | Telegram Bot Token（用于发送通知）                     |
| TG_CHAT_ID         | ❌ 可选  | Telegram Chat ID（接收通知的用户或群组 ID）              |

━━━━━━━━━━━━━━━━━━━━━━
### 多账号（USERS_JSON）

配置 `USERS_JSON` 可一次续期多个账号（脚本会为每个账号独立登录续期）：

```json
[{"username": "your_email@example.com", "password": "your_password"}, {"username": "another@example.com", "password": "pwd"}]
```

未配置 `USERS_JSON` 时，使用 `KATABUMP_EMAIL` + `KATABUMP_PASSWORD` 单账号。

### 代理格式（确认在v2rayN里使用正常的节点）

`NODE_LINK` 支持以下任意一种代理协议的完整分享链接（不配置则直连）：

- **VLESS**：`vless://uuid@server:port?security=reality&sni=...&type=ws&...`
- **VMess**：`vmess://base64encoded...`
- **Trojan**：`trojan://password@server:port?sni=...&type=ws&...`
- **tuic**：`tuic://uuid:password@server:port...`
- **anytls**：`anytls://uuid@server:port...`
- **hysteria2**：`hysteria2://base64@server:port...`
- **SOCKS5**：`socks5://user:pass@server:port` 或 `socks://user:pass@server:port`

`HTTP_PROXY` 支持直接的 HTTP(S) 代理地址（如 `http://user:pass@host:port`），配置后脚本优先读取它；
不配置时回退到 `NODE_LINK`（sing-box 方案）或直连。

### 注意事项
- 尽量添加一个干净的节点，以免过不了cf盾
- cron时间根据自己的服务到期时间的前一天来修改

━━━━━━━━━━━━━━━━━━━━━━
## 🙏 鸣谢

- 过盾与续期方案参考自 [eooce/katabump-renew](https://github.com/eooce/katabump-renew)，感谢原作者 [eooce](https://github.com/eooce) 的分享与维护。
