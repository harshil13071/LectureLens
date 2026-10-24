export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  datePublished?: string;
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 429 | 502 | 503 | 504,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

function readRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(1, Math.ceil((date - Date.now()) / 1000));
}

export async function searchWeb(query: string, maxResults = 6): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new WebSearchError("Enter a research question to search the web.", 400, "INVALID_QUERY");
  }

  const apiKey = process.env.LANGSEARCH_API_KEY;
  if (!apiKey) {
    throw new WebSearchError(
      "Web research is not configured. Set LANGSEARCH_API_KEY as a server-side environment variable.",
      503,
      "SEARCH_NOT_CONFIGURED",
    );
  }

  let response: Response;
  try {
    response = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: trimmed,
        count: Math.max(1, Math.min(10, Math.floor(maxResults))),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new WebSearchError("Web search timed out. Please try again.", 504, "SEARCH_TIMEOUT");
    }
    throw new WebSearchError("Web search is temporarily unavailable. Please try again.", 502, "SEARCH_UNAVAILABLE");
  }

  if (!response.ok) {
    const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
    const isAuthError = response.status === 401 || response.status === 403;
    throw new WebSearchError(
      response.status === 429
        ? "The web search service is rate-limited. Please wait before trying again."
        : isAuthError
          ? "The web search service rejected its server credentials. Check LANGSEARCH_API_KEY in Render."
          : response.status === 400
            ? "The web search service rejected the request. Check the query and search settings."
            : response.status === 504
              ? "The web search service timed out. Please try again."
              : "The web search service could not complete this request.",
      response.status === 429 ? 429 : isAuthError ? 503 : response.status === 504 ? 504 : 502,
      response.status === 429 ? "SEARCH_RATE_LIMITED" : isAuthError ? "SEARCH_AUTH_FAILED" : response.status === 400 ? "SEARCH_INVALID_REQUEST" : response.status === 504 ? "SEARCH_TIMEOUT" : "SEARCH_PROVIDER_ERROR",
      retryAfterSeconds,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WebSearchError("The web search service returned an unreadable response.", 502, "SEARCH_INVALID_RESPONSE");
  }

  if (!payload || typeof payload !== "object") {
    throw new WebSearchError("The web search service returned an invalid response.", 502, "SEARCH_INVALID_RESPONSE");
  }

  const body = payload as {
    code?: unknown;
    message?: unknown;
    msg?: unknown;
    data?: { webPages?: { value?: unknown } };
  };

  if (body.code === undefined) {
    throw new WebSearchError("The web search service returned an incomplete response.", 502, "SEARCH_INVALID_RESPONSE");
  }
  if (String(body.code) !== "200") {
    const code = String(body.code);
    const providerMessage = typeof body.message === "string" ? body.message : typeof body.msg === "string" ? body.msg : undefined;
    throw new WebSearchError(
      code === "429"
        ? "The web search service is rate-limited. Please wait before trying again."
        : providerMessage?.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300) || "The search provider reported an error.",
      code === "429" ? 429 : 502,
      code === "429" ? "SEARCH_RATE_LIMITED" : "SEARCH_PROVIDER_ERROR",
      code === "429" ? readRetryAfter(response) : undefined,
    );
  }

  const rawResults = body.data?.webPages?.value;
  if (!Array.isArray(rawResults)) {
    throw new WebSearchError("The web search service returned an invalid results list.", 502, "SEARCH_INVALID_RESPONSE");
  }

  const results: WebSearchResult[] = rawResults
    .slice(0, Math.max(1, Math.min(10, Math.floor(maxResults))))
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const result = item as {
        name?: unknown;
        url?: unknown;
        snippet?: unknown;
        text?: unknown;
        datePublished?: unknown;
      };
      if (typeof result.name !== "string" || !result.name.trim() || typeof result.url !== "string") return [];

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(result.url);
      } catch {
        return [];
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) return [];

      const snippet = typeof result.snippet === "string"
        ? result.snippet
        : typeof result.text === "string"
          ? result.text
          : "";

      return [{
        title: result.name.trim().slice(0, 300),
        url: parsedUrl.toString(),
        snippet: snippet.slice(0, 2000),
        ...(typeof result.datePublished === "string"
          ? { datePublished: result.datePublished.slice(0, 100) }
          : {}),
      }];
    });

  if (!results.length) {
    throw new WebSearchError("No usable web results were found. Try a more specific research question.", 502, "SEARCH_NO_RESULTS");
  }

  return results;
}
