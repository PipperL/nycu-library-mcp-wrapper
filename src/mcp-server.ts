import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { z } from "zod";

const UPSTREAM_MCP_URL = "https://mcp.lib.nycu.edu.tw/mcp";
const REAUTH_NONCE_TTL_SECONDS = 600;

interface Env {
  OAUTH_KV: KVNamespace;
}

/** 代表「需要使用者重新授權」的錯誤，跟其他一般上游/解析錯誤區分開，
 *  讓 search/fetch 的 catch 區塊可以回傳專門指引模型呼叫 reauth 的訊息。 */
class AuthRequiredError extends Error {}

// ---------------------------------------------------------------------------
// Catalog normalize（search 工具用）
// ---------------------------------------------------------------------------

export interface LocationInfo {
  location: string;
  availability: string;
  callNumber: string;
}

export interface CatalogItem {
  title: string;
  author: string;
  year: string;
  resourceType: string;
  primoId: string;
  link: string;
  locations: LocationInfo[];
}

export function normalizeCatalogItem(raw: any): CatalogItem {
  return {
    title: raw.title ?? "",
    author: raw.author ?? "",
    year: raw.year ?? "",
    resourceType: raw.type ?? "",
    primoId: raw.primo_id ?? "",
    link: raw.link ?? "",
    locations: (raw.locations ?? []).map((loc: any) => ({
      location: loc.location ?? "",
      availability: loc.status ?? "",
      callNumber: loc.callNumber ?? "",
    })),
  };
}

/** upstream locations[].status 的已知值。available_in_institution 出現在 scope: "ust"（台聯大）的結果，
 *  代表書在聯盟其他學校可借，不是不可借閱。未知的值直接顯示原字串，不要猜。 */
const AVAILABILITY_LABELS: Record<string, string> = {
  available: "可借閱",
  available_in_institution: "他校館藏可借閱",
  unavailable: "不可借閱",
};

export function renderCatalogMarkdown(
  items: CatalogItem[],
  total: number,
  shown: number,
  hasMore: boolean
): string {
  let md = `### Catalog Results\n\n`;
  md +=
    hasMore || total > shown
      ? `Showing first ${shown} of ${total}+ catalog items.\n\n`
      : `Found ${total} catalog items.\n\n`;

  items.forEach((it, i) => {
    md += `#### ${i + 1}. ${it.title}\n`;
    if (it.author) md += `- Author: ${it.author}\n`;
    if (it.year) md += `- Year: ${it.year}\n`;
    if (it.resourceType) md += `- Type: ${it.resourceType}\n`;
    if (it.locations.length) {
      md += `- Locations:\n`;
      it.locations.forEach((loc) => {
        const availLabel = AVAILABILITY_LABELS[loc.availability] ?? loc.availability;
        md += `  - ${loc.location}｜${loc.callNumber}｜${availLabel}\n`;
      });
    }
    if (it.link) md += `- Link: ${it.link}\n`;
    md += `\n`;
  });
  return md;
}

