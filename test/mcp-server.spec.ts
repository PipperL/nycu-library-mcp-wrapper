import { describe, it, expect } from "vitest";
import {
  normalizeCatalogItem,
  normalizeLoan,
  normalizeRequest,
  normalizePurchaseRequest,
  extractPayload,
  routePayload,
  buildCatalogResult,
  buildAccountResult,
  buildErrorResult,
  buildAuthRequiredResult,
} from "../src/mcp-server";

// ---------------------------------------------------------------------------
// normalize* — 這些函式吃的是 upstream 的原始 raw payload，欄位可能缺漏，
// 核心保護點是：任何缺欄位都要 fallback 成安全預設值，不能讓後面的
// render/join 邏輯因為 undefined 而炸掉（這正是 1.5.0 修過的那個
// `Cannot read properties of undefined (reading 'map')` bug的同一種風險類型）。
// ---------------------------------------------------------------------------

describe("normalizeCatalogItem", () => {
  it("完整欄位時正確對應", () => {
    const item = normalizeCatalogItem({
      title: "資料結構",
      author: "王小明",
      year: "2024",
      type: "book",
      primo_id: "abc123",
      link: "https://example.com/abc123",
      locations: [{ location: "總圖", status: "available", callNumber: "QA76.9" }],
    });
    expect(item).toEqual({
      title: "資料結構",
      author: "王小明",
      year: "2024",
      resourceType: "book",
      primoId: "abc123",
      link: "https://example.com/abc123",
      locations: [{ location: "總圖", availability: "available", callNumber: "QA76.9" }],
    });
  });

  it("缺欄位時 fallback 成空字串／空陣列，不拋錯", () => {
    const item = normalizeCatalogItem({});
    expect(item).toEqual({
      title: "",
      author: "",
      year: "",
      resourceType: "",
      primoId: "",
      link: "",
      locations: [],
    });
  });

  it("locations 缺失時不會因為 .map 而崩潰", () => {
    expect(() => normalizeCatalogItem({ title: "無館藏資訊的書" })).not.toThrow();
  });
});

describe("normalizeLoan / normalizeRequest / normalizePurchaseRequest", () => {
  it("normalizeLoan 對應 snake_case 欄位", () => {
    const loan = normalizeLoan({
      title: "深入淺出演算法",
      author: "李四",
      due_date: "2026-09-10",
      loan_date: "2026-08-10",
      circ_desk: "總圖服務台",
      resource_type: "book",
      loan_fine: "NT$50",
    });
    expect(loan).toEqual({
      title: "深入淺出演算法",
      author: "李四",
      dueDate: "2026-09-10",
      loanDate: "2026-08-10",
      circDesk: "總圖服務台",
      resourceType: "book",
      loanFine: "NT$50",
    });
  });

  it("normalizeLoan 缺欄位時 fallback 為空字串", () => {
    expect(normalizeLoan({})).toEqual({
      title: "",
      author: "",
      dueDate: "",
      loanDate: "",
      circDesk: "",
      resourceType: "",
      loanFine: "",
    });
  });

  // requests / purchase_requests 的欄位依 upstream fetch 工具 description 與 upstream 自己的
  // dashboard UI 實際讀取的欄位（2026-10-08 確認），帳號目前沒有真實紀錄可錄 fixture。
  it("normalizeRequest 對應 upstream 的 request_status / request_date / author", () => {
    expect(
      normalizeRequest({
        title: "A",
        author: "王小明",
        description: "v.1",
        request_status: "IN_PROCESS",
        request_date: "2026-10-01Z",
        pickup_location: "總圖",
      })
    ).toEqual({ title: "A", author: "王小明", status: "IN_PROCESS", pickupLocation: "總圖", requestDate: "2026-10-01Z" });
  });

  it("normalizeRequest 沒有 request_status 時退回舊的 status / pickupLocation 欄位", () => {
    expect(normalizeRequest({ title: "B", status: "ready", pickupLocation: "分館" })).toEqual({
      title: "B",
      author: "",
      status: "ready",
      pickupLocation: "分館",
      requestDate: "",
    });
  });

  it("normalizePurchaseRequest 對應 upstream 的 request_id / request_date / author / isbn", () => {
    expect(
      normalizePurchaseRequest({
        request_id: "PR1",
        title: "C",
        author: "李四",
        isbn: "9789571234567",
        request_date: "2026-01-01Z",
        status: "APPROVED",
        request_status: "ACTIVE",
      })
    ).toEqual({
      requestId: "PR1",
      title: "C",
      author: "李四",
      isbn: "9789571234567",
      status: "APPROVED",
      requestDate: "2026-01-01Z",
    });
  });

  it("normalizePurchaseRequest 的 status 可能是 { value, desc } 物件，或缺失時退回 request_status", () => {
    expect(normalizePurchaseRequest({ title: "D", status: { value: "IN_REVIEW", desc: "In Review" } }).status).toBe("In Review");
    expect(normalizePurchaseRequest({ title: "E", status: { value: "IN_REVIEW" } }).status).toBe("IN_REVIEW");
    expect(normalizePurchaseRequest({ title: "F", status: null, request_status: "REJECTED" }).status).toBe("REJECTED");
    expect(normalizePurchaseRequest({ title: "G", status: "  " , request_status: "ACTIVE" }).status).toBe("ACTIVE");
  });

  it("normalizePurchaseRequest 沒有 request_date 時退回舊的 created_at / createdAt", () => {
    expect(normalizePurchaseRequest({ title: "H", created_at: "2026-01-01" }).requestDate).toBe("2026-01-01");
    expect(normalizePurchaseRequest({ title: "I", createdAt: "2026-02-02" }).requestDate).toBe("2026-02-02");
  });

  it("normalizeRequest / normalizePurchaseRequest 缺欄位時 fallback 為空字串", () => {
    expect(normalizeRequest({})).toEqual({ title: "", author: "", status: "", pickupLocation: "", requestDate: "" });
    expect(normalizePurchaseRequest({})).toEqual({ requestId: "", title: "", author: "", isbn: "", status: "", requestDate: "" });
  });
});

