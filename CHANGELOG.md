# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/PipperL/nycu-library-mcp-wrapper/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/PipperL/nycu-library-mcp-wrapper/releases/tag/v1.5.0
