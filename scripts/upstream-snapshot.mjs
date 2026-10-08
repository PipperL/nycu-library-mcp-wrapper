#!/usr/bin/env node
// 擷取 upstream（mcp.lib.nycu.edu.tw）的工具定義快照，跟 repo 裡的基準快照比對，
// 用來判斷 upstream 從上次到現在有沒有改版。跟 Worker 一樣用 @modelcontextprotocol/client 連線，
// 協定協商方式跟線上完全相同。
//
// 用法（在 repo 根目錄，npm ci 之後）：
//   node scripts/upstream-snapshot.mjs login              # 向 upstream 做 DCR 註冊，印出登入連結
//   node scripts/upstream-snapshot.mjs token '<callback>' # 貼上登入後瀏覽器跳轉的完整網址，換 token
//   node scripts/upstream-snapshot.mjs diff               # 擷取目前狀態，跟 upstream/snapshot.json 比對
//   node scripts/upstream-snapshot.mjs capture            # 擷取目前狀態，覆寫 upstream/snapshot.json
//
// token 有效 3 天，期間內可以重複 diff／capture，不用重新登入。
// OAuth 狀態跟 token 存在 .upstream-oauth.json（已列入 .gitignore，權限 600），不要 commit。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const UPSTREAM = "https://mcp.lib.nycu.edu.tw";
const REDIRECT_URI = "http://127.0.0.1:8976/callback";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, ".upstream-oauth.json");
const SNAPSHOT_FILE = path.join(ROOT, "upstream", "snapshot.json");

const b64url = (buf) => buf.toString("base64url");
const readState = () => JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });

async function login() {
  const res = await fetch(`${UPSTREAM}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "nycu-library-mcp-wrapper upstream-snapshot",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  const { client_id } = await res.json();
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(16));
  writeState({ client_id, verifier, state });
  const url = new URL(`${UPSTREAM}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    resource: `${UPSTREAM}/mcp`,
  });
  console.log("用瀏覽器開這個連結登入，登入後頁面會顯示無法連線（正常），把網址列的完整網址交給 token 指令：\n");
  console.log(url.toString());
}

async function token(callbackUrl) {
  const s = readState();
  const cb = new URL(callbackUrl);
  if (cb.searchParams.get("state") !== s.state) throw new Error("state 不符，請重新 login");
  const res = await fetch(`${UPSTREAM}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: cb.searchParams.get("code"),
      redirect_uri: REDIRECT_URI,
      client_id: s.client_id,
      code_verifier: s.verifier,
      resource: `${UPSTREAM}/mcp`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const t = await res.json();
  writeState({ ...s, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 });
  console.log(`取得 token，有效到 ${new Date(Date.now() + t.expires_in * 1000).toISOString()}`);
}

async function capture() {
  const s = readState();
  if (!s.access_token || Date.now() > s.expires_at) throw new Error("沒有 token 或已過期，請先 login + token");
  const transport = new StreamableHTTPClientTransport(new URL(`${UPSTREAM}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${s.access_token}` } },
  });
  const client = new Client({ name: "nycu-library-mcp-wrapper-snapshot", version: "0" });
  await client.connect(transport);
  try {
    const listOrError = async (fn) => {
      try {
        return Object.values(await fn())[0];
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    };
    return {
      captured_at: new Date().toISOString(),
      protocolVersion: transport.protocolVersion ?? null,
      serverInfo: client.getServerVersion() ?? null,
      capabilities: client.getServerCapabilities() ?? null,
      instructions: client.getInstructions() ?? null,
      tools: (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name)),
      prompts: await listOrError(() => client.listPrompts()),
      resources: await listOrError(() => client.listResources()),
      resourceTemplates: await listOrError(() => client.listResourceTemplates()),
    };
  } finally {
    await client.close();
  }
}

// key 排序後再序列化，避免只是欄位順序不同就被當成變更
const stable = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x,
  );

function diff(base, cur) {
  const changes = [];
  for (const key of ["protocolVersion", "serverInfo", "capabilities", "instructions", "prompts", "resources", "resourceTemplates"]) {
    if (stable(base[key]) !== stable(cur[key])) changes.push(`${key} 變更：\n  舊：${stable(base[key])}\n  新：${stable(cur[key])}`);
  }
  const byName = (list) => new Map(list.map((t) => [t.name, t]));
  const b = byName(base.tools);
  const c = byName(cur.tools);
  for (const name of c.keys()) if (!b.has(name)) changes.push(`新增工具：${name}`);
  for (const name of b.keys()) if (!c.has(name)) changes.push(`移除工具：${name}`);
  for (const [name, t] of c) {
    const old = b.get(name);
    if (!old) continue;
    for (const field of new Set([...Object.keys(old), ...Object.keys(t)])) {
      if (stable(old[field]) !== stable(t[field])) {
        changes.push(`工具 ${name} 的 ${field} 變更：\n  舊：${stable(old[field])}\n  新：${stable(t[field])}`);
      }
    }
  }
  return changes;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "login") await login();
else if (cmd === "token") await token(arg);
else if (cmd === "capture") {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(await capture(), null, 2) + "\n");
  console.log(`已寫入 ${path.relative(ROOT, SNAPSHOT_FILE)}`);
} else if (cmd === "diff") {
  const base = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  const changes = diff(base, await capture());
  console.log(`基準快照：${base.captured_at}`);
  console.log(changes.length ? changes.join("\n\n") : "沒有變更。");
  process.exitCode = changes.length ? 1 : 0;
} else {
  console.error("用法：node scripts/upstream-snapshot.mjs login | token '<callback-url>' | capture | diff");
  process.exitCode = 2;
}
