export class LectureLensAiError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502 | 503 | 504,
    readonly code: string,
    readonly providerStatus?: number,
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "LectureLensAiError";
  }
}

function sanitizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-or-v1-|gsk_)[a-zA-Z0-9_-]+/gi, "[redacted]")
    .replace(/\b(?:api[_ -]?key|token)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/https?:\/\/\S+/gi, "[provider URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return sanitized || undefined;
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

export async function requestLectureLensJson(
  systemPrompt: string,
  userPrompt: string,
  conversation: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<unknown> {
  const apiKey = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL;

  if (!apiKey || !model) {
    throw new LectureLensAiError(
      "AI generation is not configured yet. Add Check GROQ_API_KEY and GROK_MODEL as server-side secrets, then try again.",
      503,
      "AI_NOT_CONFIGURED",
    );
  }

  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          ...conversation.map(({ role, content }) => ({ role, content })),
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) {
      throw new LectureLensAiError(
        "The AI request took too long. Please try again.",
        504,
        "AI_TIMEOUT",
      );
    }
    throw new LectureLensAiError(
      "Could not reach the AI provider. Please try again shortly.",
      502,
      "AI_PROVIDER_UNAVAILABLE",
    );
  }

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
            } else if (providerError && typeof providerError === "object" && "message" in providerError) {
              providerMessage = sanitizeProviderMessage((providerError as { message?: unknown }).message);
            }
          }
        } catch {
          providerMessage = sanitizeProviderMessage(body);
        }
      }
    } catch {
      // Keep the original status even when the provider error body is unreadable.
    }
    const configurationFailure = response.status === 401 || response.status === 403;
    const providerStatus = response.status;
    if (response.status === 429) {
      throw new LectureLensAiError(
        providerMessage
          ? `The AI provider returned HTTP 429: ${providerMessage}`
          : "The AI provider is receiving too many requests. Please wait a moment and try again.",
        429,
        "AI_RATE_LIMITED",
        providerStatus,
        providerMessage,
      );
    }
    throw new LectureLensAiError(
      configurationFailure
        ? `The AI provider rejected the server configuration (HTTP ${providerStatus}). Check OPENROUTER_API_KEY.${providerMessage ? ` ${providerMessage}` : ""}`
        : providerMessage
          ? `The AI provider returned HTTP ${providerStatus}: ${providerMessage}`
          : `The AI provider could not complete this request (HTTP ${providerStatus}). Please try again.`,
      502,
      configurationFailure ? "AI_PROVIDER_CONFIGURATION_ERROR" : "AI_PROVIDER_ERROR",
      providerStatus,
      providerMessage,
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
    );
  }

  const content = readCompletionText(payload);
  if (!content) {
    throw new LectureLensAiError(
      "The AI provider returned an empty response. Please try again.",
      502,
      "AI_EMPTY_RESPONSE",
    );
  }

  const jsonText = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    throw new LectureLensAiError(
      "The AI provider returned an invalid format. Please try again.",
      502,
      "AI_INVALID_FORMAT",
    );
  }
}
