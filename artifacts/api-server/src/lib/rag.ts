export const RAG_EMBEDDING_DIMENSIONS = 1536;
export const RAG_MAX_CHUNK_CHARS = 1_600;
export const RAG_CHUNK_OVERLAP_CHARS = 220;
export const RAG_MAX_DOCUMENT_CHARS = 250_000;
export const RAG_MAX_CHUNKS = 180;
export const RAG_EMBEDDING_BATCH_SIZE = 24;

export type SourcePage = { pageNumber: number; text: string };
export type RagChunk = { text: string; pageNumber?: number; section?: string };

export class RagError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "RagError";
  }
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").trim();
}

function isHeading(line: string): boolean {
  const value = line.trim();
  if (!value || value.length > 120) return false;
  if (/^#{1,6}\s+\S/.test(value)) return true;
  const letters = value.match(/[\p{L}]/gu) ?? [];
  return letters.length >= 4 && letters.length <= 80 && value === value.toLocaleUpperCase() && value.split(/\s+/).length <= 12;
}

function splitParagraph(text: string, maxChars: number, overlapChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(maxChars * 0.65)) end = boundary;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    const nextStart = Math.max(start + 1, end - overlapChars);
    const nextBoundary = text.indexOf(" ", nextStart);
    start = nextBoundary >= 0 && nextBoundary < end ? nextBoundary + 1 : nextStart;
  }
  return chunks;
}

function chunkOneSource(text: string, pageNumber?: number): RagChunk[] {
  const lines = cleanText(text).split("\n");
  const result: RagChunk[] = [];
  let section: string | undefined;
  let body: string[] = [];
  const flush = () => {
    const content = body.join(" ").replace(/\s+/g, " ").trim();
    body = [];
    if (!content) return;
    for (const part of splitParagraph(content, RAG_MAX_CHUNK_CHARS, RAG_CHUNK_OVERLAP_CHARS)) {
      result.push({ text: part, ...(pageNumber ? { pageNumber } : {}), ...(section ? { section } : {}) });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (body.length && body.join(" ").length > RAG_MAX_CHUNK_CHARS) flush();
      continue;
    }
    if (isHeading(line)) {
      flush();
      section = line.replace(/^#{1,6}\s+/, "").slice(0, 200);
      continue;
    }
    body.push(line);
    if (body.join(" ").length >= RAG_MAX_CHUNK_CHARS) flush();
  }
  flush();
  return result;
}

export function chunkMaterial(text: string, pages?: SourcePage[]): RagChunk[] {
  const sources = pages?.length ? pages : [{ pageNumber: 0, text }];
  return sources.flatMap((source) => chunkOneSource(source.text, source.pageNumber > 0 ? source.pageNumber : undefined));
}

export type EmbeddingOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
};

export async function embedTexts(texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
  if (!texts.length) return [];
  if (texts.length > RAG_EMBEDDING_BATCH_SIZE || texts.some((text) => !text.trim() || text.length > 8_000)) {
    throw new RagError("INVALID_EMBEDDING_BATCH", 400, "The embedding request is outside the supported size limits.");
  }
  const apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY;
  if (!apiKey) throw new RagError("EMBEDDING_NOT_CONFIGURED", 503, "Study library embeddings are not configured on the server.");
  const baseUrl = (options.baseUrl ?? process.env.EMBEDDING_API_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = options.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts, encoding_format: "float" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", 502, "The embedding service could not be reached. Please retry indexing.");
  }
  if (!response.ok) {
    throw new RagError(response.status === 429 ? "EMBEDDING_RATE_LIMITED" : "EMBEDDING_PROVIDER_ERROR", response.status === 429 ? 429 : 502,
      response.status === 429 ? "The embedding service is rate limited. Please retry shortly." : "The embedding service rejected the request.");
  }

  let payload: unknown;
  try { payload = await response.json(); } catch {
    throw new RagError("INVALID_EMBEDDING_RESPONSE", 502, "The embedding service returned an invalid response.");
  }
  const data = payload && typeof payload === "object" && "data" in payload ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new RagError("INVALID_EMBEDDING_RESPONSE", 502, "The embedding service returned an invalid response.");
  }
  const ordered: number[][] = new Array(texts.length);
  for (const item of data) {
    if (!item || typeof item !== "object") throw new RagError("INVALID_EMBEDDING_RESPONSE", 502, "The embedding service returned an invalid response.");
    const index = (item as { index?: unknown }).index;
    const vector = (item as { embedding?: unknown }).embedding;
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= texts.length || !Array.isArray(vector) || vector.length !== RAG_EMBEDDING_DIMENSIONS || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new RagError("INVALID_EMBEDDING_RESPONSE", 502, "The embedding service returned an invalid vector. Check the configured model dimensions.");
    }
    ordered[Number(index)] = vector as number[];
  }
  if (ordered.some((vector) => !vector)) throw new RagError("INVALID_EMBEDDING_RESPONSE", 502, "The embedding service returned an incomplete response.");
  return ordered;
}

export function toPgVector(vector: number[]): string {
  if (vector.length !== RAG_EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new RagError("INVALID_VECTOR", 400, "The embedding vector has an invalid shape.");
  }
  return `[${vector.join(",")}]`;
}

export function quoteMatchesChunk(quote: string, chunk: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return quote.length > 0 && normalize(chunk).includes(normalize(quote));
}
