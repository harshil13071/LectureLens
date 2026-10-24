import { createHash } from "node:crypto";

export interface RateLimitMetadata {
  remainingTokens?: number;
  remainingRequests?: number;
  resetTokens?: string;
  resetRequests?: string;
  retryAfterSeconds?: number;
}

export interface TokenUsageMetadata {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiDiagnostics {
  durationMs: number;
  providerStatus: number;
  tokens?: TokenUsageMetadata;
  rateLimit?: RateLimitMetadata;
  cached?: boolean;
}

export interface RequestLectureLensOptions {
  maxTokens?: number;
  operation?: string;
  cacheKey?: string;
  timeoutMs?: number;
  onDiagnostics?: (diagnostics: AiDiagnostics) => void;
}

export class LectureLensAiError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502 | 503 | 504,
    readonly code: string,
    readonly providerStatus?: number,
    readonly providerMessage?: string,
    readonly durationMs?: number,
    readonly rateLimit?: RateLimitMetadata,
  ) {
    super(message);
    this.name = "LectureLensAiError";
  }
}

export function sanitizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-or-v1-|gsk_)[a-zA-Z0-9_-]+/gi, "[redacted]")
    .replace(/\b(?:api[_ -]?key|token|secret)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/https?:\/\/\S+/gi, "[provider URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return sanitized || undefined;
}

function extractRateLimitMetadata(headers: Headers, providerMessage?: string): RateLimitMetadata {
  const remainingTokens = headers.get("x-ratelimit-remaining-tokens");
  const remainingRequests = headers.get("x-ratelimit-remaining-requests");
  const resetTokens = headers.get("x-ratelimit-reset-tokens");
  const resetRequests = headers.get("x-ratelimit-reset-requests");
  const retryAfter = headers.get("retry-after");

  let retryAfterSeconds: number | undefined;
  if (retryAfter) {
    const parsed = parseInt(retryAfter, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      retryAfterSeconds = parsed;
    }
  }

  // Parse retry seconds from provider error message if header is missing
  if (retryAfterSeconds === undefined && providerMessage) {
    const match = providerMessage.match(/try again in ([0-9.]+)\s*s/i);
    if (match) {
      const parsedFloat = parseFloat(match[1]);
      if (!Number.isNaN(parsedFloat) && parsedFloat > 0) {
        retryAfterSeconds = Math.ceil(parsedFloat);
      }
    }
  }

  return {
    remainingTokens: remainingTokens ? parseInt(remainingTokens, 10) : undefined,
    remainingRequests: remainingRequests ? parseInt(remainingRequests, 10) : undefined,
    resetTokens: resetTokens || undefined,
    resetRequests: resetRequests || undefined,
    retryAfterSeconds,
  };
}

function readCompletionText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

export function extractJsonObject(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const slice = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // Fall through to error
      }
    }
    throw new LectureLensAiError(
      "The AI provider returned an invalid format. Please try again.",
      502,
      "AI_INVALID_FORMAT",
    );
  }
}

// In-memory LRU / TTL Cache
interface CacheRecord {
  data: unknown;
  diagnostics: AiDiagnostics;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheRecord>();
const inFlightRequests = new Map<string, Promise<{ data: unknown; diagnostics: AiDiagnostics }>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 100;

export function getAiCacheKey(operation: string, payload: unknown): string {
  const hash = createHash("sha256")
    .update(typeof payload === "string" ? payload : JSON.stringify(payload))
    .digest("hex");
  return `${operation}:${hash}`;
}

export function clearAiCache(): void {
  memoryCache.clear();
  inFlightRequests.clear();
}

async function executeGroqRequest(
  systemPrompt: string,
  userPrompt: string,
  conversation: Array<{ role: "user" | "assistant"; content: string }>,
  options?: RequestLectureLensOptions,
  attempt = 0,
): Promise<{ data: unknown; diagnostics: AiDiagnostics }> {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

  if (!apiKey) {
    throw new LectureLensAiError(
      "AI generation is not configured yet. Set GROQ_API_KEY as a server-side environment variable, then try again.",
      503,
      "AI_NOT_CONFIGURED",
    );
  }

  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 30_000;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...conversation.map(({ role, content }) => ({ role, content })),
    { role: "user", content: userPrompt },
  ];

  const requestBody: Record<string, unknown> = {
    model,
    temperature: 0.2,
    messages,
    response_format: { type: "json_object" },
  };

  if (options?.maxTokens) {
    requestBody.max_tokens = options.maxTokens;
  }

