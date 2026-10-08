# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.1] - 2026-10-08

跟上游（`mcp.lib.nycu.edu.tw`）實際行為重新對齊的一個版本：第一次直接對上游跑 `tools/list`、讀它自己的儀表板 UI 程式碼、逐步實測 OAuth 流程，修正 `fetch` 裡一直沒被驗證過的預約／採購申請欄位，並補上監控上游改版的工具。

### Fixed

- `fetch` 的預約（`requests`）跟採購申請（`purchase_requests`）欄位改成照上游 `fetch` 工具的 description 跟上游自己的 dashboard UI（`ui://widget/dashboard.html`）實際讀取的欄位：
  - 預約：狀態改讀 `request_status`（原本讀的 `status` 上游沒有），新增 `author`、`request_date`；拿掉上游根本沒有的 `expiry_date`。
  - 採購申請：日期改讀 `request_date`（原本讀的 `created_at` 上游沒有），新增 `request_id`、`author`；`status` 可能是字串或 `{ value, desc }` 物件，取不到時退回 `request_status`（跟上游 UI 的處理方式相同）。
  - 舊的猜測欄位名稱保留當 fallback。修正前，使用者一旦有預約或採購申請，狀態跟日期會顯示成空的。
  - `structuredContent.normalized_data` 裡這兩類的欄位隨之調整：requests 為 `{title, author, status, pickupLocation, requestDate}`，purchase_requests 為 `{requestId, title, author, isbn, status, requestDate}`。
- `search` 的館藏狀態：`scope: "ust"` 時上游會回 `available_in_institution`（聯盟他校可借），原本會被標成「不可借閱」，現在標成「他校館藏可借閱」；其他沒看過的值直接顯示原字串。
- `nycu_token:<grantId>` 寫入 KV 時加上 `expirationTtl`（= 上游 token 的 `expires_in`，目前 3 天），跟 SPEC §8 寫的生命週期一致。先前沒設 TTL，過期 token 會一直留在 KV 裡（部署前 KV 裡有 16 筆 `nycu_token`，對應的 grant 只剩 3 個）。舊版寫入的 key 不受影響。

### Added

- `scripts/upstream-snapshot.mjs` 跟基準快照 `upstream/snapshot.json`：擷取上游的協定版本、serverInfo、工具清單跟每個工具的完整定義，跟基準比對，有差異時 exit 1。
- 測試：預約／採購申請的新欄位與 fallback、`status` 物件形式、館藏狀態標籤、`nycu_token` 的 KV TTL（50 個測試）。

### Changed

- `SPEC.md`：
  - 新增 §7.1，記錄 2026-10-08 實測的上游 OAuth 行為（DCR、`/declare` 隱私聲明頁、token 格式、401 處理、上游沒有 revoke endpoint）。
  - 更正協定版本：實測協商結果是 2025-06-18，不是先前寫的 2026-07-28。
  - 更新上游工具清單：上游現在有 10 個工具，`fetch_account_page` 已經不存在。
  - 註明 `remove_auth` 只刪 wrapper 自己 KV 裡的 token，上游的 token 在過期前仍然有效。

## [1.6.0] - 2026-09-03

以「補齊測試」為主軸的一個版本：專案原本完全沒有真正在跑的自動化測試，這次補上會實際執行的測試套件、接上 CI，順便修掉寫測試過程中發現的一個真實 bug（`fetch` 的 `viewType` 判斷）。沒有任何工具的對外行為改變。

### Added

- 補上完整的 Vitest + `@cloudflare/vitest-pool-workers` 測試套件（`test/`），取代先前專案模板留下、內容跟這個 worker 完全無關的空殼測試：
  - `test/mcp-server.spec.ts`：27 個純函式測試（catalog／loan／request／purchase request 正規化、payload 路由判斷、catalog／account 結果組裝）。
  - `test/tool-handlers.spec.ts`：`search`／`fetch`／`reauth`／`remove_auth` 四個工具本身邏輯的測試（未登入、token 過期、上游 401、成功路徑），用真實 upstream 回應（已去識別化）當 fixture。為了讓這四個工具可以脫離完整 MCP 協定直接呼叫測試，`src/mcp-server.ts` 新增匯出 `createToolHandlers(env, baseUrl)`。
  - `test/index.spec.ts`：`auth-handler.ts` 路由測試，涵蓋 `/callback`／`/reauth/:nonce` 的錯誤路徑，以及 `mode: "initial"`／`mode: "reauth"` 兩種成功路徑（`mode: "initial"` 真的走過 DCR 註冊、`/authorize`、`completeAuthorization`，只有 NYCU 端的 token 交換被假造）。
- 新增 GitHub Actions CI（`.github/workflows/test.yml`）：每次 push／PR 到 main 都會跑 typecheck 跟完整測試套件。

### Fixed

- 修正 `fetch` 工具的帳戶儀表板路由判斷：upstream 實際回傳的 `viewType` 值是 `"dashboard"`，不是原本以為（也是這個 wrapper 自己對外 `structuredContent.viewType` 使用的）`"account_dashboard"`——這個明確比對分支先前一直是死碼，靠後面的資料形狀推斷在撐著，寫測試時才發現。現在兩個字串都接受。
- `vitest.config.mts` 改用 `@cloudflare/vitest-pool-workers` v4 的 `cloudflareTest` plugin API（原本用的 `defineWorkersConfig`／`/config` 路徑已在目前安裝的版本移除，導致測試根本跑不起來）。
- 套用 `npm audit fix`，修掉 `fast-uri`（透過 `ajv`）跟 `qs`（透過 `express`）兩個透過 `@modelcontextprotocol/sdk` 引入的間接依賴漏洞。

