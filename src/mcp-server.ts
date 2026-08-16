import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
// 若上面這行 import 在你的 agents 版本 resolve 不到，改成：
// import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

const UPSTREAM_MCP_URL = "https://mcp.lib.nycu.edu.tw/mcp";
const SESSION_TTL_SECONDS = 240;

interface Env {
  OAUTH_KV: KVNamespace;
}

// ---------------------------------------------------------------------------
// Catalog normalize（search 工具用）
// ---------------------------------------------------------------------------

interface LocationInfo {
  location: string;
  availability: string;
  callNumber: string;
}

interface CatalogItem {
  title: string;
  author: string;
  year: string;
  resourceType: string;
  primoId: string;
  link: string;
  locations: LocationInfo[];
}

function normalizeCatalogItem(raw: any): CatalogItem {
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

function renderCatalogMarkdown(
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
        const availLabel = loc.availability === "available" ? "可借閱" : "不可借閱";
        md += `  - ${loc.location}｜${loc.callNumber}｜${availLabel}\n`;
      });
    }
    if (it.link) md += `- Link: ${it.link}\n`;
    md += `\n`;
  });
  return md;
}

function renderCatalogModelContent(items: CatalogItem[], total: number): string {
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
// 欄位名稱依「實際觀察到的 structuredContent」為準（snake_case），
// 不是照 tool description 裡寫的 camelCase。
// ---------------------------------------------------------------------------

interface LoanItem {
  title: string;
  author: string;
  dueDate: string;
  loanDate: string;
  circDesk: string;
  resourceType: string;
  loanFine: string;
}

interface RequestItem {
  title: string;
  status: string;
  pickupLocation: string;
  expiryDate: string;
}

interface PurchaseRequestItem {
  title: string;
  status: string;
  createdAt: string;
  isbn: string;
}

function normalizeLoan(raw: any): LoanItem {
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

function normalizeRequest(raw: any): RequestItem {
  return {
    title: raw.title ?? "",
    status: raw.status ?? "",
    pickupLocation: raw.pickup_location ?? raw.pickupLocation ?? "",
    expiryDate: raw.expiry_date ?? raw.expiryDate ?? "",
  };
}

function normalizePurchaseRequest(raw: any): PurchaseRequestItem {
  return {
    title: raw.title ?? "",
    status: raw.status ?? "",
    createdAt: raw.created_at ?? raw.createdAt ?? "",
    isbn: raw.isbn ?? "",
  };
}

function renderAccountMarkdown(loans: LoanItem[], requests: RequestItem[], purchaseRequests: PurchaseRequestItem[]): string {
  let md = `### My Library Account\n\n`;
  md += `${loans.length} loans, ${requests.length} requests, ${purchaseRequests.length} purchase requests\n\n`;

  if (loans.length) {
    md += `#### 借閱中\n\n`;
    loans.forEach((l, i) => {
      const due = l.dueDate ? new Date(l.dueDate).toLocaleDateString("zh-TW") : "";
      md += `${i + 1}. **${l.title}**（${l.author}）\n   - 到期日：${due}${l.loanFine ? `　罰款：${l.loanFine}` : ""}\n`;
    });
    md += `\n`;
  }
  if (requests.length) {
    md += `#### 預約中\n\n`;
    requests.forEach((r, i) => {
      md += `${i + 1}. **${r.title}**（${r.status}）取書地點：${r.pickupLocation}\n`;
    });
    md += `\n`;
  }
  if (purchaseRequests.length) {
    md += `#### 採購申請\n\n`;
    purchaseRequests.forEach((p, i) => {
      md += `${i + 1}. **${p.title}**（${p.status}）\n`;
    });
  }
  return md;
}

function renderAccountModelContent(loans: LoanItem[], requests: RequestItem[], purchaseRequests: PurchaseRequestItem[]): string {
  let out = `Account dashboard: ${loans.length} loans, ${requests.length} requests, ${purchaseRequests.length} purchase requests.\n`;
  loans.forEach((l, i) => {
    out += `Loan ${i + 1}: ${l.title} | Author: ${l.author} | Due: ${l.dueDate} | Fine: ${l.loanFine || "none"}\n`;
  });
  requests.forEach((r, i) => {
    out += `Request ${i + 1}: ${r.title} | Status: ${r.status} | Pickup: ${r.pickupLocation}\n`;
  });
  purchaseRequests.forEach((p, i) => {
    out += `PurchaseRequest ${i + 1}: ${p.title} | Status: ${p.status}\n`;
  });
  return out;
}

// ---------------------------------------------------------------------------
// SSE / JSON-RPC response 解析
// ---------------------------------------------------------------------------

async function readMcpResponse(resp: Response): Promise<any> {
  const contentType = resp.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return resp.json();
  }

  if (contentType.includes("text/event-stream")) {
    const text = await resp.text();
    const messages: any[] = [];
    for (const block of text.split("\n\n")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        try {
          messages.push(JSON.parse(dataLine.slice(5).trim()));
        } catch {
          // 忽略無法解析的片段
        }
      }
    }
    const found = messages.reverse().find((m) => "result" in m || "error" in m);
    if (!found) {
      throw new Error(`No valid JSON-RPC message in SSE stream: ${text.slice(0, 200)}`);
    }
    return found;
  }

  const bodyPreview = (await resp.text()).slice(0, 200);
  throw new Error(`Unexpected content-type: ${contentType}, body: ${bodyPreview}`);
}