  // Set reasoning_format for gpt-oss models to avoid think tags polluting responses
  if (model.includes("gpt-oss")) {
    requestBody.reasoning_format = "parsed";
  }

  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) {
      throw new LectureLensAiError(
        `The AI request timed out after ${Math.round(timeoutMs / 1000)}s. Please try again.`,
        504,
        "AI_TIMEOUT",
        undefined,
        undefined,
        durationMs,
      );
    }
    throw new LectureLensAiError(
      "Could not reach the AI provider. Please try again shortly.",
      502,
      "AI_PROVIDER_UNAVAILABLE",
      undefined,
      undefined,
      durationMs,
    );
  }

  const durationMs = Date.now() - startTime;

  if (!response.ok) {
    let providerMessage: string | undefined;
    try {
      const body = await response.text();
      if (body) {
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            const providerError = (parsed as { error?: unknown }).error;
            if (typeof providerError === "string") {
              providerMessage = sanitizeProviderMessage(providerError);
            } else if (
              providerError &&
              typeof providerError === "object" &&
              "message" in providerError
            ) {
              providerMessage = sanitizeProviderMessage(
                (providerError as { message?: unknown }).message,
              );
            }
          }
        } catch {
          providerMessage = sanitizeProviderMessage(body);
        }
      }
    } catch {
      // Body reading failed
    }

    const rateLimit = extractRateLimitMetadata(response.headers, providerMessage);
    const providerStatus = response.status;

    // Handle rate-limit with retry-after information
    if (response.status === 429) {
      // If retry-after is small (<= 2 seconds) and this is the first attempt, wait and retry once
      if (
        attempt === 0 &&
        rateLimit.retryAfterSeconds !== undefined &&
        rateLimit.retryAfterSeconds <= 2
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, (rateLimit.retryAfterSeconds ?? 1) * 1000),
        );
        return executeGroqRequest(
          systemPrompt,
          userPrompt,
          conversation,
          options,
          attempt + 1,
        );
      }

      const retryNotice = rateLimit.retryAfterSeconds
        ? ` Please wait ${rateLimit.retryAfterSeconds}s before trying again.`
        : " Please wait a moment and try again.";

      throw new LectureLensAiError(
        `The AI provider rate limit was reached (HTTP 429).${retryNotice}`,
        429,
        "AI_RATE_LIMITED",
        providerStatus,
        providerMessage,
        durationMs,
        rateLimit,
      );
    }

    const configurationFailure = response.status === 401 || response.status === 403;
    throw new LectureLensAiError(
      configurationFailure
        ? `The AI provider rejected the server configuration (HTTP ${providerStatus}). Check GROQ_API_KEY.${providerMessage ? ` ${providerMessage}` : ""}`
        : providerMessage
          ? `The AI provider returned HTTP ${providerStatus}: ${providerMessage}`
          : `The AI provider could not complete this request (HTTP ${providerStatus}). Please try again.`,
      502,
      configurationFailure ? "AI_PROVIDER_CONFIGURATION_ERROR" : "AI_PROVIDER_ERROR",
      providerStatus,
      providerMessage,
      durationMs,
      rateLimit,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LectureLensAiError(
      "The AI provider returned an unreadable response. Please try again.",
      502,
      "AI_INVALID_RESPONSE",
      response.status,
      undefined,
      durationMs,
    );
  }

  const content = readCompletionText(payload);
  if (!content) {
    throw new LectureLensAiError(
      "The AI provider returned an empty response. Please try again.",
      502,
      "AI_EMPTY_RESPONSE",
      response.status,
      undefined,
      durationMs,
    );
  }

  const parsedData = extractJsonObject(content);

  // Extract token usage metrics
  let tokens: TokenUsageMetadata | undefined;
  if (payload && typeof payload === "object" && "usage" in payload) {
    const usage = (payload as { usage?: unknown }).usage;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      tokens = {
        promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
        completionTokens:
          typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
        totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
      };
    }
  }

  const rateLimit = extractRateLimitMetadata(response.headers);
  const diagnostics: AiDiagnostics = {
    durationMs,
    providerStatus: response.status,
    tokens,
    rateLimit,
    cached: false,
  };

  return { data: parsedData, diagnostics };
}

export async function requestLectureLensJson(
  systemPrompt: string,
  userPrompt: string,
  conversation: Array<{ role: "user" | "assistant"; content: string }> = [],
  options?: RequestLectureLensOptions,
): Promise<unknown> {
  const cacheKey = options?.cacheKey;

  // 1. Check in-memory cache
  if (cacheKey) {
    const cached = memoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const cachedDiagnostics: AiDiagnostics = {
        ...cached.diagnostics,
        durationMs: 0,
        cached: true,
      };
      options?.onDiagnostics?.(cachedDiagnostics);
      return cached.data;
    }
    if (cached) {
      memoryCache.delete(cacheKey);
    }

    // 2. Coalesce in-flight duplicate requests for the same operation
    const inFlight = inFlightRequests.get(cacheKey);
    if (inFlight) {
      const result = await inFlight;
      options?.onDiagnostics?.({ ...result.diagnostics, cached: true });
      return result.data;
    }
  }

  const executionPromise = executeGroqRequest(
    systemPrompt,
    userPrompt,
    conversation,
    options,
  );

  if (cacheKey) {
    inFlightRequests.set(cacheKey, executionPromise);
  }

  try {
    const { data, diagnostics } = await executionPromise;

    if (cacheKey) {
      // Enforce max cache size
      if (memoryCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = memoryCache.keys().next().value;
        if (oldestKey) memoryCache.delete(oldestKey);
      }
      memoryCache.set(cacheKey, {
        data,
        diagnostics,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    options?.onDiagnostics?.(diagnostics);
    return data;
  } finally {
    if (cacheKey) {
      inFlightRequests.delete(cacheKey);
    }
  }
}
