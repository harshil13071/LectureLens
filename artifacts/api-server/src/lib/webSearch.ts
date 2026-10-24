export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(
  query: string,
  maxResults = 6,
): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Search query cannot be empty");
  }

  // 1. If Brave Search API key is provided, use Brave Search
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (braveApiKey) {
    try {
      const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(trimmed)}&count=${maxResults}`;
      const response = await fetch(braveUrl, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": braveApiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = (await response.json()) as {
          web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
        };
        const items = data.web?.results || [];
        if (items.length > 0) {
          return items.slice(0, maxResults).map((item) => ({
            title: item.title || "Source",
            url: item.url || "",
            snippet: item.description || "",
          }));
        }
      }
    } catch {
      // Fallback to DuckDuckGo
    }
  }

  // 2. Default & reliable live web search via DuckDuckGo HTML
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      throw new Error(`Web search provider returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const results: WebSearchResult[] = [];
    const blocks = html.split(/class=\"result\s/);

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const titleMatch = block.match(
        /<a[^>]+class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/,
      );
      const snippetMatch = block.match(
        /<a[^>]+class=\"result__snippet\"[^>]*>([\s\S]*?)<\/a>/,
      );

      if (titleMatch) {
        let href = titleMatch[1];
        const uddgMatch = href.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          try {
            href = decodeURIComponent(uddgMatch[1]);
          } catch {
            // Keep original if decoding fails
          }
        }

        if (href.startsWith("http://") || href.startsWith("https://")) {
          // Unescape HTML entities in title and snippet
          const title = titleMatch[2]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim();

          const snippet = snippetMatch
            ? snippetMatch[1]
                .replace(/<[^>]+>/g, "")
                .replace(/&amp;/g, "&")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .trim()
            : "";

          if (title && href) {
            results.push({ title, url: href, snippet });
          }
        }
      }

      if (results.length >= maxResults) break;
    }

    if (results.length === 0) {
      throw new Error(
        `No web search results found for "${trimmed}". Please try a more specific topic or rephrasing your search.`,
      );
    }

    return results;
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Web search could not be completed. Please try again shortly.");
  }
}
