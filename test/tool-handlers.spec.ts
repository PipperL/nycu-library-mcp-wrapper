import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock() 的內容會被 vitest 自動 hoist 到檔案最上面執行，所以裡面用到的變數
// 必須先用 vi.hoisted() 宣告，不能直接用檔案下方才 import/宣告的一般變數。
const { mockGetMcpAuthContext, mockCallTool, mockConnect, mockClose } = vi.hoisted(() => ({
  mockGetMcpAuthContext: vi.fn(),
  mockCallTool: vi.fn(),
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
}));

// getMcpAuthContext 平常是靠 agents/mcp 整套 request 處理機制（AsyncLocalStorage）
// 才拿得到值，繞過 createMcpHandler 直接呼叫 createToolHandlers() 時完全沒有這個
// context，所以一定要換成假的，讓測試自己決定「這次呼叫要假裝哪個 grantId 已登入」。
vi.mock("agents/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("agents/mcp")>();
  return { ...actual, getMcpAuthContext: mockGetMcpAuthContext };
});

// callUpstreamTool 平常會真的連上 https://mcp.lib.nycu.edu.tw——這裡把
// Client/StreamableHTTPClientTransport 換成假的，callTool() 直接回傳我們指定的
// 假資料，完全不觸碰真實網路。UnauthorizedError 保留原本真的那個 class（用
// importOriginal 取得），因為 callUpstreamTool 的 catch 區塊會用 instanceof 判斷它。
vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/client")>();
  return {
    ...actual,
    // callUpstreamTool 是用 `new Client(...)` 建構，箭頭函式沒辦法當建構子
    // （`new (() => {})()` 會直接丟 TypeError），所以這裡一定要用一般 function，
    // 讓 `new` 呼叫時可以正確回傳這個假物件當作 instance。
    Client: vi.fn().mockImplementation(function () {
      return {
        connect: mockConnect,
        callTool: mockCallTool,
        close: mockClose,
      };
    }),
    StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

import { UnauthorizedError } from "@modelcontextprotocol/client";
import { createToolHandlers } from "../src/mcp-server";

const BASE_URL = "https://example.com";

// ---------------------------------------------------------------------------
// Fixtures：2026-09 用 MCP Inspector 連上正式部署的 Worker、實際呼叫 search／fetch
// 拿到的真實 upstream structuredContent.original_payload，書名/作者/日期/loan_id
// 已置換成假資料去識別化，但欄位名稱與巢狀結構原封不動——這是目前唯一「真的跟
// upstream 對過」的 fixture，不是憑空編的。
// ---------------------------------------------------------------------------

const REAL_CATALOG_PAYLOAD = {
  data: [
    {
      type: "book",
      title: "K7超頻散熱祕笈 ",
      author: "柯志賢, 著",
      year: "2001 ; 2001[民90]",
      access: "physical",
      locations: [
        {
          status: "available",
          location: "Hsinchu Chiaotung Campus Library - 4th Floor-Chinese Books",
          callNumber: "471.516 4147",
        },
      ],
      primo_id: "alma990009003930206772",
    },
    {
      type: "book",
      title: "计算机散热技术",
      author: "杨伍民",
      year: "2010",
      access: "online",
      locations: [],
      primo_id: "alma990057378910206772",
    },
  ],
  viewType: "catalog",
};

// 去識別化過的 fetch payload。真實資料的 viewType 是 "dashboard"，不是原本以為
// 的 "account_dashboard"——這份 fixture 特意保留這個真實觀察到的值，讓測試能
// 蓋到 routePayload 這個修正。requests/purchase_requests 因為帳號目前沒有真實
// 紀錄，仍然是空陣列，欄位假設還沒真的被驗證過（SPEC.md §9 有記錄這個限制）。
const REAL_ACCOUNT_DASHBOARD_PAYLOAD = {
  data: {
    loans: [
      {
        loan_id: "90000000010006772",
        title: "測試書名一：假設性書名，用來驗證正規化邏輯",
        author: "測試作者,",
        due_date: "2099-01-15T15:59:00.000Z",
        loan_date: "2098-12-01T02:00:00.000Z",
        publication_year: "2020",
        last_renew_date: "2098-12-20T15:00:00.000Z",
        circ_desk: "測試校區借還書櫃台",
        resource_type: "(I01) Book",
        loan_fine: null,
      },
      {
        loan_id: "90000000020006772",
        title: "測試書名二",
        author: "另一位測試作者",
        due_date: "2099-01-20T15:59:00.000Z",
        loan_date: "2098-12-05T03:00:00.000Z",
        publication_year: "2021",
        last_renew_date: "2098-12-25T15:00:00.000Z",
        circ_desk: "測試校區借還書櫃台",
        resource_type: "(I01) Book",
        loan_fine: null,
      },
    ],
    requests: [],
    purchase_requests: [],
    total_loans: 2,
    total_requests: 0,
    total_purchase_requests: 0,
  },
  viewType: "dashboard", // ← 真實觀察到的值，不是 "account_dashboard"
};

beforeEach(() => {
  mockGetMcpAuthContext.mockReset();
  mockCallTool.mockReset();
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockClose.mockReset().mockResolvedValue(undefined);
});

describe("search", () => {
  it("沒有 grantId（尚未登入）時，回傳 auth-required 錯誤，且完全不呼叫上游", async () => {
    mockGetMcpAuthContext.mockReturnValue({ props: {} });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.search({ query: "散熱" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reauth");
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it("有 grantId 但 KV 裡沒有對應 token 時，回傳 auth-required 錯誤", async () => {
    mockGetMcpAuthContext.mockReturnValue({ props: { grantId: "grant-no-token" } });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.search({ query: "散熱" });

    expect(result.isError).toBe(true);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it("成功時：真的呼叫上游 client.callTool，並用真實 upstream 形狀的 fixture 正確組出逐筆結果", async () => {
    await env.OAUTH_KV.put("nycu_token:grant-search-ok", JSON.stringify({ access_token: "fake-access-token" }));
    mockGetMcpAuthContext.mockReturnValue({ props: { grantId: "grant-search-ok" } });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Displaying 2 catalog item(s)." }],
      structuredContent: REAL_CATALOG_PAYLOAD,
    });

    const handlers = createToolHandlers(env, BASE_URL);
    const result: any = await handlers.search({ query: "散熱" });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "search",
      arguments: expect.objectContaining({ query: "散熱" }),
    });
    expect(result.content[0].text).toContain("K7超頻散熱祕笈");
    expect(result.content[0].text).toContain("计算机散热技术");
    expect(result.structuredContent.viewType).toBe("catalog");
    expect(result.structuredContent.normalized_data.items).toHaveLength(2);
  });

  it("上游回傳 401（UnauthorizedError）時，回傳 auth-required 錯誤", async () => {
    await env.OAUTH_KV.put("nycu_token:grant-search-401", JSON.stringify({ access_token: "stale-token" }));
    mockGetMcpAuthContext.mockReturnValue({ props: { grantId: "grant-search-401" } });
    mockCallTool.mockRejectedValue(new UnauthorizedError("token expired"));

    const handlers = createToolHandlers(env, BASE_URL);
    const result: any = await handlers.search({ query: "散熱" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reauth");
  });
});

describe("fetch", () => {
  it("成功時：正確處理真實 upstream 的 viewType: \"dashboard\"（迴歸測試，不是 \"account_dashboard\"）", async () => {
    await env.OAUTH_KV.put("nycu_token:grant-fetch-ok", JSON.stringify({ access_token: "fake-access-token" }));
    mockGetMcpAuthContext.mockReturnValue({ props: { grantId: "grant-fetch-ok" } });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Displaying dashboard." }],
      structuredContent: REAL_ACCOUNT_DASHBOARD_PAYLOAD,
    });

    const handlers = createToolHandlers(env, BASE_URL);
    const result: any = await handlers.fetch();

    expect(mockCallTool).toHaveBeenCalledWith({ name: "fetch", arguments: {} });
    // 這是這個 wrapper 自己輸出的 viewType（SPEC.md §6 的公開格式），
    // 跟 upstream 原始的 "dashboard" 是兩件事，兩個都要是對的。
    expect(result.structuredContent.viewType).toBe("account_dashboard");
    expect(result.content[0].text).toContain("測試書名一");
    expect(result.content[0].text).toContain("測試書名二");
    expect(result.structuredContent.normalized_data.loans).toHaveLength(2);
    // loan_fine 真實資料是 null，確認 normalizeLoan 的 ?? 正確處理成空字串。
    expect(result.structuredContent.normalized_data.loans[0].loanFine).toBe("");
  });

  it("沒有 grantId 時，回傳 auth-required 錯誤", async () => {
    mockGetMcpAuthContext.mockReturnValue({ props: {} });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.fetch();

    expect(result.isError).toBe(true);
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

describe("reauth", () => {
  it("有 grantId 時，建立單次有效的 nonce、寫進 KV，並回傳含 baseUrl 的連結", async () => {
    mockGetMcpAuthContext.mockReturnValue({ props: { grantId: "grant-reauth" } });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.reauth();

    expect(result.content[0].text).toContain(`${BASE_URL}/reauth/`);
    const match = result.content[0].text.match(/\/reauth\/([a-f0-9-]+)/);
    expect(match).toBeTruthy();

    const stored = await env.OAUTH_KV.get(`reauth_nonce:${match![1]}`);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toEqual({ grantId: "grant-reauth" });
  });

  it("沒有 grantId 時，提示先完成初始授權，而不是直接生連結", async () => {
    mockGetMcpAuthContext.mockReturnValue({ props: {} });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.reauth();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("初始授權");
  });
});

describe("remove_auth", () => {
  it("有 grantId 時，刪除 KV 裡對應的 token", async () => {
    await env.OAUTH_KV.put("nycu_token:grant-remove", "some-token-record");
    mockGetMcpAuthContext.mockReturnValue({ props: { grantId: "grant-remove" } });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.remove_auth();

    expect(result.content[0].text).toContain("已移除");
    expect(await env.OAUTH_KV.get("nycu_token:grant-remove")).toBeNull();
  });

  it("沒有 grantId 時，回傳無需移除的訊息", async () => {
    mockGetMcpAuthContext.mockReturnValue({ props: {} });
    const handlers = createToolHandlers(env, BASE_URL);

    const result: any = await handlers.remove_auth();

    expect(result.content[0].text).toContain("無需移除");
  });
});