### Changed

- `SPEC.md` 同步更新：`search` 的 `search_by` 參數補進 §5.1 參數表（程式碼從 1.5.0 就支援，先前漏記文件）；§6／§9 修正 `viewType` 的正確值；§9 新增測試套件涵蓋範圍說明；註明 `loans`／catalog 正規化已用真實 2026-09 資料驗證過，`requests`／`purchase_requests` 仍待驗證。

## [1.5.0] - 2026-08-24

以「跟上 upstream 協定改版」為起點，延伸出一整套重新授權體驗改善的版本。不破壞任何既有 MCP 工具呼叫方式，但如果你 fork 過本專案的原始碼，請看最下方「⚠️ 給 fork 過程式碼的人」。

### Added

- 新增 `reauth` 工具：NYCU 授權過期時，模型可以呼叫這個工具取得一次性、10 分鐘內有效的重新登入連結。使用者完成 NYCU 登入後，只會更新既有 `grantId` 對應的 NYCU token，不影響使用者跟 AI workspace 之間已經建立好的連線。
- 新增 `remove_auth` 工具：手動清除目前快取的 NYCU 授權，用於登出或懷疑授權異常時。
- 新增 `/reauth/:nonce` 路由（`auth-handler.ts`）：消化 `reauth` 產生的一次性連結，驗證後立即刪除（單次有效），依 `mode: "reauth"` 分流，避免動到既有的 downstream OAuth 授權狀態。
- 四個工具都補上 [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#annotations)（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`）。`search`／`fetch` 標記為唯讀；`remove_auth` 是唯一標記為 `destructiveHint: true` 的工具。
- KV 新增 `reauth_nonce:<nonce>` key（10 分鐘 TTL、單次有效）。

### Fixed

- 修正 `search` 在特定查詢下會直接噴 `Cannot read properties of undefined (reading 'map')` 的問題：upstream 實際回傳的 catalog payload 形狀是 `{ data: [...], viewType: "catalog" }`（`data` 本身就是陣列），不是原本假設的 `{ data: { items: [...] } }`。
- 修正 `hasMore` 判斷邏輯——upstream 沒有回傳 `has_more` 欄位，改成用陣列長度比較推算。

### Changed

- Upstream client 全面改用官方 [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk)（`Client` + `StreamableHTTPClientTransport`），取代手寫的 `initialize` handshake、`Mcp-Session-Id` 快取、SSE 手動解析。改用 `authProvider: { token: async () => accessToken }` 供應 bearer token。
- MCP server 端改用官方 [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk)，工具註冊方式從 `server.tool(name, shape, handler)` 改成 `server.registerTool(name, { description, inputSchema, annotations }, handler)`（`inputSchema` 需要用 `z.object({...})` 包起來）。
- Upstream（`mcp.lib.nycu.edu.tw`）已遷移到 2026-07-28 無狀態協定修訂版，本次更新讓 wrapper 跟上這個版本。
- `README.md`／`INSTALL.md`／`SPEC.md` 全面同步：工具清單（2 個 → 4 個）、依賴套件名稱、KV key 表、疑難排解表、已知限制。

### Removed

- 移除 `@modelcontextprotocol/sdk` 依賴（改用拆分後的 `server`／`client` 套件）。
- 不再寫入 `session:<grantId>` KV key（`auth-handler.ts` 保留一行清除舊 key 的相容性程式碼，對從未寫過該 key 的部署無任何影響）。

### Known Issues

- `fetch` 工具裡「預約中」跟「採購申請」的欄位正規化（`pickup_location`、`expiry_date`、`created_at` 等）尚未用真實資料驗證欄位名稱是否完全對應——測試帳號目前沒有實際紀錄。「借閱中」已用真實資料完整驗證過。
- Tool annotations 只是建議性質（MCP 規格要求 client 視其為 untrusted hint），實際上會不會影響某個 MCP client 的確認框行為，取決於該 client 自己的實作。

### ⚠️ 給 fork 過程式碼的人

1. **依賴套件改名**：`@modelcontextprotocol/sdk` 已拆分成 `@modelcontextprotocol/server` + `@modelcontextprotocol/client`，`import` 路徑跟建構子用法都不一樣，直接 `npm install` 舊程式碼會編譯失敗。
2. **`server.tool()` → `server.registerTool()`**：自己加過工具的話，需要照新的 config-object 簽名改寫。
3. **`auth-handler.ts` 也要同步更新**：只換 `mcp-server.ts` 不夠——`reauth` 工具依賴 `auth-handler.ts` 裡新增的 `/reauth/:nonce` 路由跟 `/callback` 的 `mode` 分流邏輯，缺一不可。

[Unreleased]: https://github.com/PipperL/nycu-library-mcp-wrapper/compare/v1.6.1...HEAD
[1.6.1]: https://github.com/PipperL/nycu-library-mcp-wrapper/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/PipperL/nycu-library-mcp-wrapper/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/PipperL/nycu-library-mcp-wrapper/releases/tag/v1.5.0
