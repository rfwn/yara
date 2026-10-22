// Live access to docs.liara.ir so answers cite the current documentation
// instead of whatever the model remembers.

const DOCS = "https://docs.liara.ir";
const SITEMAP_TTL = 6 * 60 * 60 * 1000;

let sitemap: { paths: string[]; at: number } | null = null;

async function getSitemap(): Promise<string[]> {
  if (sitemap && Date.now() - sitemap.at < SITEMAP_TTL) return sitemap.paths;
  const res = await fetch(`${DOCS}/sitemap.xml`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load docs sitemap (${res.status})`);
  const xml = await res.text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  sitemap = { paths, at: Date.now() };
  return paths;
}

/** Rank doc pages by how many query terms appear in their URL path. */
export async function searchDocs(query: string, limit = 12) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/^\.?net$/, "dotnet").replace(/^nextjs$|^next\.js$/, "nextjs").replace(/^node$/, "nodejs"));
  if (!terms.length) return [];
  const paths = await getSitemap();
  return paths
    .map((p) => {
      const segs = p.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (segs.includes(`/${t}/`)) score += 3;
        else if (segs.includes(t)) score += 1;
      }
      // Prefer shallower overview pages on ties.
      return { path: p, score: score - p.split("/").length * 0.01 };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => `${DOCS}${r.path}`);
}

function htmlToText(html: string) {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? html;
  let text = main
    .replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, "")
    .replace(/<pre[^>]*>/g, "\n```\n")
    .replace(/<\/pre>/g, "\n```\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|li|h\d|div|tr)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n\s*\n+/g, "\n");
  // The sidebar is rendered inside <main>; the article starts after the "copy link" button.
  const start = text.indexOf("کپی لینک");
  if (start !== -1) text = text.slice(start + "کپی لینک".length);
  // ...and the footer (search box + console link) follows it.
  const end = text.lastIndexOf("مستندات");
  if (end !== -1 && text.length - end < 200) text = text.slice(0, end);
  return text.replace(/کپی(?=\S)/g, "").trim();
}

export async function readDocsPage(urlOrPath: string, maxChars = 12000) {
  const url = new URL(urlOrPath, DOCS);
  if (url.hostname !== "docs.liara.ir") throw new Error("Only docs.liara.ir pages can be read.");
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Docs page ${url.pathname} returned ${res.status}`);
  const text = htmlToText(await res.text());
  return {
    url: url.toString(),
    content: text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text,
  };
}
