interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: any; // 由 @cloudflare/workers-oauth-provider 自動注入
}

const ISSUER = "https://mcp.lib.nycu.edu.tw";
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REGISTER_URL = `${ISSUER}/oauth/register`;

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64url(verifierBytes.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/callback`;

    if (url.pathname === "/authorize") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const clientId = await ensureClientId(env, redirectUri);
      const { codeVerifier, codeChallenge } = await pkcePair();

      const stateId = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `pkce:${stateId}`,
        JSON.stringify({ codeVerifier, oauthReqInfo }),
        { expirationTtl: 600 }
      );

      const target = new URL(AUTHORIZE_URL);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("client_id", clientId);
      target.searchParams.set("redirect_uri", redirectUri);
      target.searchParams.set("state", stateId);
      target.searchParams.set("code_challenge", codeChallenge);
      target.searchParams.set("code_challenge_method", "S256");
      return Response.redirect(target.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const stateId = url.searchParams.get("state");
      if (!code || !stateId) return new Response("Missing code/state", { status: 400 });

      const stashed = await env.OAUTH_KV.get(`pkce:${stateId}`);
      if (!stashed) return new Response("State expired or invalid", { status: 400 });
      const { codeVerifier, oauthReqInfo } = JSON.parse(stashed);

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
        }),
      });
      if (!tokenResp.ok) return new Response(`Token exchange failed: ${await tokenResp.text()}`, { status: 502 });

      const nycuToken: any = await tokenResp.json();
      await env.OAUTH_KV.delete(`pkce:${stateId}`);

      const grantId = crypto.randomUUID();
      await env.OAUTH_KV.put(`nycu_token:${grantId}`, JSON.stringify({ ...nycuToken, obtained_at: Date.now() }));

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
