import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// 之前這個檔案是 Cloudflare Workers 專案模板留下來的空殼測試，斷言 worker 會回
// "Hello World!"——但這個 worker 早就不是那個模板了（見 src/index.ts /
// src/auth-handler.ts）。這裡改成針對這個專案實際的路由行為寫測試。

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function callWorker(request: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as any, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("未知路徑", () => {
  it("回傳 404 Not found（不是模板留下的 Hello World!）", async () => {
    const request = new IncomingRequest("https://example.com/nonexistent");
    const response = await callWorker(request);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});

describe("/callback", () => {
  it("缺少 code 與 state 時回傳 400", async () => {
    const request = new IncomingRequest("https://example.com/callback");
    const response = await callWorker(request);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing code/state");
  });

  it("只有 code 沒有 state 時一樣回傳 400", async () => {
    const request = new IncomingRequest("https://example.com/callback?code=abc");
    const response = await callWorker(request);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing code/state");
  });

  it("code/state 都有，但 KV 裡找不到對應的 pkce 紀錄時回傳 400（例如過期或重放）", async () => {
    const request = new IncomingRequest("https://example.com/callback?code=abc&state=never-issued-state");
    const response = await callWorker(request);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("State expired or invalid");
  });
});

describe("/reauth/:nonce", () => {
  it("nonce 不存在或已使用過時回傳 400，並提示重新呼叫 reauth", async () => {
    const request = new IncomingRequest("https://example.com/reauth/never-issued-nonce");
    const response = await callWorker(request);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("此連結已失效或已使用過");
  });

  it("有效 nonce：導向 NYCU 登入頁、帶正確 PKCE 參數，且 nonce 單次用完即刪除", async () => {
    // 預先塞入快取的 client_id，避免這個測試真的去打 NYCU 的 DCR endpoint。
    await env.OAUTH_KV.put("nycu_dcr_client_id", "test-client-id");
    await env.OAUTH_KV.put(
      "reauth_nonce:test-nonce",
      JSON.stringify({ grantId: "test-grant-id" })
    );

    const request = new IncomingRequest("https://example.com/reauth/test-nonce");
    const response = await callWorker(request);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://mcp.lib.nycu.edu.tw");
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();

    // 單次有效：用過的 nonce 應該已經從 KV 被刪除。
    expect(await env.OAUTH_KV.get("reauth_nonce:test-nonce")).toBeNull();

    // 導向時帶的 state 要能在 KV 裡查到對應的 pkce 紀錄，且標記 mode: "reauth"
    // 跟原本的 grantId，這樣 /callback 收到後才知道要更新哪個既有 grant。
    const stateId = location.searchParams.get("state")!;
    const pkceRecord = await env.OAUTH_KV.get(`pkce:${stateId}`);
    expect(pkceRecord).toBeTruthy();
    const parsed = JSON.parse(pkceRecord!);
    expect(parsed.mode).toBe("reauth");
    expect(parsed.grantId).toBe("test-grant-id");
  });
});
