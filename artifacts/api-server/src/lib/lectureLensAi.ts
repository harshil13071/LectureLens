export class LectureLensAiError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 502 | 503 | 504,
    readonly code: string,
  ) {
    super(message);
    this.name = "LectureLensAiError";
  }
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
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;

  if (!apiKey || !model) {
    throw new LectureLensAiError(
      "AI generation is not configured yet. Add OPENROUTER_API_KEY and OPENROUTER_MODEL as server-side secrets, then try again.",
      503,
      "AI_NOT_CONFIGURED",
    );
  }

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
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

  if (response.status === 429) {
    throw new LectureLensAiError(
      "The AI provider is receiving too many requests. Please wait a moment and try again.",
      429,
      "AI_RATE_LIMITED",
    );
  }
  if (!response.ok) {
    throw new LectureLensAiError(
      response.status === 401 || response.status === 403
        ? "The AI provider rejected the server configuration. Check OPENROUTER_API_KEY."
        : "The AI provider could not complete this request. Please try again.",
      502,
      "AI_PROVIDER_ERROR",
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
