import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("/callback 成功路徑（mode: initial / reauth）", () => {
  // 這兩個測試會真的走到 fetch(TOKEN_URL, ...)（跟 NYCU 換 token），
  // 用 vi.spyOn 假造回應，避免真的打上游網路。DCR 用的 nycu_dcr_client_id
  // 每個測試都會各自先塞進 KV，跳過真的呼叫 NYCU 的 /oauth/register。
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("mode: reauth 成功時：跟 NYCU 換到新 token、寫回既有 grantId、清掉舊 session，回傳成功訊息", async () => {
    await env.OAUTH_KV.put("nycu_dcr_client_id", "cached-client-id");
    await env.OAUTH_KV.put(
      "reauth_nonce:happy-nonce",
      JSON.stringify({ grantId: "existing-grant" })
    );
    // 預先塞一筆舊的 upstream session 快取，驗證 reauth 成功後真的會被清掉
    // （否則下一次 search/fetch 會沿用過期 token 綁定的 session，繼續失敗）。
    await env.OAUTH_KV.put("session:existing-grant", "stale-session-data");

    const reauthResp = await callWorker(
      new IncomingRequest("https://example.com/reauth/happy-nonce")
    );
    expect(reauthResp.status).toBe(302);
    const stateId = new URL(reauthResp.headers.get("location")!).searchParams.get("state")!;

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "new-upstream-token", token_type: "Bearer", expires_in: 259200 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const callbackResp = await callWorker(
      new IncomingRequest(`https://example.com/callback?code=fake-nycu-code&state=${stateId}`)
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://mcp.lib.nycu.edu.tw/oauth/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(callbackResp.status).toBe(200);
    expect(await callbackResp.text()).toContain("重新授權成功");

    // state 用過即刪，且新 token 真的寫回同一個既有 grantId（不是建立新的）
    expect(await env.OAUTH_KV.get(`pkce:${stateId}`)).toBeNull();
    const tokenRecord = JSON.parse((await env.OAUTH_KV.get("nycu_token:existing-grant"))!);
    expect(tokenRecord.access_token).toBe("new-upstream-token");
    expect(await env.OAUTH_KV.get("session:existing-grant")).toBeNull();
  });

  it("mode: initial 成功時：完成 downstream 授權、簽發新 grantId，導回原本註冊的 client", async () => {
    await env.OAUTH_KV.put("nycu_dcr_client_id", "cached-client-id");

    // 1. 模擬 downstream（AI workspace）先對這個 wrapper 做 DCR，拿到 client_id。
    const registerResp = await callWorker(
      new IncomingRequest("https://example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://downstream-client.example.com/cb"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        }),
      })
    );
    expect(registerResp.status).toBe(201);
    const registerData: any = await registerResp.json();
    const clientId = registerData.client_id;

    // 2. downstream client 發起 /authorize（帶自己的 state 與 PKCE）。
    const authorizeUrl = new URL("https://example.com/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", "https://downstream-client.example.com/cb");
    authorizeUrl.searchParams.set("state", "downstream-state-xyz");
    authorizeUrl.searchParams.set("code_challenge", "downstream-challenge-value");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeResp = await callWorker(new IncomingRequest(authorizeUrl.toString()));
    expect(authorizeResp.status).toBe(302);
    const nycuLoginUrl = new URL(authorizeResp.headers.get("location")!);
    expect(nycuLoginUrl.origin).toBe("https://mcp.lib.nycu.edu.tw");
    const stateId = nycuLoginUrl.searchParams.get("state")!;

    // 3. 模擬使用者在 NYCU 完成登入後被導回 /callback，並假造 token exchange 回應。
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "nycu-access-token", token_type: "Bearer", expires_in: 259200 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    // 這個檔案裡的 KV 不是每個 it() 各自獨立的（同一個 env 物件貫穿整個檔案），
    // 所以 nycu_token: 前綴下可能已經有其他測試（例如上面的 reauth 測試）留下的
    // key。用「呼叫前後的差集」找出這次真正新增的 key，而不是直接假設只有一筆。
    const tokenKeysBefore = new Set(
      (await env.OAUTH_KV.list({ prefix: "nycu_token:" })).keys.map((k) => k.name)
    );

    const callbackResp = await callWorker(
      new IncomingRequest(`https://example.com/callback?code=fake-nycu-code&state=${stateId}`)
    );

    // completeAuthorization 會把 downstream 自己的 code/state 帶回它註冊的 redirect_uri，
    // 不是導去 NYCU 也不是留在這個 wrapper 上。
    expect(callbackResp.status).toBe(302);
    const finalRedirect = new URL(callbackResp.headers.get("location")!);
    expect(finalRedirect.origin + finalRedirect.pathname).toBe(
      "https://downstream-client.example.com/cb"
    );
    expect(finalRedirect.searchParams.get("state")).toBe("downstream-state-xyz");
    expect(finalRedirect.searchParams.get("code")).toBeTruthy();

    // pkce 紀錄用過即刪；且真的有簽發一筆新的 nycu_token（grantId 是隨機產生的，
    // 所以用前後差集找出新 key，而不是猜測確切的字串）。
    expect(await env.OAUTH_KV.get(`pkce:${stateId}`)).toBeNull();
    const tokenKeysAfter = (await env.OAUTH_KV.list({ prefix: "nycu_token:" })).keys.map((k) => k.name);
    const newTokenKeys = tokenKeysAfter.filter((name) => !tokenKeysBefore.has(name));
    expect(newTokenKeys).toHaveLength(1);
    const tokenRecord = JSON.parse((await env.OAUTH_KV.get(newTokenKeys[0]))!);
    expect(tokenRecord.access_token).toBe("nycu-access-token");
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
