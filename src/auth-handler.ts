interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: any; // 由 @cloudflare/workers-oauth-provider 自動注入
}

const ISSUER = "https://mcp.lib.nycu.edu.tw";
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REGISTER_URL = `${ISSUER}/oauth/register`;
/** RFC 8707 resource indicator：MCP 授權規範要求 client 在 authorize 跟 token 請求都帶上目標 MCP server 的網址。
 *  upstream 目前不帶也照樣簽出 aud 為這個網址的 token（2026-10-08 實測，SPEC §7.1），帶上是為了符合規範，
 *  避免 upstream 之後開始強制要求時，初次登入跟 reauth 都在使用者登入後才失敗。 */
const RESOURCE = `${ISSUER}/mcp`;

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64url(verifierBytes.buffer);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = base64url(digest);
  return { codeVerifier, codeChallenge };
}

async function ensureClientId(env: Env, redirectUri: string): Promise<string> {
  const cached = await env.OAUTH_KV.get("nycu_dcr_client_id");
  if (cached) return cached;

  const resp = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "NYCU Library MCP Wrapper",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!resp.ok) throw new Error(`DCR failed: ${await resp.text()}`);
  const data: any = await resp.json();
  await env.OAUTH_KV.put("nycu_dcr_client_id", data.client_id);
  return data.client_id;
}

/** KV 的 expirationTtl 最小值是 60 秒。 */
const KV_MIN_TTL_SECONDS = 60;

/**
 * 寫入 nycu_token:<grantId>，KV TTL 跟 upstream token 的 expires_in 一致（目前是 259200 秒 = 3 天），
 * 過期後由 KV 自動清掉，不會在 KV 裡越積越多。KV 裡找不到 token 時 search/fetch 一樣回傳
 * 「請呼叫 reauth」，跟拿過期 token 去打 upstream 收到 401 的結果相同。
 * upstream 沒給 expires_in 時不設 TTL（維持舊行為）。
 */
async function putNycuToken(env: Env, grantId: string, nycuToken: any): Promise<void> {
  const expiresIn = Number(nycuToken?.expires_in);
  const options = Number.isFinite(expiresIn) && expiresIn > 0
    ? { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.floor(expiresIn)) }
    : undefined;
  await env.OAUTH_KV.put(
    `nycu_token:${grantId}`,
    JSON.stringify({ ...nycuToken, obtained_at: Date.now() }),
    options
  );
}

/**
 * 統一產生「導去 NYCU 登入」的重新導向 Response。
 * mode === "initial"：第一次完成 downstream OAuth 授權用。
 * mode === "reauth"：既有 grantId 的 upstream token 過期後，重新登入用（不會建立新的 downstream grant）。
 */
async function redirectToNycuLogin(
  env: Env,
  redirectUri: string,
  pkceRecord: Record<string, any>
): Promise<Response> {
  const clientId = await ensureClientId(env, redirectUri);
  const { codeVerifier, codeChallenge } = await pkcePair();

  const stateId = crypto.randomUUID();
  await env.OAUTH_KV.put(
    `pkce:${stateId}`,
    JSON.stringify({ codeVerifier, ...pkceRecord }),
    { expirationTtl: 600 }
  );

  const target = new URL(AUTHORIZE_URL);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", clientId);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("state", stateId);
  target.searchParams.set("code_challenge", codeChallenge);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("resource", RESOURCE);
  return Response.redirect(target.toString(), 302);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/callback`;

    // -----------------------------------------------------------------
    // /authorize：downstream client（AI workspace）第一次要求授權
    // -----------------------------------------------------------------
    if (url.pathname === "/authorize") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return redirectToNycuLogin(env, redirectUri, {
        mode: "initial",
        oauthReqInfo,
      });
    }

    // -----------------------------------------------------------------
    // /reauth/:nonce：既有 grantId 的 upstream token 過期，使用者點擊
    // reauth 工具回傳的一次性連結後，會先進到這裡，再被導去 NYCU 登入
    // -----------------------------------------------------------------
    if (url.pathname.startsWith("/reauth/")) {
      const nonce = url.pathname.slice("/reauth/".length);
      const nonceKey = `reauth_nonce:${nonce}`;
      const record = await env.OAUTH_KV.get(nonceKey);

      if (!record) {
        return new Response(
          "此連結已失效或已使用過，請回到聊天視窗重新呼叫 reauth 取得新的連結。",
          { status: 400 }
        );
      }

      // 單次有效：驗證後立刻刪除
      await env.OAUTH_KV.delete(nonceKey);

      const { grantId } = JSON.parse(record);
      return redirectToNycuLogin(env, redirectUri, {
        mode: "reauth",
        grantId,
      });
    }

    // -----------------------------------------------------------------
    // /callback：NYCU 登入完成後的 redirect_uri。
    // 依 pkce 記錄的 mode 分流：initial 走完整 downstream 授權完成流程，
    // reauth 只更新既有 grantId 對應的 nycu_token，不建立新的 downstream grant。
    // -----------------------------------------------------------------
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const stateId = url.searchParams.get("state");
      if (!code || !stateId) {
        return new Response("Missing code/state", { status: 400 });
      }

      const stashed = await env.OAUTH_KV.get(`pkce:${stateId}`);
      if (!stashed) {
        return new Response("State expired or invalid", { status: 400 });
      }
      const parsed = JSON.parse(stashed);
      const { codeVerifier, mode } = parsed;

      const clientId = await env.OAUTH_KV.get("nycu_dcr_client_id");
      const tokenResp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId!,
          code_verifier: codeVerifier,
          resource: RESOURCE,
        }),
      });
      if (!tokenResp.ok) {
        return new Response(
          `Token exchange failed: ${await tokenResp.text()}`,
          { status: 502 }
        );
      }

      const nycuToken: any = await tokenResp.json();
      await env.OAUTH_KV.delete(`pkce:${stateId}`);

      if (mode === "reauth") {
        const { grantId } = parsed;
        await putNycuToken(env, grantId, nycuToken);
        // 舊的 upstream session 是綁在舊 token 上取得的，一併清掉，
        // 讓下一次 search/fetch 強制重新對上游 initialize。
        await env.OAUTH_KV.delete(`session:${grantId}`);

        return new Response(
          "重新授權成功！請回到原本的聊天視窗，重新送出剛才的查詢。",
          {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        );
      }

      // mode === "initial"（或缺省，向後相容舊資料）
      const { oauthReqInfo } = parsed;
      const grantId = crypto.randomUUID();
      await putNycuToken(env, grantId, nycuToken);

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: grantId,
        metadata: { label: "NYCU Library" },
        scope: oauthReqInfo.scope,
        props: { grantId },
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("Not found", { status: 404 });
  },
};
