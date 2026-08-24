# INSTALL.md

*[English version below ↓](#install-md-english)*

部署你自己的 NYCU Library MCP Wrapper 到 Cloudflare Workers 的完整步驟。這份指南以 **Open WebUI** 作為串接範例，因為它是本專案主要驗證過的 client；但這個 wrapper 本身是標準的 MCP server（OAuth 2.1 + Streamable HTTP），核心設定邏輯對任何支援 MCP 的 AI workspace（Claude、ChatGPT 等）都適用，只是連線設定畫面會不一樣，請參考該 client 自己的 MCP 連線文件。

## 前置需求

- 一個 [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)（免費層即可）
- Node.js 18+ 與 npm
- 一組有圖書館權限的 NYCU SSO 帳號（學號/工號 + 密碼）
- 一個支援 MCP（Streamable HTTP + OAuth 2.1）的 AI workspace，且有新增外部工具連線的管理權限——本指南以 Open WebUI 為例

---

## 1. Clone 專案並安裝套件

```bash
git clone <this-repo-url> nycu-library-mcp-wrapper
cd nycu-library-mcp-wrapper
npm install
```

會安裝的套件：`@cloudflare/workers-oauth-provider`、`agents`、`@modelcontextprotocol/server`、`@modelcontextprotocol/client`、`zod`，以及開發用的 `wrangler`。

## 2. 讓 `wrangler` 完成 Cloudflare 認證

**方式 A —— 瀏覽器互動登入（本機使用）：**
```bash
npx wrangler login
```
會開瀏覽器完成跟 Cloudflare 的 OAuth 授權。如果你是在**遠端 server** 上操作，這一步預設會失敗，除非你先做 port forwarding：
```bash
ssh -L 8976:localhost:8976 你的帳號@遠端伺服器
```

**方式 B —— API Token（建議用於遠端/無頭伺服器）：**
1. 前往 [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. 點 Create Token → 選 "Edit Cloudflare Workers" 範本（或自訂權限：`Workers Scripts: Edit`、`Workers KV Storage: Edit`、`Account Settings: Read`）
3. 在你的伺服器上：
   ```bash
   export CLOUDFLARE_API_TOKEN="<你的 token>"
   ```
4. 驗證：
   ```bash
   npx wrangler whoami
   ```

> 注意：認證資訊是綁在**執行的機器**上，不是綁在專案資料夾。如果你在另一台機器上部署，那台機器要重新認證一次。

## 3. 建立 KV namespace

```bash
npx wrangler kv namespace create "OAUTH_KV"
```

把回傳的 `id` 貼進 `wrangler.jsonc`：

```jsonc
{
  "name": "nycu-library-mcp-wrapper",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "<貼上你的 id>" }
  ]
}
```

這份檔案（含 KV id、account id）可以安全 commit——這些只是識別碼，不是憑證。

## 4. 不需要手動申請 OAuth 應用程式

跟一般 OAuth 串接不同，**你不需要跟陽明交大申請任何應用程式**。`mcp.lib.nycu.edu.tw` 支援 OAuth 2.1 Dynamic Client Registration（DCR）——wrapper 第一次使用時會自動註冊，並把拿到的 `client_id` 快取進 KV。這一步沒有任何需要手動設定的機密資訊。

你可以隨時自行驗證是否支援 DCR：
```bash
curl -s https://mcp.lib.nycu.edu.tw/.well-known/oauth-authorization-server | python3 -m json.tool
```
確認回應裡有 `registration_endpoint` 這個欄位。

## 5. 本機測試

```bash
npx wrangler dev
```

會在 `http://localhost:8787` 啟動 Worker，且連接的是**遠端**的正式 KV namespace（測試資料會留在正式 KV 裡，清理方式見第 8 步）。

用 [MCP Inspector](https://github.com/modelcontextprotocol/inspector) 測試完整的 OAuth + 工具呼叫流程（Inspector 是通用的 MCP client，這一步跟你之後要接哪個 AI workspace 無關）：
```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```
- Transport type：**Streamable HTTP**
- URL：`http://localhost:8787/mcp`
- 點 Connect → 會被導去 NYCU SSO 登入頁 → 成功後，Tools 分頁應該會看到四個工具：`search`、`fetch`、`reauth`、`remove_auth`

建議至少測過一次完整的 `reauth` 流程：先呼叫 `remove_auth` 清掉目前的授權，再呼叫 `search` 確認會收到「請重新授權」的提示，接著呼叫 `reauth` 拿到連結、在瀏覽器打開完成 NYCU 登入，最後重試 `search` 確認恢復正常。

如果你在遠端伺服器上測試，Inspector 的 port 也要照第 2 步（方式 A）做 forwarding。

## 6. 部署到 Cloudflare

```bash
npx wrangler deploy
```

會印出正式網址，例如：
```
https://nycu-library-mcp-wrapper.<你的子網域>.workers.dev
```

這個網址就是你之後要在任何 MCP client 裡填入的連線 URL（結尾加 `/mcp`）。

如果你之前本機測試時，用 `localhost` 當 redirect_uri 註冊過 `client_id` 並被快取進 KV，**部署前記得清掉**，否則正式環境的 OAuth 重新導向會對不上：
```bash
npx wrangler kv key delete "nycu_dcr_client_id" --namespace-id=<你的KV id> --remote
```

## 7. 接上你的 AI workspace

以下以 **Open WebUI** 為範例。原則上任何支援 MCP（Streamable HTTP + OAuth 2.1）的 client 設定邏輯都相同：填連線 URL、選 OAuth 2.1、走一次登入授權。

**Open WebUI**：**Settings → Integrations → MCP → Add Connection**

| 欄位 | 填入內容 |
|---|---|
| Type | MCP (Streamable HTTP) |
| Name | 任意，例如 `NYCU Lib Wrapper` |
| URL | `https://<你的 worker>.workers.dev/mcp` —— **一定要帶 `/mcp`** |
| Auth | OAuth 2.1 |

點 **Register Client**，應該會顯示 `Registered`（這是 Open WebUI 對你的 Worker 做 DCR，跟第 4 步 Worker 對陽明交大做的 DCR 是不同層）。存檔後在對話裡觸發一次工具呼叫，會被提示用 NYCU SSO 帳號登入一次。

**其他 MCP client**（例如 Claude、ChatGPT 的自訂連結器功能）：概念完全一樣——填入同一個 `https://<你的 worker>.workers.dev/mcp` URL、選擇 OAuth 2.1 認證方式，該 client 會自動走 DCR + PKCE 流程並跳出 NYCU 登入頁。具體設定畫面請參考該 client 自己的說明文件，因為每家介面不同，但底層協定完全相容。

## 8. 部署後整理（非必要）

清掉本機開發過程累積的測試資料：
```bash
npx wrangler kv key list --namespace-id=<你的KV id> --remote
npx wrangler kv key delete "<過期的key>" --namespace-id=<你的KV id> --remote
```
這不是必須的動作——殘留的 key（舊的 `nycu_token:*`、`pkce:*`、`reauth_nonce:*`）不會造成任何衝突，設過 TTL 的會自動過期，token 本身也會在約 3 天後自然失效。

---

## `.gitignore`

專案裡附的 `gitignore.txt`，下載後請重新命名為 `.gitignore`（大部分作業系統/檔案系統不允許直接把檔案存成沒有主檔名、只有副檔名的形式，所以用這個檔名產生，記得改名）再放到專案根目錄。內容排除了 `node_modules/`、`.wrangler/`、`.dev.vars`、`.env`、自動產生的 `worker-configuration.d.ts` 等，確保機密和暫存檔案不會進 git。

## 版權

本專案程式碼採用 MIT License，詳見 [LICENSE](./LICENSE)（下載後請把檔名從 `LICENSE.txt` 改成 `LICENSE`，去掉副檔名）。這只授權程式碼本身，不代表可用「陽明交通大學」或「NYCU」名稱／商標宣稱官方關係，也不豁免你使用陽明交大圖書館服務時應遵守的校方使用條款，詳見 LICENSE 檔案中的 NOTICE 段落。

---

## 疑難排解

| 症狀 | 可能原因／解法 |
|---|---|
| `Cannot read properties of undefined (reading 'parseAuthRequest')` | 在 `auth-handler.ts` 裡用了 `ctx.OAUTH_PROVIDER`，應該是 `env.OAUTH_PROVIDER`。 |
| `Could not resolve "workers-oauth-provider"` | 套件名稱有 scope：`@cloudflare/workers-oauth-provider`，不是 `workers-oauth-provider`。 |
| `Could not find McpAgent binding for MCP_OBJECT` | 用了已被棄用的 `McpAgent`/Durable Object 架構。改用 `agents/mcp` 的 `createMcpHandler`（見 `src/mcp-server.ts`），不需要 Durable Object binding。 |
| `Could not resolve "@modelcontextprotocol/sdk"` | 這個套件已經拆分成 `@modelcontextprotocol/server`（server 端）跟 `@modelcontextprotocol/client`（呼叫 upstream 用），確認 `package.json` 跟 import 語句都改用新套件名稱。 |
| `/mcp` 回 `404 Not Found` | 檢查 `index.ts` 裡的 `apiRoute` 跟你實際呼叫的路徑是否一致，也確認你的 AI workspace 填的 URL 有帶 `/mcp`。 |
| `reauth` 連結打開後顯示「此連結已失效或已使用過」 | nonce 已經被用過一次，或超過 10 分鐘 TTL 過期了——正常行為，回到聊天視窗重新呼叫一次 `reauth` 取得新連結即可。 |
| 你的 AI workspace 顯示籠統的 `Failed to connect to MCP server` | 開著 `npx wrangler tail` 重新連線一次，看真正的請求/回應內容。常見原因是 KV 裡快取了用 `localhost` 註冊的舊 `client_id`（見第 6 步）。 |
| 用了約 3 天後突然失效 | 正常現象——NYCU token 沒有 refresh grant。請模型呼叫 `reauth` 取得重新登入連結，或直接跟模型說「重新授權」。 |

架構細節與上游回應結構請見 [SPEC.md](./SPEC.md)。

---

# INSTALL.md (English)

Step-by-step guide to deploy your own copy of the NYCU Library MCP Wrapper on Cloudflare Workers. This guide uses **Open WebUI** as the worked example, since it's the client this project has been primarily validated against. The wrapper itself is a standard MCP server (OAuth 2.1 + Streamable HTTP), so the core setup logic applies to any MCP-compatible AI workspace (Claude, ChatGPT, etc.) — only the connection settings screen will differ; consult that client's own MCP connection docs.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- Node.js 18+ and npm
- An NYCU SSO account (student/staff ID + password) with library access
- An AI workspace that supports MCP (Streamable HTTP + OAuth 2.1) with admin access to add external tool connections — this guide uses Open WebUI as the example

---

## 1. Clone and install dependencies

```bash
git clone <this-repo-url> nycu-library-mcp-wrapper
cd nycu-library-mcp-wrapper
npm install
```

Dependencies installed: `@cloudflare/workers-oauth-provider`, `agents`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `zod`, plus `wrangler` as a dev tool.

## 2. Authenticate `wrangler` with Cloudflare

**Option A — interactive login (local machine):**
```bash
npx wrangler login
```
This opens a browser to complete OAuth with Cloudflare. If you're working on a **remote server**, this will fail unless you forward the port it listens on:
```bash
ssh -L 8976:localhost:8976 you@remote-server
```

**Option B — API Token (recommended for remote/headless servers):**
1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create Token → "Edit Cloudflare Workers" template (or custom: `Workers Scripts: Edit`, `Workers KV Storage: Edit`, `Account Settings: Read`)
3. On your server:
   ```bash
   export CLOUDFLARE_API_TOKEN="<your token>"
   ```
4. Verify:
   ```bash
   npx wrangler whoami
   ```

> Note: authentication is tied to the **machine** you run it on, not the project directory. If you deploy from a different machine than the one you authenticated on, you'll need to authenticate again there.

## 3. Create the KV namespace

```bash
npx wrangler kv namespace create "OAUTH_KV"
```

Copy the returned `id` into `wrangler.jsonc`:

```jsonc
{
  "name": "nycu-library-mcp-wrapper",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "<paste-your-id-here>" }
  ]
}
```

This file (including the KV id and account id) is safe to commit — these are identifiers, not credentials.

## 4. No manual OAuth app registration needed

Unlike typical OAuth integrations, **you do not need to register an app** with NYCU. `mcp.lib.nycu.edu.tw` supports OAuth 2.1 Dynamic Client Registration (DCR) — the wrapper registers itself automatically on first use and caches the resulting `client_id` in KV. There are no secrets to configure for this step.

You can independently verify DCR support at any time:
```bash
curl -s https://mcp.lib.nycu.edu.tw/.well-known/oauth-authorization-server | python3 -m json.tool
```
Look for a `registration_endpoint` field.

## 5. Run locally and test

```bash
npx wrangler dev
```

This starts the Worker at `http://localhost:8787`, connected to your **remote** KV namespace (test data will persist to production KV — see step 8 for cleanup notes).

Test the full OAuth + tool-call flow with [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — Inspector is a generic MCP client, so this step is independent of which AI workspace you'll eventually connect:
```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```
- Transport type: **Streamable HTTP**
- URL: `http://localhost:8787/mcp`
- Connect → you'll be redirected through NYCU SSO login → on success, four tools should appear in the Tools tab: `search`, `fetch`, `reauth`, `remove_auth`.

It's worth exercising the full `reauth` path at least once: call `remove_auth` to clear your current authorization, call `search` and confirm you get a "please re-authenticate" prompt, call `reauth` to get a link, open it in a browser and complete NYCU login, then retry `search` and confirm it works again.

If you're testing from a remote server, forward the Inspector's local port the same way as in step 2 (Option A).

## 6. Deploy to Cloudflare

```bash
npx wrangler deploy
```

This prints your live URL, e.g.:
```
https://nycu-library-mcp-wrapper.<your-subdomain>.workers.dev
```

This is the URL you'll enter into any MCP client's connection settings (append `/mcp`).

If you previously tested locally and cached a `client_id` in KV using a `localhost` redirect URI, **clear it** before relying on the production URL, otherwise the OAuth redirect will mismatch:
```bash
npx wrangler kv key delete "nycu_dcr_client_id" --namespace-id=<your-kv-id> --remote
```

## 7. Connect to your AI workspace

The example below uses **Open WebUI**. In principle, the setup logic is the same for any MCP (Streamable HTTP + OAuth 2.1) compatible client: enter the connection URL, select OAuth 2.1, and complete the login/authorization flow once.

**Open WebUI**: **Settings → Integrations → MCP → Add Connection**

| Field | Value |
|---|---|
| Type | MCP (Streamable HTTP) |
| Name | anything, e.g. `NYCU Lib Wrapper` |
| URL | `https://<your-worker>.workers.dev/mcp` — **must include `/mcp`** |
| Auth | OAuth 2.1 |

Click **Register Client** — it should show `Registered` (this is Open WebUI performing DCR against your Worker, separate from the Worker↔NYCU DCR in step 4). Save, then trigger a tool call from a chat — you'll be prompted to log in with your NYCU SSO account once.

**Other MCP clients** (e.g. Claude's or ChatGPT's custom connector features): the concept is identical — enter the same `https://<your-worker>.workers.dev/mcp` URL, choose OAuth 2.1 authentication, and the client will automatically perform DCR + PKCE and prompt the NYCU login page. Refer to that client's own documentation for the exact settings screen, since UIs differ, but the underlying protocol is fully compatible.

## 8. Post-deploy hygiene (optional)

Clean up test data accumulated during local development:
```bash
npx wrangler kv key list --namespace-id=<your-kv-id> --remote
npx wrangler kv key delete "<stale-key>" --namespace-id=<your-kv-id> --remote
```
This is not required for correct operation — leftover keys (old `nycu_token:*`, `pkce:*`, `reauth_nonce:*`) don't conflict with anything and expire on their own (all of them carry TTLs), or simply go stale (tokens become invalid after ~3 days regardless).

---

## `.gitignore`

The included `gitignore.txt` should be renamed to `.gitignore` after download (generated with a `.txt` extension since dotfiles-only names aren't directly supported by the file creation tool) and placed at the project root. It excludes `node_modules/`, `.wrangler/`, `.dev.vars`, `.env`, the auto-generated `worker-configuration.d.ts`, and OS/editor noise, so secrets and temp files never get committed.

## License

This project's code is licensed under the MIT License — see [LICENSE](./LICENSE) (rename the downloaded `LICENSE.txt` to `LICENSE`, dropping the extension). This covers the code only — it does not grant any right to use the "National Yang Ming Chiao Tung University" or "NYCU" names/marks implying official affiliation, nor does it exempt you from NYCU Library's own terms of service. See the NOTICE section inside the LICENSE file.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Cannot read properties of undefined (reading 'parseAuthRequest')` | You're accessing `ctx.OAUTH_PROVIDER` instead of `env.OAUTH_PROVIDER` in `auth-handler.ts`. |
| `Could not resolve "workers-oauth-provider"` | Package name is scoped: `@cloudflare/workers-oauth-provider`, not `workers-oauth-provider`. |
| `Could not find McpAgent binding for MCP_OBJECT` | You're using the deprecated `McpAgent`/Durable Object path. Switch to `createMcpHandler` from `agents/mcp` (see `src/mcp-server.ts`) — no Durable Object binding needed. |
| `Could not resolve "@modelcontextprotocol/sdk"` | That package has been split into `@modelcontextprotocol/server` (server side) and `@modelcontextprotocol/client` (used to call the upstream). Update `package.json` and your imports to use the new package names. |
| `404 Not Found` on `/mcp` | Check `apiRoute` in `index.ts` matches the path you're calling, and that your AI workspace's configured URL includes `/mcp`. |
| Opening a `reauth` link shows "this link has expired or already been used" | The nonce was already consumed, or its 10-minute TTL expired — this is expected. Go back to the chat and call `reauth` again for a fresh link. |
| Your AI workspace shows a generic `Failed to connect to MCP server` | Run `npx wrangler tail` while retrying to see the real request/response. Common cause: a stale `nycu_dcr_client_id` registered with a `localhost` redirect URI (see step 6). |
| Everything worked, then stopped after ~3 days | Expected — NYCU tokens have no refresh grant. Ask the model to call `reauth`, or just tell it to "re-authenticate." |

For architecture details and upstream response schemas, see [SPEC.md](./SPEC.md).