export function renderCatalogModelContent(items: CatalogItem[], total: number): string {
  let out = `Catalog search returned ${total} items.\n`;
  items.forEach((it, i) => {
    out += `${i + 1}. ${it.title}\n   Author: ${it.author}\n   Year: ${it.year}\n`;
    it.locations.forEach((loc) => {
      out += `   Location: ${loc.location} | CallNumber: ${loc.callNumber} | Status: ${loc.availability}\n`;
    });
    out += `   Link: ${it.link}\n`;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Account dashboard normalize（fetch 工具用：loans / requests / purchase_requests）
// 欄位名稱依「實際觀察到的 structuredContent」為準（snake_case）。
// requests / purchase_requests 目前沒有真實資料可驗證，欄位依 upstream fetch 工具的
// description 跟 upstream 自己的 dashboard UI（ui://widget/dashboard.html）實際讀取的欄位為準
// （2026-10-08 確認），舊版猜測的欄位名稱保留當 fallback。
// ---------------------------------------------------------------------------

export interface LoanItem {
  title: string;
  author: string;
  dueDate: string;
  loanDate: string;
  circDesk: string;
  resourceType: string;
  loanFine: string;
}

export interface RequestItem {
  title: string;
  author: string;
  status: string;
  pickupLocation: string;
  requestDate: string;
}

export interface PurchaseRequestItem {
  requestId: string;
  title: string;
  author: string;
  isbn: string;
  status: string;
  requestDate: string;
}

export function normalizeLoan(raw: any): LoanItem {
  return {
    title: raw.title ?? "",
    author: raw.author ?? "",
    dueDate: raw.due_date ?? "",
    loanDate: raw.loan_date ?? "",
    circDesk: raw.circ_desk ?? "",
    resourceType: raw.resource_type ?? "",
    loanFine: raw.loan_fine ?? "",
  };
}

/** upstream 的狀態欄位可能是字串，也可能是 Alma 風格的 { value, desc } 物件（upstream 自己的 UI 兩種都處理）。 */
function statusText(v: any): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") return String(v.desc || v.value || "");
  return "";
}

export function normalizeRequest(raw: any): RequestItem {
  return {
    title: raw.title ?? "",
    author: raw.author ?? "",
    status: statusText(raw.request_status) || statusText(raw.status),
    pickupLocation: raw.pickup_location ?? raw.pickupLocation ?? "",
    requestDate: raw.request_date ?? "",
  };
}

export function normalizePurchaseRequest(raw: any): PurchaseRequestItem {
  return {
    requestId: raw.request_id ?? "",
    title: raw.title ?? "",
    author: raw.author ?? "",
    isbn: raw.isbn ?? "",
    // 跟 upstream UI 一樣：status 優先，取不到才用 request_status
    status: statusText(raw.status) || statusText(raw.request_status),
    requestDate: raw.request_date ?? raw.created_at ?? raw.createdAt ?? "",
  };
}

const formatDate = (d: string) => (d ? new Date(d).toLocaleDateString("zh-TW") : "");

export function renderAccountMarkdown(loans: LoanItem[], requests: RequestItem[], purchaseRequests: PurchaseRequestItem[]): string {
  let md = `### My Library Account\n\n`;
  md += `${loans.length} loans, ${requests.length} requests, ${purchaseRequests.length} purchase requests\n\n`;

  if (loans.length) {
    md += `#### 借閱中\n\n`;
    loans.forEach((l, i) => {
      const due = formatDate(l.dueDate);
      md += `${i + 1}. **${l.title}**（${l.author}）\n   - 到期日：${due}${l.loanFine ? `　罰款：${l.loanFine}` : ""}\n`;
    });
    md += `\n`;
  }
  if (requests.length) {
    md += `#### 預約中\n\n`;
    requests.forEach((r, i) => {
      md += `${i + 1}. **${r.title}**${r.author ? `（${r.author}）` : ""}\n   - 狀態：${r.status || "未知"}`;
      if (r.pickupLocation) md += `　取書地點：${r.pickupLocation}`;
      if (r.requestDate) md += `　預約日期：${formatDate(r.requestDate)}`;
      md += `\n`;
    });
    md += `\n`;
  }
  if (purchaseRequests.length) {
    md += `#### 採購申請\n\n`;
    purchaseRequests.forEach((p, i) => {
      md += `${i + 1}. **${p.title}**${p.author ? `（${p.author}）` : ""}\n   - 狀態：${p.status || "未知"}`;
      if (p.isbn) md += `　ISBN：${p.isbn}`;
      if (p.requestDate) md += `　申請日期：${formatDate(p.requestDate)}`;
      md += `\n`;
    });
  }
  return md;
}

export function renderAccountModelContent(loans: LoanItem[], requests: RequestItem[], purchaseRequests: PurchaseRequestItem[]): string {
  let out = `Account dashboard: ${loans.length} loans, ${requests.length} requests, ${purchaseRequests.length} purchase requests.\n`;
  loans.forEach((l, i) => {
    out += `Loan ${i + 1}: ${l.title} | Author: ${l.author} | Due: ${l.dueDate} | Fine: ${l.loanFine || "none"}\n`;
  });
  requests.forEach((r, i) => {
    out += `Request ${i + 1}: ${r.title} | Author: ${r.author} | Status: ${r.status} | Pickup: ${r.pickupLocation} | Requested: ${r.requestDate}\n`;
  });
  purchaseRequests.forEach((p, i) => {
    out += `PurchaseRequest ${i + 1}: ${p.title} | Author: ${p.author} | ISBN: ${p.isbn} | Status: ${p.status} | Requested: ${p.requestDate}\n`;
  });
  return out;
}

/** 優先讀 structuredContent（乾淨的 JSON），content[].text 可能帶 "[ui_payload]" 前綴，作為備援才嘗試清洗解析。 */
export function extractPayload(toolResult: any): any {
  if (toolResult?.structuredContent) return toolResult.structuredContent;

  const textBlock = toolResult?.content?.find((c: any) => c.type === "text");
  if (textBlock?.text) {
    const idx = textBlock.text.indexOf("{");
    if (idx >= 0) {
      try {
        return JSON.parse(textBlock.text.slice(idx));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upstream MCP client（改用官方 @modelcontextprotocol/client，
// 不再手寫 fetch / SSE 解析 / session 快取——upstream 已遷移到 2026-07-28
// 無狀態協定修訂版，官方 client 會自動處理協定版本協商跟連線細節）
// ---------------------------------------------------------------------------

async function callUpstreamTool(
  accessToken: string,
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const transport = new StreamableHTTPClientTransport(new URL(UPSTREAM_MCP_URL), {
    authProvider: { token: async () => accessToken },
  });

  const client = new Client({ name: "nycu-library-mcp-wrapper", version: "1.6.2" });

  try {
    await client.connect(transport);
    return await client.callTool({ name: toolName, arguments: args });
  } catch (e: any) {
    if (e instanceof UnauthorizedError) {
      throw new AuthRequiredError("NYCU 授權已過期，請重新登入。");
    }
    throw e;
  } finally {
    try {
      await client.close();
    } catch {
      // 關閉連線失敗不影響本次呼叫結果，忽略即可
    }
  }
}

// ---------------------------------------------------------------------------
// 正規化輸出建構
// ---------------------------------------------------------------------------

export function buildCatalogResult(payload: any, max: number) {
  const items: CatalogItem[] = (payload.data ?? []).map(normalizeCatalogItem);
  const shown = items.slice(0, max);
  const hasMore = items.length > shown.length;

  const summary = hasMore
    ? `Showing first ${shown.length} of ${items.length}+ catalog items.`
    : `Found ${items.length} catalog items.`;

  const content = renderCatalogMarkdown(shown, items.length, shown.length, hasMore);
  const modelContent = renderCatalogModelContent(shown, items.length);

  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent: {
      summary,
      viewType: "catalog",
      normalized_data: { items: shown, has_more: hasMore },
      model_content: modelContent,
      original_payload: payload,
    },
  };
}

export function buildAccountResult(payload: any) {
  const loans: LoanItem[] = (payload.data.loans ?? []).map(normalizeLoan);
  const requests: RequestItem[] = (payload.data.requests ?? []).map(normalizeRequest);
  const purchaseRequests: PurchaseRequestItem[] = (payload.data.purchase_requests ?? []).map(normalizePurchaseRequest);

  const summary = `${loans.length} loans, ${requests.length} requests, ${purchaseRequests.length} purchase requests.`;
  const content = renderAccountMarkdown(loans, requests, purchaseRequests);
  const modelContent = renderAccountModelContent(loans, requests, purchaseRequests);

  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent: {
      summary,
      viewType: "account_dashboard",
      normalized_data: { loans, requests, purchase_requests: purchaseRequests },
      model_content: modelContent,
      original_payload: payload,
    },
  };
}

export function buildFallbackResult(toolResult: any, parsedPayload: any) {
  const rawPreview = JSON.stringify(parsedPayload ?? toolResult ?? {}).slice(0, 1000);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Tool returned an unsupported structured result.\n\n` +
          `Raw preview (truncated):\n\`\`\`json\n${rawPreview}\n\`\`\``,
      },
    ],
    structuredContent: {
      summary: "Tool returned an unsupported structured result.",
      viewType: null,
      original_payload: parsedPayload ?? toolResult ?? null,
    },
  };
}

export function buildErrorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** 授權過期／未授權時的專用回覆：明確指引模型接著呼叫 reauth。 */
export function buildAuthRequiredResult() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "NYCU 圖書館授權已過期或尚未完成登入，需要重新授權才能查詢。\n\n" +
          "請呼叫 reauth 這個工具取得一次性的重新登入連結，並將連結提供給使用者，" +
          "由使用者在瀏覽器中完成 NYCU 登入後再重試剛才的查詢。",
      },
    ],
    isError: true,
  };
}

