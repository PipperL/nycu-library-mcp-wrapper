# NYCU Library MCP Wrapper

*[English version below ↓](#nycu-library-mcp-wrapper-english)*

一個部署在 Cloudflare Workers 上的 wrapper，包裝[陽明交大圖書館 MCP server](https://mcp.lib.nycu.edu.tw/)，把它回傳的 UI 導向結構化結果（例如 `viewType: "catalog"`、借閱帳戶儀表板）正規化成 Markdown 與結構化內容，確保**任何支援 MCP 的 AI workspace**（Open WebUI、Claude、ChatGPT 等）都能讓模型完整看到逐筆資料，不只是一句摘要——完全不需要修改任何前端。

> **本專案與國立陽明交通大學無官方關係。** 這是使用你個人 NYCU SSO 帳號串接圖書館公開 MCP 服務的個人整合專案，使用前請自行評估風險，詳見下方[安全性說明](#安全性說明)。

## 為什麼需要這個專案

陽明交大圖書館的 MCP server 回傳的是很豐富的結構化資料（書籍清單含館藏地點、可借閱狀態、借閱／預約儀表板等）。有些 MCP client 會把這類 UI 導向的結構化結果原生渲染成卡片——**但這只是前端顯示層的事**。即使前端顯示了漂亮的卡片，**模型本身收到的 context 未必包含完整資料**：以 Claude 網頁版為例，前端渲染出卡片，但模型實際看到的 tool result 內容，很可能仍然只是一句類似 `Displaying 10 catalog item(s).` 的摘要文字。Open WebUI 目前甚至連前端渲染都沒有，使用者也什麼都看不到。

換句話說，這不是單一 client 的問題，而是**任何依賴 tool result 裡 `content` 欄位的 MCP client 都可能遇到的通用問題**：卡片渲染跟模型可見性是兩件獨立的事。

這個 wrapper 插在你的 AI workspace 和真正的陽明交大圖書館 MCP server 之間，做到：

- 把完整、可讀的資訊（書名、作者、各校區館藏狀態、館藏號、連結）直接寫進 tool result 的 `content` 文字欄位，讓**任何 MCP client 的模型都保證看得到完整逐筆資料**，不依賴該 client 是否支援卡片渲染
- 同時在有支援 Markdown 顯示的 client（如 Open WebUI 的聊天視窗）裡，這份 `content` 本身就是可讀的呈現方式
- 保留原始上游 payload 方便除錯
- 幫你處理完整的 OAuth 2.1 授權流程，包括過期後的一鍵重新授權（見下方「功能」）
- 部署在 Cloudflare Workers 免費層——常駐運行，不需要自己維護伺服器

## 功能

| 工具 | 說明 |
|---|---|
| `search` | 搜尋圖書館館藏。支援分頁（`offset`）、篩選（`resource_type`、`access`、`scope`、`sort`），以及控制對話框內顯示筆數的 `max` 參數。 |
| `fetch` | 查詢你的帳戶儀表板——目前借閱中、預約中、採購申請，含到期日與各項狀態。 |
| `reauth` | 當 NYCU 授權過期時呼叫，取得一次性、10 分鐘內有效的重新登入連結——不需要重新走一次完整的 MCP 連線設定。 |
| `remove_auth` | 手動清除目前快取的 NYCU 授權，用於登出或懷疑授權異常時。 |

`search`／`fetch` 都會回傳：
- **`content`** —— 完整、可直接顯示的 Markdown，**保證包含逐筆資料，不會退化成單句摘要**——這是本專案的核心設計原則，因為這是唯一確保跨所有 MCP client（不論是否支援卡片渲染）模型都能看到完整內容的欄位
- **`structuredContent`** —— 包含 `summary`、`viewType`、`normalized_data`、`model_content`，以及未經修改的 `original_payload`（供除錯或未來擴充使用；部分 client 可能會利用這個欄位做進一步的渲染，但不應該是模型取得資料的唯一途徑）

四個工具都標記了 [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#annotations)（`readOnlyHint`、`destructiveHint` 等），讓支援讀取這些提示的 client 可以判斷哪些呼叫需要跳出確認框、哪些不需要——但這只是建議性質，實際行為取決於該 client 是否採用。

## 架構

```
任一支援 MCP 的 AI workspace（Open WebUI／Claude／ChatGPT 等）
  <--OAuth 2.1（動態客戶端註冊 + PKCE）-->
這個 Worker
  <--OAuth 2.1（DCR + PKCE）-->
mcp.lib.nycu.edu.tw
```

這個 Worker 同時扮演兩個角色：對你的 AI workspace 而言，它是完整的 OAuth 2.1 provider（透過 [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)）；對陽明交大圖書館而言，它又是 OAuth 2.1 client。這是**兩段獨立的 token 交換**——你的 NYCU access token 不會離開 Worker 的 KV 儲存空間。當 NYCU 那段 token 過期時，`reauth` 工具讓你只重新走一次 NYCU 登入，完全不會影響你跟 AI workspace 之間已經建立好的連線。

工具呼叫透過 [`agents/mcp`](https://github.com/cloudflare/agents) 的 `createMcpHandler` 以無狀態方式提供服務，對上游則用官方的 [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk) 建立 Streamable HTTP 連線——因此原則上相容任何遵循 MCP 規範的 client，本專案的部署與測試以 Open WebUI 為主要範例，但不限定於它。

完整技術設計、上游回應結構、實作細節請見 [SPEC.md](./SPEC.md)。

## 技術棧

- [Cloudflare Workers](https://workers.cloudflare.com/) —— 部署平台（免費層）
- [Cloudflare Workers KV](https://developers.cloudflare.com/kv/) —— token/nonce 儲存
- [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider) —— OAuth 2.1 provider 框架
- [`agents`](https://www.npmjs.com/package/agents)（`agents/mcp`） —— 無狀態 MCP handler
- [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk) —— MCP server 基礎元件
- [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk) —— 對上游 NYCU MCP server 的 client 連線
- [Zod](https://zod.dev/) —— 工具輸入參數驗證
- TypeScript

## 已知限制

- **NYCU access token 每約 3 天過期，且沒有 refresh token。** 這是校方刻意的安全政策，不是 bug。過期時 `search`／`fetch` 會回傳明確指引，告訴模型呼叫 `reauth` 取得一次性重新登入連結——你點開連結、完成 NYCU 登入即可，不需要重新設定整個 MCP 連線。
- 目前只包裝上游的 `search`／`fetch`。上游近期新增的論文與期刊類工具（`search_academic_papers`、`journal_search` 等）尚未包裝，打算等上游全部完成並正式公告後再跟進（見 [SPEC.md §4](./SPEC.md#4-security-model)）。
- Tool annotations（`readOnlyHint` 等）只是建議性質，實際上會不會影響某個 client 跳確認框的行為，取決於該 client 自己的實作，本專案無法保證。
- 有 Vitest 自動化測試（`npm test`），GitHub Actions CI 會在每次 push／PR 時執行。`fetch` 裡「預約中」跟「採購申請」的欄位依上游自己的工具說明與 UI 程式碼對應，但開發用的帳號目前沒有這兩類紀錄，還沒用真實資料驗證過。
- 部署與連線步驟以 Open WebUI 為範例撰寫（見 [INSTALL.md](./INSTALL.md)），若使用其他支援 MCP 的 client，OAuth 授權與工具呼叫的核心邏輯相同，但連線設定畫面會不同，請參考該 client 自己的 MCP 連線文件。

## 安全性說明

- 沒有任何 client secret 需要儲存——wrapper 在兩段 OAuth 流程都用 Dynamic Client Registration + PKCE，設定檔裡不會有任何敏感資訊。
- `wrangler.jsonc`（包含 KV namespace id、account id）可以安全地 commit，這些都只是識別碼，不是憑證；唯一要注意的是如果你的 Cloudflare API Token 因為其他原因洩漏，這些識別碼會讓攻擊者更快鎖定目標，但本身不構成存取途徑。
- 你的 NYCU access token 存在 Workers KV 裡，並綁定一個隨機產生的 `grantId`，不會被記錄到 log，也不會直接暴露給你的 AI workspace。
- `reauth` 產生的連結是單次有效、10 分鐘內過期的 nonce，且只綁定 `grantId`，不包含任何 token 本身——即使連結不小心外流，能造成的風險也很有限。
- 如果要部署給自己以外的人使用，請先仔細閱讀 [`SPEC.md`](./SPEC.md) 第 4 節與第 10 節，並自行確認符合陽明交大圖書館 MCP 服務本身的使用條款。

## 安裝

完整部署步驟請見 [INSTALL.md](./INSTALL.md)（以 Open WebUI 為範例，其他 MCP client 的核心設定邏輯相同）。

## 授權

原始程式碼採用 [MIT License](./LICENSE)。

請注意：MIT License 僅授權本專案的**程式碼**，不代表你可以任意使用「陽明交通大學」或「NYCU」名稱／商標宣稱官方關係，也不豁免你使用陽明交大圖書館服務時應遵守的校方使用條款。詳見 [LICENSE](./LICENSE) 檔案中的 NOTICE 段落。

---

# NYCU Library MCP Wrapper (English)

A Cloudflare Workers-based wrapper for [NYCU Library's official MCP server](https://mcp.lib.nycu.edu.tw/) that normalizes UI-oriented tool results (`viewType: "catalog"`, account dashboards) into Markdown + structured content, ensuring **any MCP-compatible AI workspace** (Open WebUI, Claude, ChatGPT, etc.) gives the model full item-level data — not just a one-line summary — with no frontend changes required.

> **Not officially affiliated with National Yang Ming Chiao Tung University.** This is a personal integration project that talks to NYCU Library's public MCP endpoint using your own NYCU SSO credentials. Use at your own risk; see [Security Notes](#security-notes) below.

## Why this exists

NYCU Library's MCP server returns rich structured payloads (book lists with call numbers, availability per campus, loan/hold dashboards). Some MCP clients render this kind of UI-oriented structured result as native cards — **but that's purely a frontend concern**. Even when a client renders a nice card, **the model itself may not receive the full data**: on Claude's web app, for example, the frontend shows a card, but the model's actual tool-result context may still just be a summary like `Displaying 10 catalog item(s).`. Open WebUI, meanwhile, doesn't even render a card by default — the user sees nothing useful either.

In other words, this isn't a single-client problem — it's a **general risk for any MCP client that relies on the tool result's `content` field** to inform the model. Card rendering and model-visible content are two separate concerns.

This wrapper sits between your AI workspace and the real NYCU Library MCP server, and:

- Writes complete, readable information (titles, authors, per-campus availability, call numbers, links) directly into the tool result's `content` text field, so **the model always gets full item-level data regardless of which MCP client you're using**, independent of whether that client supports card rendering
- In clients that do render Markdown in chat (like Open WebUI), this same `content` also serves as the human-readable display
- Preserves the original upstream payload for debugging
- Handles the full OAuth 2.1 handshake with NYCU on your behalf, including a one-click re-authentication path when the token expires (see Features below)
- Deploys to Cloudflare Workers' free tier — always-on, no server to maintain

## Features

| Tool | Description |
|---|---|
| `search` | Search the library catalog. Supports pagination (`offset`), filtering (`resource_type`, `access`, `scope`, `sort`), and a `max` param controlling how many results render in chat. |
| `fetch` | Fetch your account dashboard — current loans, holds, and purchase requests, with due dates and per-item status. |
| `reauth` | Call this when your NYCU authorization has expired to get a one-time, 10-minute link to log back in — no need to redo the full MCP connection setup. |
| `remove_auth` | Manually clears your cached NYCU authorization, for logging out or if you suspect the cached token is stale. |

Both `search` and `fetch` return:
- **`content`** — complete, display-ready Markdown that **always includes item-level data, never degrades to a bare summary** — this is the core design principle, since it's the only field guaranteed to reach the model across every MCP client regardless of card-rendering support
- **`structuredContent`** — `summary`, `viewType`, `normalized_data`, `model_content`, and the untouched `original_payload` for debugging/future use; some clients may use this for richer rendering, but it should never be the model's only path to the data

All four tools declare [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#annotations) (`readOnlyHint`, `destructiveHint`, etc.) so clients that read them can decide which calls need explicit confirmation — this is advisory only, and actual behavior depends on the client.

## Architecture

```
Any MCP-compatible AI workspace (Open WebUI / Claude / ChatGPT / etc.)
  <--OAuth 2.1 (Dynamic Client Registration + PKCE)-->
This Worker
  <--OAuth 2.1 (DCR + PKCE)-->
mcp.lib.nycu.edu.tw
```

The Worker is a full OAuth 2.1 provider to your AI workspace (via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)) **and** an OAuth 2.1 client to NYCU Library's own authorization server. These are two independent token exchanges — your NYCU access token never leaves the Worker's KV storage. When the NYCU-side token expires, the `reauth` tool lets you refresh just that leg, without touching your existing session with the AI workspace.

Tool calls are served statelessly via [`agents/mcp`](https://github.com/cloudflare/agents)'s `createMcpHandler`, and upstream connections use the official [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk) package over Streamable HTTP — so in principle this works with any spec-compliant MCP client. Deployment and testing in this repo use Open WebUI as the primary worked example, but the wrapper itself is not tied to it.

See [SPEC.md](./SPEC.md) for the full technical design, upstream response schemas, and implementation notes.

## Tech Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) — hosting (free tier)
- [Cloudflare Workers KV](https://developers.cloudflare.com/kv/) — token/nonce storage
- [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider) — OAuth 2.1 provider framework
- [`agents`](https://www.npmjs.com/package/agents) (`agents/mcp`) — stateless MCP handler
- [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server primitives
- [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk) — client connection to the upstream NYCU MCP server
- [Zod](https://zod.dev/) — tool input schema validation
- TypeScript

## Known Limitations

- **NYCU Library access tokens expire every ~3 days with no refresh token.** This is a deliberate security policy on NYCU's side, not a bug. When it happens, `search`/`fetch` instruct the model to call `reauth`, which returns a one-time link — open it, log in, and you're done, no need to redo the whole MCP connection setup.
- Only the upstream's `search`/`fetch` are wrapped. The upstream's recently added paper and journal tools (`search_academic_papers`, `journal_search`, etc.) are not wrapped yet; the plan is to follow up once the upstream has finished and officially announced them (see [SPEC.md §4](./SPEC.md#4-security-model)).
- Tool annotations (`readOnlyHint`, etc.) are advisory only; whether a given client actually skips confirmation prompts based on them is outside this project's control.
- Covered by an automated Vitest suite (`npm test`), run by GitHub Actions CI on every push/PR. `fetch`'s "holds" and "purchase requests" field mapping follows the upstream's own tool description and UI code, but hasn't been checked against real records yet, since the account used during development has none in those categories.
- Deployment/connection steps are written against Open WebUI as the example (see [INSTALL.md](./INSTALL.md)). The core OAuth and tool-call logic is client-agnostic; connection UI will differ for other MCP clients — consult that client's own MCP connection docs.

## Security Notes

- No client secrets are stored anywhere — the wrapper uses OAuth 2.1 Dynamic Client Registration + PKCE on both legs, so there's nothing sensitive baked into config files.
- `wrangler.jsonc` (including the KV namespace ID and account ID) is safe to commit — these are identifiers, not credentials. The only real exposure is that if your Cloudflare API token is ever leaked through some other channel, these identifiers make it faster for an attacker to target your account — but they don't constitute an access path on their own.
- Your NYCU access token is stored in Workers KV, scoped to a random per-session `grantId`. It is never logged and never exposed to your AI workspace directly.
- `reauth` links are single-use, 10-minute nonces that carry only a `grantId`, never a token — even if one leaks, the practical exposure is limited.
- Review [`SPEC.md`](./SPEC.md) §4 and §10, and NYCU Library's own MCP service terms of use, before deploying this for anyone other than yourself.

## Setup

See [INSTALL.md](./INSTALL.md) for full step-by-step deployment instructions (using Open WebUI as the worked example; core setup is the same for other MCP clients).

## License

The original source code in this repository is licensed under the [MIT License](./LICENSE).

Note: the MIT License covers this project's **code** only. It does not grant any rights to use the "National Yang Ming Chiao Tung University" or "NYCU" names/marks in a way implying official affiliation, nor does it exempt you from NYCU Library's own terms of service when using their service through this tool. See the NOTICE section in [LICENSE](./LICENSE) for details.