// ---------------------------------------------------------------------------
// extractPayload — 優先讀 structuredContent；備援才解析 content[].text
// ---------------------------------------------------------------------------

describe("extractPayload", () => {
  it("有 structuredContent 時直接回傳它", () => {
    const structuredContent = { viewType: "catalog", data: [] };
    expect(extractPayload({ structuredContent, content: [{ type: "text", text: "ignored" }] })).toBe(structuredContent);
  });

  it("沒有 structuredContent 時，從 content[].text 裡找 JSON 並解析", () => {
    const result = extractPayload({
      content: [{ type: "text", text: `[ui_payload] {"viewType":"catalog","data":[]}` }],
    });
    expect(result).toEqual({ viewType: "catalog", data: [] });
  });

  it("text 裡沒有可解析的 JSON 時回傳 null，不拋錯", () => {
    expect(extractPayload({ content: [{ type: "text", text: "Displaying 10 catalog item(s)." }] })).toBeNull();
  });

  it("完全沒有 structuredContent 也沒有 content 時回傳 null", () => {
    expect(extractPayload({})).toBeNull();
    expect(extractPayload(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// routePayload — 依 payload 形狀判斷 catalog vs account_dashboard。
// 這裡直接針對 1.5.0 修過的那個 bug 做迴歸測試：
// upstream 實際回傳的 catalog payload 形狀是 { data: [...], viewType: "catalog" }，
// data 本身就是陣列，不是 { data: { items: [...] } }。
// ---------------------------------------------------------------------------

describe("routePayload", () => {
  it("data 是陣列本身時，判斷成 catalog（迴歸測試：1.5.0 修過的 shape 假設錯誤）", () => {
    const payload = { viewType: "catalog", data: [{ title: "A" }, { title: "B" }] };
    const result = routePayload(payload, 5)!;
    expect(result.structuredContent.viewType).toBe("catalog");
    expect(result.structuredContent.normalized_data.items).toHaveLength(2);
  });

  it("即使沒有 viewType，只要 data 是陣列，也用形狀推斷成 catalog", () => {
    const payload = { data: [{ title: "A" }] };
    const result = routePayload(payload, 5)!;
    expect(result.structuredContent.viewType).toBe("catalog");
  });

  it("data.loans/requests/purchase_requests 任一為陣列時，判斷成 account_dashboard", () => {
    const payload = { data: { loans: [{ title: "借閱中的書" }], requests: [], purchase_requests: [] } };
    const result = routePayload(payload, 5)!;
    expect(result.structuredContent.viewType).toBe("account_dashboard");
    expect(result.structuredContent.normalized_data.loans).toHaveLength(1);
  });

  it("viewType 明確標示 account_dashboard 時優先採信", () => {
    const payload = { viewType: "account_dashboard", data: { loans: [], requests: [], purchase_requests: [] } };
    const result = routePayload(payload, 5)!;
    expect(result.structuredContent.viewType).toBe("account_dashboard");
  });

  it("無法辨識的形狀回傳 null，交給呼叫端處理 fallback", () => {
    expect(routePayload({ foo: "bar" }, 5)).toBeNull();
  });

  it("payload 為 null/undefined 時回傳 null，不拋錯", () => {
    expect(routePayload(null, 5)).toBeNull();
    expect(routePayload(undefined, 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildCatalogResult / buildAccountResult
// 核心設計原則（SPEC.md §6）：content 絕對不能退化成單句摘要，
// 一定要包含逐筆資料。這裡直接斷言 content[0].text 裡有書名，
// 而不只是檢查 summary 字串。
// ---------------------------------------------------------------------------

describe("buildCatalogResult", () => {
  const payload = {
    viewType: "catalog",
    data: [
      { title: "資料結構", author: "王小明", locations: [{ location: "總圖", status: "available", callNumber: "QA76.9" }] },
      { title: "演算法導論", author: "李四" },
      { title: "作業系統概念", author: "陳大文" },
    ],
  };

  it("content 是逐筆 Markdown，不是單句摘要", () => {
    const result = buildCatalogResult(payload, 5);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("資料結構");
    expect(result.content[0].text).toContain("演算法導論");
    expect(result.content[0].text).toContain("作業系統概念");
    // 不應該只剩一句話般長度的摘要
    expect(result.content[0].text.length).toBeGreaterThan(50);
  });

  it("max 小於總筆數時，hasMore 為 true，且只顯示前 max 筆", () => {
    const result = buildCatalogResult(payload, 2);
    expect(result.structuredContent.normalized_data.has_more).toBe(true);
    expect(result.structuredContent.normalized_data.items).toHaveLength(2);
    expect(result.content[0].text).not.toContain("作業系統概念");
  });

  it("max 大於等於總筆數時，hasMore 為 false", () => {
    const result = buildCatalogResult(payload, 10);
    expect(result.structuredContent.normalized_data.has_more).toBe(false);
    expect(result.structuredContent.normalized_data.items).toHaveLength(3);
  });

  it("original_payload 保留原始 upstream payload，未經修改（SPEC §2 要求）", () => {
    const result = buildCatalogResult(payload, 5);
    expect(result.structuredContent.original_payload).toBe(payload);
  });

  it("對 1.5.0 修過的實際 upstream 形狀（data 直接是陣列）不會拋錯", () => {
    expect(() => buildCatalogResult({ data: [{ title: "X" }] }, 5)).not.toThrow();
  });

  it("館藏狀態標籤：available_in_institution（scope: ust 實際出現的值）不會被標成不可借閱", () => {
    const text = (status: string) =>
      buildCatalogResult({ data: [{ title: "X", locations: [{ location: "L", status, callNumber: "C" }] }] }, 5).content[0].text;
    expect(text("available")).toContain("可借閱");
    expect(text("unavailable")).toContain("不可借閱");
    expect(text("available_in_institution")).toContain("他校館藏可借閱");
    expect(text("available_in_institution")).not.toContain("不可借閱");
    // 未知的值顯示原字串，不猜
    expect(text("on_order")).toContain("on_order");
  });
});

describe("buildAccountResult", () => {
  it("content 包含借閱／預約／採購申請的逐筆資料", () => {
    const payload = {
      viewType: "account_dashboard",
      data: {
        loans: [{ title: "借閱中的書", author: "作者A", due_date: "2026-09-10" }],
        requests: [{ title: "預約中的書", status: "pending", pickup_location: "總圖" }],
        purchase_requests: [{ title: "採購申請的書", status: "review" }],
      },
    };
    const result = buildAccountResult(payload);
    expect(result.content[0].text).toContain("借閱中的書");
    expect(result.content[0].text).toContain("預約中的書");
    expect(result.content[0].text).toContain("採購申請的書");
    expect(result.structuredContent.normalized_data.loans).toHaveLength(1);
    expect(result.structuredContent.normalized_data.requests).toHaveLength(1);
    expect(result.structuredContent.normalized_data.purchase_requests).toHaveLength(1);
  });

  it("預約／採購申請用 upstream 實際欄位時，狀態、日期、ISBN 都會出現在 content 跟 model_content", () => {
    const payload = {
      viewType: "dashboard",
      data: {
        loans: [],
        requests: [{ title: "預約中的書", author: "作者B", request_status: "IN_PROCESS", request_date: "2026-10-01T00:00:00Z", pickup_location: "總圖" }],
        purchase_requests: [{ request_id: "PR1", title: "採購申請的書", author: "作者C", isbn: "9789571234567", request_date: "2026-09-01T00:00:00Z", status: { value: "IN_REVIEW", desc: "In Review" } }],
      },
    };
    const result = buildAccountResult(payload);
    const text = result.content[0].text;
    expect(text).toContain("IN_PROCESS");
    expect(text).toContain("總圖");
    expect(text).toContain("In Review");
    expect(text).toContain("9789571234567");
    const model = result.structuredContent.model_content;
    expect(model).toContain("Status: IN_PROCESS");
    expect(model).toContain("Requested: 2026-10-01T00:00:00Z");
    expect(model).toContain("Status: In Review");
    expect(model).toContain("ISBN: 9789571234567");
  });

  it("三個分類都是空陣列時，不拋錯，且不出現該分類的標題", () => {
    const payload = { data: { loans: [], requests: [], purchase_requests: [] } };
    const result = buildAccountResult(payload);
    expect(result.content[0].text).not.toContain("借閱中");
    expect(result.content[0].text).not.toContain("預約中");
    expect(result.content[0].text).not.toContain("採購申請");
    expect(result.structuredContent.summary).toBe("0 loans, 0 requests, 0 purchase requests.");
  });
});

describe("buildErrorResult / buildAuthRequiredResult", () => {
  it("buildErrorResult 標記 isError: true", () => {
    const result = buildErrorResult("發生錯誤");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("發生錯誤");
  });

  it("buildAuthRequiredResult 明確指引模型呼叫 reauth", () => {
    const result = buildAuthRequiredResult();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reauth");
  });
});
