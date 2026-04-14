import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  readNote,
  writeNote,
  appendNote,
  listNotes,
  searchVault,
  getTags,
} from "./github.js";
import { buildOAuthRouter, verifyAccessToken } from "./oauth.js";

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_BEARER = process.env.MCP_BEARER_TOKEN;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!STATIC_BEARER && !(OWNER_PASSWORD && PUBLIC_URL)) {
  throw new Error(
    "En az bir auth modu gerekli: ya MCP_BEARER_TOKEN (static bearer) ya da OWNER_PASSWORD + PUBLIC_URL (OAuth)",
  );
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "vault-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "vault_search",
    {
      description:
        "Obsidian vault içinde tam-metin arama yapar. Başlık veya gövde içinde geçen kelimeleri arar. GitHub code search backend.",
      inputSchema: {
        query: z.string().min(1).describe("Aranacak metin"),
        limit: z.number().int().min(1).max(100).optional().describe("Maksimum sonuç sayısı (default 20)"),
      },
    },
    async ({ query, limit }) => {
      const hits = await searchVault(query, limit ?? 20);
      return {
        content: [
          {
            type: "text",
            text:
              hits.length === 0
                ? `"${query}" için sonuç yok.`
                : hits
                    .map((h) => `• ${h.path}${h.snippet ? `\n   ${h.snippet.replace(/\n/g, " ").slice(0, 200)}` : ""}`)
                    .join("\n"),
          },
        ],
        structuredContent: { hits },
      };
    },
  );

  server.registerTool(
    "note_read",
    {
      description:
        "Vault içinde belirli bir notun tam içeriğini döndürür. Path vault kökünden göreceli (örn: 'wiki/projects/backlog/Walktionary Todo.md').",
      inputSchema: {
        path: z.string().min(1).describe("Vault kökünden göreceli dosya yolu"),
      },
    },
    async ({ path }) => {
      const note = await readNote(path);
      return {
        content: [{ type: "text", text: note.content }],
        structuredContent: { path: note.path, content: note.content, sha: note.sha },
      };
    },
  );

  server.registerTool(
    "note_write",
    {
      description:
        "Yeni not oluşturur veya mevcut notu tamamen üzerine yazar. Commit GitHub'a otomatik push edilir. Mevcut dosyayı overwrite etmeden önce note_read ile içeriği okuman önerilir.",
      inputSchema: {
        path: z.string().min(1).describe("Hedef path, vault kökünden göreceli"),
        content: z.string().describe("Dosyanın tam içeriği (markdown)"),
        message: z.string().optional().describe("Commit mesajı (opsiyonel)"),
      },
    },
    async ({ path, content, message }) => {
      const result = await writeNote(path, content, message);
      return {
        content: [
          {
            type: "text",
            text: `${result.created ? "Oluşturuldu" : "Güncellendi"}: ${result.path}\nCommit: ${result.url}`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "note_append",
    {
      description:
        "Mevcut notun sonuna içerik ekler. Task, günlük log, hızlı not için idealdir. Dosya yoksa hata verir — yeni dosya için note_write kullan.",
      inputSchema: {
        path: z.string().min(1).describe("Mevcut dosyanın yolu"),
        content: z.string().min(1).describe("Eklenecek markdown içerik (başına otomatik newline konur)"),
        message: z.string().optional().describe("Commit mesajı (opsiyonel)"),
      },
    },
    async ({ path, content, message }) => {
      const result = await appendNote(path, content, message);
      return {
        content: [{ type: "text", text: `Eklendi: ${result.path}\nCommit: ${result.url}` }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_notes",
    {
      description: "Belirli bir klasördeki dosya/klasörleri listeler. Kök için path'i boş bırak.",
      inputSchema: {
        folder: z.string().optional().describe("Klasör yolu (default: vault kökü)"),
        extension: z.string().optional().describe("Filtre uzantısı (default: .md)"),
      },
    },
    async ({ folder, extension }) => {
      const items = await listNotes(folder ?? "", extension ?? ".md");
      return {
        content: [
          {
            type: "text",
            text: items.length === 0
              ? "Klasör boş."
              : items.map((i) => `${i.type === "dir" ? "📁" : "📄"} ${i.path}`).join("\n"),
          },
        ],
        structuredContent: { items },
      };
    },
  );

  server.registerTool(
    "get_tags",
    {
      description:
        "Verilen tag(ler)e sahip notları döndürür. YAML frontmatter (tags: [...]) ve inline #tag formatlarını destekler. Birden fazla tag verilirse AND mantığı uygulanır.",
      inputSchema: {
        tags: z.array(z.string()).min(1).describe("Aranacak tag listesi (# işareti olmadan)"),
        limit: z.number().int().min(1).max(100).optional().describe("Maksimum sonuç sayısı (default 30)"),
      },
    },
    async ({ tags, limit }) => {
      const hits = await getTags(tags, limit ?? 30);
      return {
        content: [
          {
            type: "text",
            text:
              hits.length === 0
                ? `Tag(ler) için sonuç yok: ${tags.join(", ")}`
                : hits.map((h) => `• ${h.path}${h.tags ? `  [${h.tags.join(", ")}]` : ""}`).join("\n"),
          },
        ],
        structuredContent: { hits },
      };
    },
  );

  return server;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    const base = PUBLIC_URL?.replace(/\/$/, "") ?? "";
    res.status(401)
      .setHeader(
        "WWW-Authenticate",
        base
          ? `Bearer realm="vault-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`
          : `Bearer realm="vault-mcp"`,
      )
      .json({ error: "unauthorized" });
    return;
  }
  const token = header.slice(7).trim();

  // 1) Static bearer (Claude Desktop / mcp-remote / internal testing)
  if (STATIC_BEARER && safeEqual(token, STATIC_BEARER)) {
    next();
    return;
  }

  // 2) OAuth access token (Claude.ai web/mobil)
  if (OWNER_PASSWORD && PUBLIC_URL && verifyAccessToken(token)) {
    next();
    return;
  }

  const base = PUBLIC_URL?.replace(/\/$/, "") ?? "";
  res.status(401)
    .setHeader(
      "WWW-Authenticate",
      base
        ? `Bearer realm="vault-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token"`
        : `Bearer realm="vault-mcp", error="invalid_token"`,
    )
    .json({ error: "invalid_token" });
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version"],
  }),
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "vault-mcp",
    version: "0.1.0",
    auth: {
      staticBearer: Boolean(STATIC_BEARER),
      oauth: Boolean(OWNER_PASSWORD && PUBLIC_URL),
    },
  });
});

// OAuth router (sadece config varsa)
if (OWNER_PASSWORD && PUBLIC_URL) {
  app.use(
    buildOAuthRouter({
      publicUrl: PUBLIC_URL,
      ownerPassword: OWNER_PASSWORD,
    }),
  );
}

const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", requireAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === "POST" && !sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ error: "Bad Request: session id yok ya da initialize değil" });
  } catch (err: any) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? "internal error" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`vault-mcp listening on :${PORT}`);
  console.log(`  static bearer: ${STATIC_BEARER ? "on" : "off"}`);
  console.log(`  oauth:         ${OWNER_PASSWORD && PUBLIC_URL ? `on (${PUBLIC_URL})` : "off"}`);
});
