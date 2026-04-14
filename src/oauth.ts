import type { Request, Response, NextFunction, RequestHandler, Router } from "express";
import express from "express";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
};

type AuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  expiresAt: number;
};

type AccessToken = {
  clientId: string;
  scope: string;
  expiresAt: number;
};

type RefreshToken = {
  clientId: string;
  scope: string;
};

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();
const refreshTokens = new Map<string, RefreshToken>();

const TOKEN_TTL_SEC = 60 * 60; // 1 saat
const CODE_TTL_MS = 10 * 60 * 1000; // 10 dakika

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function now(): number {
  return Date.now();
}

function cleanupExpired(): void {
  const ts = now();
  for (const [code, rec] of authCodes) if (rec.expiresAt < ts) authCodes.delete(code);
  for (const [tok, rec] of accessTokens) if (rec.expiresAt < ts) accessTokens.delete(tok);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type OAuthConfig = {
  publicUrl: string;
  ownerPassword: string;
  issuerName?: string;
};

export function verifyAccessToken(token: string): AccessToken | null {
  cleanupExpired();
  const rec = accessTokens.get(token);
  if (!rec) return null;
  if (rec.expiresAt < now()) {
    accessTokens.delete(token);
    return null;
  }
  return rec;
}

export function requireOAuthBearer(resourceUrl: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401)
        .setHeader(
          "WWW-Authenticate",
          `Bearer realm="vault-mcp", resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource"`,
        )
        .json({ error: "unauthorized", error_description: "Bearer token gerekli" });
      return;
    }
    const token = header.slice(7).trim();
    const rec = verifyAccessToken(token);
    if (!rec) {
      res.status(401)
        .setHeader(
          "WWW-Authenticate",
          `Bearer realm="vault-mcp", resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
        )
        .json({ error: "invalid_token" });
      return;
    }
    (req as Request & { auth?: AccessToken }).auth = rec;
    next();
  };
}

export function buildOAuthRouter(config: OAuthConfig): Router {
  const { publicUrl, ownerPassword } = config;
  const base = publicUrl.replace(/\/$/, "");
  const router = express.Router();

  // RFC 9728: Protected Resource Metadata — MCP spec bu endpoint'i ister
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ["vault.read", "vault.write"],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414: Authorization Server Metadata
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["vault.read", "vault.write"],
    });
  });

  // RFC 7591: Dynamic Client Registration
  router.post("/register", express.json(), (req, res) => {
    const body = req.body ?? {};
    const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris zorunlu" });
      return;
    }
    for (const uri of redirectUris) {
      try {
        const u = new URL(uri);
        if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
          res.status(400).json({ error: "invalid_redirect_uri", error_description: `https gerekli: ${uri}` });
          return;
        }
      } catch {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: `geçersiz uri: ${uri}` });
        return;
      }
    }

    const clientId = randomToken(16);
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      clientName: typeof body.client_name === "string" ? body.client_name : undefined,
      createdAt: now(),
    };
    clients.set(clientId, client);

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: redirectUris,
      client_name: client.clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // Authorize — GET: onay formu
  router.get("/authorize", (req, res) => {
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const state = req.query.state ? String(req.query.state) : "";
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "");
    const responseType = String(req.query.response_type ?? "");
    const scope = req.query.scope ? String(req.query.scope) : "vault.read vault.write";

    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) {
      res.status(400).send("invalid client_id veya redirect_uri");
      return;
    }
    if (responseType !== "code") {
      res.status(400).send("response_type=code zorunlu");
      return;
    }
    if (codeChallengeMethod !== "S256" || !codeChallenge) {
      res.status(400).send("PKCE S256 zorunlu");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><title>Vault MCP — Yetkilendirme</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:440px;margin:48px auto;padding:24px;color:#111}
  h1{font-size:20px;margin:0 0 8px}
  p{color:#555;line-height:1.5;margin:0 0 24px}
  .client{background:#f5f5f5;padding:12px;border-radius:8px;margin-bottom:16px;font-size:13px;word-break:break-all}
  label{display:block;font-size:13px;margin-bottom:6px;color:#333}
  input[type=password]{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box}
  button{width:100%;margin-top:16px;padding:12px;background:#111;color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer}
  button:hover{background:#333}
</style></head><body>
<h1>Vault'a erişim onayı</h1>
<p><strong>${escapeHtml(client.clientName ?? "Bilinmeyen uygulama")}</strong> ikinci beynine okuma/yazma erişimi istiyor.</p>
<div class="client">client_id: ${escapeHtml(clientId)}<br>redirect: ${escapeHtml(redirectUri)}</div>
<form method="POST" action="/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
  <input type="hidden" name="scope" value="${escapeHtml(scope)}">
  <label for="pw">Master password</label>
  <input id="pw" name="password" type="password" autofocus autocomplete="off" required>
  <button type="submit">Onayla ve devam et</button>
</form>
</body></html>`);
  });

  // Authorize — POST: password check + code üret
  router.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body as Record<string, string>;
    const clientId = body.client_id ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const state = body.state ?? "";
    const codeChallenge = body.code_challenge ?? "";
    const scope = body.scope ?? "vault.read vault.write";
    const password = body.password ?? "";

    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri) || !codeChallenge) {
      res.status(400).send("invalid request");
      return;
    }
    if (!safeEqual(password, ownerPassword)) {
      res.status(401).send("yanlış password — geri dönüp tekrar dene");
      return;
    }

    const code = randomToken(32);
    authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
      scope,
      expiresAt: now() + CODE_TTL_MS,
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.redirect(target.toString());
  });

  // Token endpoint
  router.post("/token", express.urlencoded({ extended: false }), (req, res) => {
    cleanupExpired();
    const body = req.body as Record<string, string>;
    const grantType = body.grant_type ?? "";

    if (grantType === "authorization_code") {
      const code = body.code ?? "";
      const clientId = body.client_id ?? "";
      const redirectUri = body.redirect_uri ?? "";
      const codeVerifier = body.code_verifier ?? "";

      const rec = authCodes.get(code);
      if (!rec) {
        res.status(400).json({ error: "invalid_grant", error_description: "code geçersiz veya kullanılmış" });
        return;
      }
      authCodes.delete(code);
      if (rec.expiresAt < now() || rec.clientId !== clientId || rec.redirectUri !== redirectUri) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (sha256Base64Url(codeVerifier) !== rec.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE doğrulama başarısız" });
        return;
      }

      const accessToken = randomToken(32);
      const refreshToken = randomToken(32);
      accessTokens.set(accessToken, {
        clientId,
        scope: rec.scope,
        expiresAt: now() + TOKEN_TTL_SEC * 1000,
      });
      refreshTokens.set(refreshToken, { clientId, scope: rec.scope });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SEC,
        refresh_token: refreshToken,
        scope: rec.scope,
      });
      return;
    }

    if (grantType === "refresh_token") {
      const rt = body.refresh_token ?? "";
      const clientId = body.client_id ?? "";
      const rec = refreshTokens.get(rt);
      if (!rec || rec.clientId !== clientId) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const accessToken = randomToken(32);
      accessTokens.set(accessToken, {
        clientId,
        scope: rec.scope,
        expiresAt: now() + TOKEN_TTL_SEC * 1000,
      });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SEC,
        scope: rec.scope,
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}
