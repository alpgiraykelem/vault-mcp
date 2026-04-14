import { Octokit } from "@octokit/rest";
import matter from "gray-matter";

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = "main",
  COMMIT_AUTHOR_NAME = "Claude MCP",
  COMMIT_AUTHOR_EMAIL = "claude-mcp@users.noreply.github.com",
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  throw new Error("GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO env zorunlu");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const owner = GITHUB_OWNER;
const repo = GITHUB_REPO;
const branch = GITHUB_BRANCH;
const author = { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL };

export type NoteHit = {
  path: string;
  name: string;
  score?: number;
  snippet?: string;
  tags?: string[];
};

function normalizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\\/g, "/");
}

export async function readNote(path: string): Promise<{ path: string; content: string; sha: string }> {
  const normalized = normalizePath(path);
  const res = await octokit.repos.getContent({ owner, repo, path: normalized, ref: branch });
  const data = res.data;
  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`${normalized} bir dosya değil`);
  }
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { path: normalized, content, sha: data.sha };
}

export async function writeNote(
  path: string,
  content: string,
  message?: string,
): Promise<{ path: string; sha: string; url: string; created: boolean }> {
  const normalized = normalizePath(path);
  let existingSha: string | undefined;
  let created = true;

  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: normalized, ref: branch });
    if (!Array.isArray(existing.data) && existing.data.type === "file") {
      existingSha = existing.data.sha;
      created = false;
    }
  } catch (err: any) {
    if (err.status !== 404) throw err;
  }

  const res = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: normalized,
    message: message ?? `${created ? "add" : "update"}: ${normalized}`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
    sha: existingSha,
    author,
    committer: author,
  });

  return {
    path: normalized,
    sha: res.data.content?.sha ?? "",
    url: res.data.content?.html_url ?? "",
    created,
  };
}

export async function appendNote(
  path: string,
  appendContent: string,
  message?: string,
): Promise<{ path: string; sha: string; url: string }> {
  const normalized = normalizePath(path);
  const { content } = await readNote(normalized);
  const separator = content.endsWith("\n") ? "" : "\n";
  const next = `${content}${separator}${appendContent}${appendContent.endsWith("\n") ? "" : "\n"}`;
  const result = await writeNote(normalized, next, message ?? `append: ${normalized}`);
  return { path: result.path, sha: result.sha, url: result.url };
}

export async function listNotes(
  folder = "",
  extension = ".md",
): Promise<Array<{ path: string; name: string; type: "file" | "dir" }>> {
  const normalized = normalizePath(folder);
  const res = await octokit.repos.getContent({ owner, repo, path: normalized, ref: branch });
  if (!Array.isArray(res.data)) {
    throw new Error(`${normalized} bir klasör değil`);
  }
  return res.data
    .filter((item) => item.type === "dir" || (item.type === "file" && item.name.endsWith(extension)))
    .map((item) => ({
      path: item.path,
      name: item.name,
      type: item.type as "file" | "dir",
    }));
}

export async function searchVault(
  query: string,
  limit = 20,
): Promise<NoteHit[]> {
  const q = `${query} repo:${owner}/${repo} extension:md`;
  const res = await octokit.search.code({ q, per_page: Math.min(limit, 100) });

  return res.data.items.slice(0, limit).map((item) => ({
    path: item.path,
    name: item.name,
    score: item.score,
    snippet: (item as any).text_matches?.[0]?.fragment,
  }));
}

export async function getTags(tags: string[], limit = 30): Promise<NoteHit[]> {
  if (tags.length === 0) throw new Error("En az bir tag ver");
  const normalized = tags.map((t) => t.replace(/^#/, "").trim()).filter(Boolean);
  const parts = normalized.map((t) => `("tags: [${t}" OR "tags:${t}" OR "#${t}")`);
  const q = `${parts.join(" ")} repo:${owner}/${repo} extension:md`;
  const res = await octokit.search.code({ q, per_page: Math.min(limit, 100) });

  const hits: NoteHit[] = [];
  for (const item of res.data.items.slice(0, limit)) {
    try {
      const { content } = await readNote(item.path);
      const fm = matter(content);
      const noteTags = Array.isArray(fm.data.tags) ? fm.data.tags.map(String) : [];
      const matches = normalized.every((t) => noteTags.some((n) => n.toLowerCase() === t.toLowerCase())
        || content.toLowerCase().includes(`#${t.toLowerCase()}`));
      if (matches) {
        hits.push({
          path: item.path,
          name: item.name,
          tags: noteTags,
          score: item.score,
        });
      }
    } catch {
      // tek note frontmatter hatası diğerlerini bozmasın
    }
  }
  return hits;
}
