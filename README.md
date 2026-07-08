# vault-mcp

**The access layer of a self-organizing second brain.** A self-hostable remote HTTP MCP server that connects Claude (web, mobile, and desktop) to a living Obsidian knowledge graph — with full read/write access, from any device.

![Vault graph view — 1,500+ interconnected notes](src/Screenshot%202026-07-08%20at%2012.01.24.png)

## The system behind it

This server is one piece of a larger experiment I've been running for six months: a knowledge base that observes how I work and turns repetition into automation.

- **Observers** on my Mac (git observer, session logger, vault tracker) feed the vault continuously
- Recurring workflows mature through five stages — *trace → path → trail → reflex → muscle memory*. A workflow seen 3 times becomes a proposed "trail"; at stage 5 it becomes a deterministic script that **spends zero tokens**
- Unused trails decay like synapses: confidence drops 5% per idle month, rises 8% per use. The system forgets what I stopped needing
- The payoff is **cost optimization through reuse**: when I ask for an admin panel in a new project, the system scans my past implementations and pulls the proven base — Claude spends tokens only on what's genuinely new

![Admin panel patterns hub — one note connecting NextAuth config, audit logging, media uploader and the admin-panel-kur trail across projects](src/Screenshot%202026-07-08%20at%2012.07.04.png)

vault-mcp is what makes this brain reachable from Claude anywhere: the phone, the browser, the desktop. It's also the part most useful to others as-is, because remote MCP servers with proper OAuth are still rare. The observer scripts and trail tooling are next in line to be open-sourced.

## What's in this repo

A complete, production-style **remote** MCP server with the parts people actually struggle with:

- **OAuth 2.1** with Dynamic Client Registration (RFC 7591) + PKCE (S256) — works as a Claude.ai custom connector on web and mobile
- **Static Bearer** mode — for Claude Desktop via `mcp-remote`, or plain API testing
- **Streamable HTTP** transport, session-based
- Single Dockerfile, deploys in minutes on Coolify or any Docker host

Both auth modes run side by side on the same server.

## Tools

| Tool | Description |
|---|---|
| `vault_search` | Full-text search across the vault (GitHub code search) |
| `note_read` | Return a note's content |
| `note_write` | Create or overwrite a note |
| `note_append` | Append to an existing note |
| `list_notes` | List files in a folder |
| `get_tags` | Filter notes by frontmatter / inline tags |

## Quick start (local)

```bash
cp .env.example .env
# Fill in .env — minimum: GITHUB_TOKEN + (MCP_BEARER_TOKEN or OWNER_PASSWORD+PUBLIC_URL)
npm install
npm run dev
curl http://localhost:3000/health
```

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: http://localhost:3000/mcp
# Header: Authorization: Bearer <MCP_BEARER_TOKEN>
```

## Configuration

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT with contents read/write on your vault repo |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | The repo that holds your Obsidian vault |
| `MCP_BEARER_TOKEN` | Enables static bearer mode — `openssl rand -hex 32` |
| `PUBLIC_URL` | Public HTTPS URL of the server (required for OAuth) |
| `OWNER_PASSWORD` | Master password for the OAuth consent screen — `openssl rand -base64 24` (you'll type it on your phone, keep it manageable) |
| `PORT` | Default `3000` |

Leave `MCP_BEARER_TOKEN` or the OAuth variables empty to disable that mode.

## Deploy — Coolify (or any Docker host)

1. Coolify panel → **+ New Resource** → **Public/Private Git Repository**
2. Repo: your fork/clone of `vault-mcp`
3. Build pack: **Dockerfile**
4. Set the **environment variables** above (use Coolify's secret fields for tokens)
5. **Domains**: e.g. `mcp.yourdomain.com` → automatic Let's Encrypt
6. Deploy → verify with `curl https://mcp.yourdomain.com/health`

## Connect from Claude.ai (web / mobile) — OAuth

1. Claude.ai → **Settings** → **Connectors** → **Add custom connector**
2. URL: `https://mcp.yourdomain.com/mcp`
3. Claude automatically fetches `/.well-known/oauth-authorization-server`, registers itself via `/register` (DCR), and opens the `/authorize` consent screen
4. Enter your master password → **Approve**
5. Claude exchanges the code at `/token` (PKCE) and attaches the access token (1h TTL) to `/mcp` calls
6. The tools appear in your conversations

## Connect from Claude Desktop — Static Bearer

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vault": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.yourdomain.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
      ]
    }
  }
}
```

## Architecture

- **Transport**: Streamable HTTP (`/mcp`), session-based
- **Storage**: in-memory client/code/token store. Fine for a single instance; add a Redis adapter for multi-instance deploys
- **Token TTL**: access 1 hour, refresh unlimited (restart the server to revoke)
- **PKCE**: S256 required (per MCP spec)
- **DCR**: open — Claude.ai registers dynamically, no manual client setup

## Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | none | health + active auth modes |
| `/mcp` | POST | Bearer | MCP JSON-RPC |
| `/.well-known/oauth-authorization-server` | GET | none | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource` | GET | none | RFC 9728 metadata |
| `/register` | POST | none | RFC 7591 Dynamic Client Registration |
| `/authorize` | GET/POST | password | consent form |
| `/token` | POST | PKCE | code → access_token |

## Security notes

- Static bearer and OAuth run on the same server — leave the unused mode's env vars empty to disable it
- Never log `OWNER_PASSWORD`; use your platform's secret fields
- HTTPS is mandatory — Claude.ai rejects HTTP redirects
- Token rotation: generate a new `MCP_BEARER_TOKEN` + restart. OAuth tokens already expire after 1 hour

## Roadmap

- [ ] Conflict handling (ETag/sha mismatch retry)
- [ ] Persistent token store (SQLite) so restarts don't force re-auth
- [ ] Structured logging (pino) + request IDs
- [ ] Rate limiting
- [ ] Test suite
- [ ] Extract the OAuth 2.1 (DCR + PKCE) layer into a standalone reusable module
- [ ] Open-source the rest of the second brain: observer scripts, trail maturity model, confidence decay tooling

## License

MIT
