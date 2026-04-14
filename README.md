# vault-mcp

Obsidian vault'una (`alpgiraykelem/projects-wiki` GitHub reposu) Claude.ai üzerinden erişim sağlayan **Remote HTTP MCP Server**.

İki auth modu birlikte çalışır:
- **Static Bearer** — Claude Desktop / `mcp-remote` / API testleri için
- **OAuth 2.1** (DCR + PKCE) — Claude.ai web + mobil custom connector için

## Tools

| Tool | Açıklama |
|---|---|
| `vault_search` | Tam-metin arama (GitHub code search) |
| `note_read` | Not içeriğini döndürür |
| `note_write` | Not oluşturur veya overwrite eder |
| `note_append` | Mevcut notun sonuna ekler |
| `list_notes` | Klasördeki dosyaları listeler |
| `get_tags` | Frontmatter / inline tag filtresi |

## Yerel Geliştirme

```bash
cp .env.example .env
# .env'i doldur — minimum: GITHUB_TOKEN + (MCP_BEARER_TOKEN veya OWNER_PASSWORD+PUBLIC_URL)
npm install
npm run dev
curl http://localhost:3000/health
```

### MCP Inspector ile test
```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: http://localhost:3000/mcp
# Header: Authorization: Bearer <MCP_BEARER_TOKEN>
```

## Deploy — Coolify

1. Coolify panelinde **+ New Resource** → **Public/Private Git Repository**
2. Repo: `alpgiraykelem/vault-mcp` (private — SSH key veya GitHub App ile bağla)
3. Build pack: **Dockerfile**
4. **Environment Variables**:
   - `GITHUB_TOKEN`, `GITHUB_OWNER=alpgiraykelem`, `GITHUB_REPO=projects-wiki`, `GITHUB_BRANCH=main`
   - `MCP_BEARER_TOKEN` — `openssl rand -hex 32`
   - `PUBLIC_URL=https://mcp.alpgiraykelem.com` (Coolify'da bağlayacağın domain)
   - `OWNER_PASSWORD` — `openssl rand -base64 24` (telefonda yazılacağı için aşırı uzun olmasın)
   - `PORT=3000`
5. **Domains**: `mcp.alpgiraykelem.com` → Let's Encrypt otomatik
6. Deploy → `curl https://mcp.alpgiraykelem.com/health` ile doğrula

## Claude.ai web/mobil — Custom Connector ekleme

1. Claude.ai → **Settings** → **Connectors** → **Add custom connector**
2. URL: `https://mcp.alpgiraykelem.com/mcp`
3. Claude tarayıcı içinde otomatik olarak `/.well-known/oauth-authorization-server` çekecek, `/register` ile dynamic client register edecek, `/authorize` ekranını açacak
4. Master password'ünü gir → **Onayla**
5. Claude `/token` ile access token alır (1 saatlik) ve `/mcp` çağrılarına bearer olarak ekler
6. Tools artık konuşmada görünür

## Claude Desktop — Static Bearer modu

`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "vault": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.alpgiraykelem.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
      ]
    }
  }
}
```

## Mimari

- **Transport**: Streamable HTTP (`/mcp`), session-based
- **Storage**: in-memory client/code/token store. Tek instance için yeterli; multi-instance deploy yapacaksan Redis adapter ekle
- **Token TTL**: access 1 saat, refresh süresiz (manuel revoke için restart)
- **PKCE**: S256 zorunlu (MCP spec)
- **DCR**: açık — Claude.ai dynamic register yapar, manuel client kurmana gerek yok

## Endpoint listesi

| Endpoint | Method | Auth | Açıklama |
|---|---|---|---|
| `/health` | GET | yok | sağlık + auth modu |
| `/mcp` | POST | Bearer | MCP JSON-RPC |
| `/.well-known/oauth-authorization-server` | GET | yok | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource` | GET | yok | RFC 9728 metadata |
| `/register` | POST | yok | RFC 7591 DCR |
| `/authorize` | GET/POST | password | onay formu |
| `/token` | POST | PKCE | code → access_token |

## Güvenlik notları

- Static bearer ile OAuth aynı server'da koşar — birini kullanmıyorsan env'i boş bırak
- `OWNER_PASSWORD`'ü loglara yazma. Coolify "secret" alanına gir
- HTTPS zorunlu — Claude.ai HTTP redirect kabul etmez
- Token rotation: yeni `MCP_BEARER_TOKEN` üret + restart. OAuth tokenları zaten 1 saat TTL.

## TODO

- [ ] Conflict handling (ETag/sha mismatch retry)
- [ ] Persistent token store (SQLite) → restart sonrası kullanıcı re-auth gerektirmesin
- [ ] Structured log (pino) + request id
- [ ] Rate limit
- [ ] Test suite