/** 優先讀 structuredContent（乾淨的 JSON），content[].text 可能帶 "[ui_payload]" 前綴，作為備援才嘗試清洗解析。 */
function extractPayload(toolResult: any): any {
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
// Session 快取 + 上游 MCP client
// ---------------------------------------------------------------------------

function buildHeaders(accessToken: string, sessionId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return headers;
}

async function initializeSession(accessToken: string): Promise<string> {
  const initResp = await fetch(UPSTREAM_MCP_URL, {
    method: "POST",
    headers: buildHeaders(accessToken),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "nycu-library-mcp-wrapper", version: "1.0.0" },
      },
    }),
  });
  if (initResp.status === 401) throw new Error("NYCU 授權已過期，請重新登入。");
  const sessionId = initResp.headers.get("mcp-session-id");
  if (!sessionId) throw new Error(`Upstream initialize failed: ${await initResp.text()}`);

  await fetch(UPSTREAM_MCP_URL, {
    method: "POST",
    headers: buildHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return sessionId;
}

async function getSessionId(env: Env, grantId: string, accessToken: string): Promise<string> {
  const cacheKey = `session:${grantId}`;
  const cached = await env.OAUTH_KV.get(cacheKey);
  if (cached) return cached;

  const sessionId = await initializeSession(accessToken);
  await env.OAUTH_KV.put(cacheKey, sessionId, { expirationTtl: SESSION_TTL_SECONDS });
  return sessionId;
}

function looksLikeSessionError(message: string): boolean {
  return /session/i.test(message);
}

async function callUpstreamTool(
  env: Env,
  grantId: string,
  accessToken: string,
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  let sessionId = await getSessionId(env, grantId, accessToken);

  const doCall = async (sid: string) =>
    fetch(UPSTREAM_MCP_URL, {
      method: "POST",
      headers: buildHeaders(accessToken, sid),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

  let resp = await doCall(sessionId);
  if (resp.status === 401) throw new Error("NYCU 授權已過期，請重新登入。");

  try {
    const rpcResult: any = await readMcpResponse(resp);
    if (rpcResult.error) throw new Error(JSON.stringify(rpcResult.error));
    return rpcResult.result;
  } catch (e: any) {
    if (!looksLikeSessionError(e.message)) throw e;

    await env.OAUTH_KV.delete(`session:${grantId}`);
    sessionId = await initializeSession(accessToken);
    await env.OAUTH_KV.put(`session:${grantId}`, sessionId, { expirationTtl: SESSION_TTL_SECONDS });

    resp = await doCall(sessionId);
    if (resp.status === 401) throw new Error("NYCU 授權已過期，請重新登入。");
    const rpcResult: any = await readMcpResponse(resp);
    if (rpcResult.error) throw new Error(JSON.stringify(rpcResult.error));
    return rpcResult.result;
  }
}

// ---------------------------------------------------------------------------
// 正規化輸出建構
// ---------------------------------------------------------------------------

function buildCatalogResult(payload: any, max: number) {
  const items: CatalogItem[] = payload.data.items.map(normalizeCatalogItem);
  const shown = items.slice(0, max);
  const hasMore = Boolean(payload.data.has_more) || items.length > shown.length;

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

function buildAccountResult(payload: any) {
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

function buildFallbackResult(toolResult: any, parsedPayload: any) {
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

function buildErrorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

/** 依實際 payload 形狀判斷是 catalog 還是 account dashboard，viewType 缺失時用形狀推斷。 */
function routePayload(payload: any, max: number) {
  if (!payload) return null;

  if (payload.viewType === "catalog" || Array.isArray(payload.data?.items)) {
    return buildCatalogResult(payload, max);
  }
  if (
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
// MCP server：search / fetch（不包 fetch_account_page，官方標明非給模型用）
// ---------------------------------------------------------------------------

function buildServer(env: Env) {
  const server = new McpServer({ name: "nycu-library-mcp-wrapper", version: "1.2.0" });

  async function getAccessTokenOrThrow(): Promise<{ grantId: string; accessToken: string }> {
    const auth: any = getMcpAuthContext();
    const grantId = auth?.props?.grantId;
    if (!grantId) throw new Error("No NYCU token found. Please re-authenticate.");

    const tokenRecord = await env.OAUTH_KV.get(`nycu_token:${grantId}`);
    if (!tokenRecord) throw new Error("No NYCU token found. Please re-authenticate.");

    const { access_token } = JSON.parse(tokenRecord);
    return { grantId, accessToken: access_token };
  }

  server.tool(
    "search",
    {
      query: z.string(),
      resource_type: z.string().optional(),
      search_by: z.string().optional(),
      access: z.string().optional(),
      scope: z.string().optional(),
      sort: z.string().optional(),
      offset: z.number().optional().describe("分頁位移量，配合 has_more 往後翻頁"),
      max: z.number().optional().describe("這次顯示在 content 裡的筆數上限，預設 5"),
    },
    async ({ query, resource_type, search_by, access, scope, sort, offset, max }) => {
      let grantId: string, accessToken: string;
      try {
        ({ grantId, accessToken } = await getAccessTokenOrThrow());
      } catch (e: any) {
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
        toolResult = await callUpstreamTool(env, grantId, accessToken, "search", args);
      } catch (e: any) {
        return buildErrorResult(e.message);
      }

      const payload = extractPayload(toolResult);
      const routed = routePayload(payload, max ?? 5);
      return routed ?? buildFallbackResult(toolResult, payload);
    }
  );

  // fetch：借閱紀錄 / 預約 / 採購申請儀表板。無參數（身分從 token 解析）。
  server.tool("fetch", {}, async () => {
    let grantId: string, accessToken: string;
    try {
      ({ grantId, accessToken } = await getAccessTokenOrThrow());
    } catch (e: any) {
      return buildErrorResult(e.message);
    }

    let toolResult: any;
    try {
      toolResult = await callUpstreamTool(env, grantId, accessToken, "fetch", {});
    } catch (e: any) {
      return buildErrorResult(e.message);
    }

    const payload = extractPayload(toolResult);
    const routed = routePayload(payload, 5);
    return routed ?? buildFallbackResult(toolResult, payload);
  });

  return server;
}

export const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const handler = createMcpHandler(() => buildServer(env), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