/** 依實際 payload 形狀判斷是 catalog 還是 account dashboard，viewType 缺失時用形狀推斷。
 *  catalog 的 data 是陣列本身（不是 { items: [...] }），account dashboard 才是帶 loans/requests 的物件。
 *
 *  upstream 實際回傳的 account dashboard payload，viewType 欄位的值是 "dashboard"，
 *  不是原本以為（也是這個 wrapper 自己 structuredContent.viewType 對外用的）"account_dashboard"——
 *  兩者容易搞混。這裡兩個字串都接受，靠後面的形狀推斷當保險，避免 upstream 未來又換一種
 *  拼法時，這個明確比對分支又悄悄變成永遠不會命中的死碼（先前只靠形狀推斷硬撐，沒被發現）。 */
export function routePayload(payload: any, max: number) {
  if (!payload) return null;

  if (payload.viewType === "catalog" || Array.isArray(payload.data)) {
    return buildCatalogResult(payload, max);
  }
  if (
    payload.viewType === "dashboard" ||
    payload.viewType === "account_dashboard" ||
    Array.isArray(payload.data?.loans) ||
    Array.isArray(payload.data?.requests) ||
    Array.isArray(payload.data?.purchase_requests)
  ) {
    return buildAccountResult(payload);
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP server：search / fetch / reauth / remove_auth
// （不包 fetch_account_page，官方標明非給模型用）
//
// baseUrl 是每次請求動態算出來的（見檔案最下方 apiHandler），
// 不是寫死的常數或環境變數，本機 wrangler dev 跑出來就是 http://localhost:8787，
// 正式環境跑出來就是實際部署網址，兩邊都能各自完整測試 reauth 流程。
//
// annotations：readOnlyHint/destructiveHint 用來讓支援的 client 判斷是否需要
// 跳出確認框；openWorldHint 依使用者決定全部設為 false。
// ---------------------------------------------------------------------------

/** 四個工具的實際處理邏輯，抽成獨立函式（不依賴 McpServer 實例本身）。
 *  這樣測試可以直接呼叫這些函式、餵假的 env／baseUrl，不需要真的架一個
 *  MCP client-server 連線或動 upstream 網路——純粹是為了可測試性的抽取，
 *  邏輯本身跟抽取前完全一致。 */
export function createToolHandlers(env: Env, baseUrl: string) {
  function getGrantIdOrThrow(): string {
    const auth: any = getMcpAuthContext();
    const grantId = auth?.props?.grantId;
    if (!grantId) throw new AuthRequiredError("No NYCU grant found. Please re-authenticate.");
    return grantId;
  }

  async function getAccessTokenOrThrow(): Promise<{ grantId: string; accessToken: string }> {
    const grantId = getGrantIdOrThrow();

    const tokenRecord = await env.OAUTH_KV.get(`nycu_token:${grantId}`);
    if (!tokenRecord) throw new AuthRequiredError("No NYCU token found. Please re-authenticate.");

    const { access_token } = JSON.parse(tokenRecord);
    return { grantId, accessToken: access_token };
  }

  async function search({ query, resource_type, search_by, access, scope, sort, offset, max }: any) {
    let accessToken: string;
    try {
      ({ accessToken } = await getAccessTokenOrThrow());
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return buildAuthRequiredResult();
      return buildErrorResult(e.message);
    }

    const args = {
      query,
      resource_type: resource_type ?? "all",
      search_by: search_by ?? "title",
      access: access ?? "all",
      scope: scope ?? "nycu",
      sort: sort ?? "rank",
      offset: offset ?? 0,
    };

    let toolResult: any;
    try {
      toolResult = await callUpstreamTool(accessToken, "search", args);
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return buildAuthRequiredResult();
      return buildErrorResult(e.message);
    }

    const payload = extractPayload(toolResult);
    const routed = routePayload(payload, max ?? 5);
    return routed ?? buildFallbackResult(toolResult, payload);
  }

  // fetch：借閱紀錄 / 預約 / 採購申請儀表板。無參數（身分從 token 解析）。
  async function fetchAccount() {
    let accessToken: string;
    try {
      ({ accessToken } = await getAccessTokenOrThrow());
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return buildAuthRequiredResult();
      return buildErrorResult(e.message);
    }

    let toolResult: any;
    try {
      toolResult = await callUpstreamTool(accessToken, "fetch", {});
    } catch (e: any) {
      if (e instanceof AuthRequiredError) return buildAuthRequiredResult();
      return buildErrorResult(e.message);
    }

    const payload = extractPayload(toolResult);
    const routed = routePayload(payload, 5);
    return routed ?? buildFallbackResult(toolResult, payload);
  }

  // reauth：授權過期時呼叫，回傳一次性、10 分鐘內有效的重新登入連結。
  // baseUrl 是這次請求實際打進來的網址（本機測試就是 localhost，正式環境就是正式網址）。
  async function reauth() {
    let grantId: string;
    try {
      grantId = getGrantIdOrThrow();
    } catch {
      return buildErrorResult(
        "目前沒有偵測到任何授權狀態，請透過原本的 MCP 連線設定流程完成一次初始授權。"
      );
    }

    const nonce = crypto.randomUUID();
    await env.OAUTH_KV.put(
      `reauth_nonce:${nonce}`,
      JSON.stringify({ grantId }),
      { expirationTtl: REAUTH_NONCE_TTL_SECONDS }
    );

    const reauthUrl = `${baseUrl}/reauth/${nonce}`;

    return {
      content: [
        {
          type: "text" as const,
          text:
            `請在瀏覽器中打開以下連結，重新登入 NYCU 帳號完成授權：\n\n` +
            `[點此重新登入](${reauthUrl})\n\n` +
            `此連結 10 分鐘內有效，且只能使用一次。登入完成後，回到這裡重新送出剛才的查詢即可。`,
        },
      ],
    };
  }

  // remove_auth：手動清除目前快取的 NYCU token。
  async function removeAuth() {
    let grantId: string;
    try {
      grantId = getGrantIdOrThrow();
    } catch {
      return buildErrorResult("目前沒有偵測到任何授權狀態，無需移除。");
    }

    await env.OAUTH_KV.delete(`nycu_token:${grantId}`);

    return {
      content: [
        {
          type: "text" as const,
          text:
            "已移除目前快取的 NYCU 授權。下次查詢會提示需要重新登入；" +
            "也可以直接呼叫 reauth 立即取得重新登入連結。",
        },
      ],
    };
  }

  return { search, fetch: fetchAccount, reauth, remove_auth: removeAuth };
}

function buildServer(env: Env, baseUrl: string) {
  const server = new McpServer({ name: "nycu-library-mcp-wrapper", version: "1.6.2" });
  const handlers = createToolHandlers(env, baseUrl);

  server.registerTool(
    "search",
    {
      description: "搜尋陽明交大圖書館館藏，包含各校區館藏狀態與索書號。",
      inputSchema: z.object({
        query: z.string(),
        resource_type: z.string().optional(),
        search_by: z.string().optional(),
        access: z.string().optional(),
        scope: z.string().optional(),
        sort: z.string().optional(),
        offset: z.number().optional().describe("分頁位移量，配合 has_more 往後翻頁"),
        max: z.number().optional().describe("這次顯示在 content 裡的筆數上限，預設 5"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.search
  );

  server.registerTool(
    "fetch",
    {
      description: "查詢我目前的圖書館帳戶：借閱中、預約中、採購申請。",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.fetch
  );

  server.registerTool(
    "reauth",
    {
      description: "當 search 或 fetch 回報授權過期時呼叫，取得重新登入連結。",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handlers.reauth
  );

  server.registerTool(
    "remove_auth",
    {
      description: "手動清除目前快取的 NYCU 授權，用於登出或懷疑 token 異常時。",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handlers.remove_auth
  );

  return server;
}

export const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const baseUrl = new URL(request.url).origin;
    const handler = createMcpHandler(() => buildServer(env, baseUrl), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
