import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import {
  AskLectureBody,
  AskLectureResponse,
  EvaluateShortAnswerBody,
  EvaluateShortAnswerResponse,
  ExtractDocumentTextResponse,
  GenerateQuizBody,
  GenerateQuizResponse,
  GenerateStudyNotesBody,
  GenerateStudyNotesResponse,
  ResearchTopicBody,
  ResearchTopicResponse,
} from "@workspace/api-zod";
import {
  type AiDiagnostics,
  LectureLensAiError,
  getAiCacheKey,
  requestLectureLensJson,
} from "../lib/lectureLensAi";
import { searchWeb } from "../lib/webSearch";
import { extractTextFromFile } from "../lib/fileExtractor";

const router: IRouter = Router();

// Configure multer memory storage for file uploads (max 15MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const NOTES_SYSTEM_PROMPT =
  'You are LectureLens, a college study assistant. Analyze the lecture transcript and return a JSON object with: "overview" (concise summary string), "topics" (array of { "title": string, "notes": string[] }), "keyConcepts" (array of { "term": string, "definition": string }), "takeaways" (string[]), and "quickRevision" (string summary). Ground all content strictly in the transcript without inventing facts.';

const ASK_SYSTEM_PROMPT =
  'You are LectureLens, a friendly AI tutor. Answer the student question clearly with examples where helpful. When lecture context is provided, connect the answer to it and set "foundInTranscript" to true only if the transcript directly supports the answer; otherwise false. Return a JSON object with: "answer" (string) and "foundInTranscript" (boolean).';

function buildQuizSystemPrompt(
  type: "mcq" | "short_answer" | "mixed",
  count: number,
  difficulty: "easy" | "medium" | "hard" | "mixed",
): string {
  let typeDirective = "";
  if (type === "mcq") {
    typeDirective = `Generate exactly ${count} multiple-choice questions. For each question, set "type" to "mcq", provide exactly 4 distinct answer "options", set "correctIndex" (integer 0 to 3), and provide a concise "explanation" grounded in the study material. Avoid duplicate options or ambiguous questions.`;
  } else if (type === "short_answer") {
    typeDirective = `Generate exactly ${count} short-answer questions. For each question, set "type" to "short_answer", omit "options" and "correctIndex", provide an "expectedAnswer" (the ideal concise response), 2 to 4 "keyPoints" (grading rubric of core concepts that must be mentioned), and an "explanation" grounded in the study material.`;
  } else {
    typeDirective = `Generate exactly ${count} mixed questions (a balanced mix of multiple-choice and short-answer questions). For MCQs, set "type" to "mcq", provide 4 distinct "options", "correctIndex", and "explanation". For short-answer questions, set "type" to "short_answer", provide "expectedAnswer", 2-4 "keyPoints", and "explanation".`;
  }

  const difficultyDirective =
    difficulty === "mixed"
      ? "Distribute the difficulty across easy, medium, and challenging questions."
      : `Calibrate the questions specifically for ${difficulty} difficulty.`;

  return `You are LectureLens, an expert college study assistant. Based strictly on the provided study material, generate a practice quiz.
${typeDirective}
${difficultyDirective}
Also provide 2 to 4 actionable "revisionSuggestions" (specific topics or concepts from the material that the student should review).
Return a JSON object matching this structure:
{
  "questions": [
    {
      "type": "mcq" | "short_answer",
      "question": string,
      "options"?: [string, string, string, string],
      "correctIndex"?: integer,
      "expectedAnswer"?: string,
      "keyPoints"?: string[],
      "explanation": string
    }
  ],
  "revisionSuggestions": string[]
}`;
}

function sendAiSuccess(
  req: Request,
  res: Response,
  data: unknown,
  operation: string,
  diagnostics?: AiDiagnostics,
): void {
  if (diagnostics) {
    req.log.info(
      {
        operation,
        durationMs: diagnostics.durationMs,
        providerStatus: diagnostics.providerStatus,
        tokens: diagnostics.tokens,
        rateLimit: diagnostics.rateLimit,
        cached: diagnostics.cached,
      },
      "LectureLens AI request succeeded",
    );
    res.setHeader("Server-Timing", `ai;dur=${diagnostics.durationMs}`);
  }
  res.json(data);
}

function sendAiError(
  req: Request,
  res: Response,
  error: unknown,
  operation: string,
  durationMs?: number,
): void {
  if (error instanceof LectureLensAiError) {
    req.log.warn(
      {
        operation,
        code: error.code,
        status: error.status,
        providerStatus: error.providerStatus,
        providerMessage: error.providerMessage,
        durationMs: error.durationMs ?? durationMs,
        rateLimit: error.rateLimit,
      },
      "LectureLens AI request failed",
    );

    if (error.rateLimit?.retryAfterSeconds) {
      res.setHeader("Retry-After", String(error.rateLimit.retryAfterSeconds));
    }

    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.rateLimit?.retryAfterSeconds
        ? { retryAfter: error.rateLimit.retryAfterSeconds }
        : {}),
    });
    return;
  }

  const message =
    error instanceof Error ? error.message : "The operation could not be completed.";
  req.log.error(
    { operation, durationMs, error: message },
    "LectureLens request failed",
  );
  res.status(502).json({
    error: message,
    code: "OPERATION_FAILED",
  });
}

// ---------------------------------------------------------------------------
// Study Notes Endpoint
// ---------------------------------------------------------------------------
router.post("/study-notes", async (req, res): Promise<void> => {
  const parsed = GenerateStudyNotesBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.transcript.trim()) {
    res.status(400).json({
      error: "Paste a lecture transcript or upload study material before generating notes.",
      code: "INVALID_TRANSCRIPT",
    });
    return;
  }

  const { title, transcript } = parsed.data;
  const trimmedTranscript = transcript.trim();
  const trimmedTitle = title?.trim();
  const cacheKey = getAiCacheKey("study-notes", {
    title: trimmedTitle || "",
    transcript: trimmedTranscript,
  });

  const startTime = Date.now();
  let diagnostics: AiDiagnostics | undefined;

  try {
    const userPrompt = trimmedTitle
      ? `Lecture: "${trimmedTitle}"\n\nTranscript:\n${trimmedTranscript}`
      : `Transcript:\n${trimmedTranscript}`;

    const rawResult = await requestLectureLensJson(
      NOTES_SYSTEM_PROMPT,
      userPrompt,
      [],
      {
        maxTokens: 2500,
        operation: "study-notes",
        cacheKey,
        onDiagnostics: (d) => {
          diagnostics = d;
        },
      },
    );

    const validated = GenerateStudyNotesResponse.parse(rawResult);
    sendAiSuccess(req, res, validated, "study-notes", diagnostics);
  } catch (error) {
    sendAiError(req, res, error, "study-notes", Date.now() - startTime);
  }
});

// ---------------------------------------------------------------------------
// Customizable Quiz Endpoint
// ---------------------------------------------------------------------------
router.post("/quiz", async (req, res): Promise<void> => {
  const parsed = GenerateQuizBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.transcript.trim()) {
    res.status(400).json({
      error: "Paste study material or upload a document before generating a quiz.",
      code: "INVALID_TRANSCRIPT",
    });
    return;
  }

  const {
    title,
    transcript,
    questionType = "mcq",
    questionCount = 5,
    difficulty = "medium",
  } = parsed.data;

  const trimmedTranscript = transcript.trim();
  const trimmedTitle = title?.trim();

  // Validate bounds
  const validCount = Math.min(30, Math.max(1, questionCount));
  const cacheKey = getAiCacheKey("quiz", {
    title: trimmedTitle || "",
    transcript: trimmedTranscript,
    questionType,
    questionCount: validCount,
    difficulty,
  });

  const startTime = Date.now();
  let diagnostics: AiDiagnostics | undefined;

  try {
    const systemPrompt = buildQuizSystemPrompt(
      questionType,
      validCount,
      difficulty,
    );
    const userPrompt = trimmedTitle
      ? `Study Material Title: "${trimmedTitle}"\n\nContent:\n${trimmedTranscript}`
      : `Study Material:\n${trimmedTranscript}`;

    // Scale token budget dynamically with question count
    const maxTokens = Math.min(4000, Math.max(1200, validCount * 220));

    const rawResult = await requestLectureLensJson(
      systemPrompt,
      userPrompt,
      [],
      {
        maxTokens,
        operation: "quiz",
        cacheKey,
        onDiagnostics: (d) => {
          diagnostics = d;
        },
      },
    );

    // Normalize questions to match schema
    const resultObj = rawResult as Record<string, unknown>;
    if (Array.isArray(resultObj.questions)) {
      resultObj.questions = resultObj.questions.map((q: Record<string, unknown>) => ({
        type: q.type === "short_answer" ? "short_answer" : "mcq",
        question: typeof q.question === "string" ? q.question : "Question",
        options: Array.isArray(q.options) ? q.options.map(String).slice(0, 4) : undefined,
        correctIndex: typeof q.correctIndex === "number" ? q.correctIndex : undefined,
        expectedAnswer: typeof q.expectedAnswer === "string" ? q.expectedAnswer : undefined,
        keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints.map(String) : undefined,
        explanation: typeof q.explanation === "string" ? q.explanation : "Grounded in study material.",
      }));
    }

    const validated = GenerateQuizResponse.parse(resultObj);
    if (validated.questions.length !== validCount) {
      throw new Error(`Quiz generation returned ${validated.questions.length} questions; ${validCount} were requested.`);
    }
    const generatedTypes = new Set(validated.questions.map((question) => question.type ?? "mcq"));
    if (questionType === "mixed") {
      if (!generatedTypes.has("mcq") || !generatedTypes.has("short_answer")) {
        throw new Error("Quiz generation did not return both multiple-choice and short-answer questions as requested.");
      }
    } else if (validated.questions.some((question) => (question.type ?? "mcq") !== questionType)) {
      throw new Error(`Quiz generation did not follow the requested ${questionType} question type.`);
    }
    sendAiSuccess(req, res, validated, "quiz", diagnostics);
  } catch (error) {
    sendAiError(req, res, error, "quiz", Date.now() - startTime);
  }
});

// ---------------------------------------------------------------------------
// Short-Answer Evaluation Endpoint
// ---------------------------------------------------------------------------
router.post("/quiz/evaluate-answer", async (req, res): Promise<void> => {
  const parsed = EvaluateShortAnswerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Provide question, student answer, and expected answer for evaluation.",
      code: "INVALID_INPUT",
    });
    return;
  }

  const { question, studentAnswer, expectedAnswer, keyPoints = [] } = parsed.data;
  const trimmedAnswer = studentAnswer.trim();

  // If student answer is empty, fail fast without AI call
  if (!trimmedAnswer) {
    res.json({
      isCorrect: false,
      score: 0,
      feedback: "No answer was provided.",
      whatYouGotRight: [],
      whatYouMissed: keyPoints.length > 0 ? keyPoints : [expectedAnswer],
    });
    return;
  }

  const cacheKey = getAiCacheKey("eval-answer", {
    question,
    studentAnswer: trimmedAnswer,
    expectedAnswer,
    keyPoints,
  });

  const startTime = Date.now();
  let diagnostics: AiDiagnostics | undefined;

  try {
    const evalPrompt = `You are a fair college instructor evaluating a student's short-answer response.
Question: "${question}"
Expected Model Answer: "${expectedAnswer}"
Key Grading Points: ${keyPoints.length > 0 ? JSON.stringify(keyPoints) : "Core concept"}
Student's Response: "${trimmedAnswer}"

Grading Criteria:
- Accept reasonable alternative phrasing, synonyms, and paraphrasing.
- Give credit for partial accuracy.
- Calculate score between 0.0 (completely incorrect) and 1.0 (complete and accurate).
- Set isCorrect to true if score >= 0.65.
- Provide constructive, encouraging feedback explaining what was correct and what key points were missed.

Return a JSON object with:
{
  "isCorrect": boolean,
  "score": number between 0 and 1,
  "feedback": string,
  "whatYouGotRight": string[],
  "whatYouMissed": string[]
}`;

    const rawResult = await requestLectureLensJson(
      evalPrompt,
      "Evaluate the student response now.",
      [],
      {
        maxTokens: 600,
        operation: "evaluate-answer",
        cacheKey,
        onDiagnostics: (d) => {
          diagnostics = d;
        },
      },
    );

    const validated = EvaluateShortAnswerResponse.parse(rawResult);
    sendAiSuccess(req, res, validated, "evaluate-answer", diagnostics);
  } catch (error) {
    sendAiError(req, res, error, "evaluate-answer", Date.now() - startTime);
  }
});

// ---------------------------------------------------------------------------
// Document Text Extraction Endpoint (TXT, PDF, DOCX)
// ---------------------------------------------------------------------------
router.post("/extract-text", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: "File is too large. Please upload documents under 15 MB.",
        code: "FILE_TOO_LARGE",
      });
      return;
    }
    if (err) {
      res.status(400).json({
        error: "Upload failed. Please check your document and try again.",
        code: "UPLOAD_FAILED",
      });
      return;
    }
    next();
  });
}, async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({
      error: "Please select a .txt, .pdf, or .docx file to upload.",
      code: "NO_FILE_UPLOADED",
    });
    return;
  }

  try {
    const result = await extractTextFromFile(
      req.file.originalname,
      req.file.mimetype,
      req.file.buffer,
    );

    const validated = ExtractDocumentTextResponse.parse(result);
    req.log.info(
      {
        filename: validated.filename,
        fileType: validated.fileType,
        textLength: validated.textLength,
      },
      "Document text extracted successfully",
    );
    res.json(validated);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Document text extraction failed.";
    res.status(400).json({
      error: message,
      code: "EXTRACTION_FAILED",
    });
  }
});

// ---------------------------------------------------------------------------
// AI Tutor Ask Endpoint
// ---------------------------------------------------------------------------
router.post("/ask", async (req, res): Promise<void> => {
  const parsed = AskLectureBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.question.trim()) {
    res.status(400).json({
      error: "Provide a question to ask the AI tutor.",
      code: "INVALID_QUESTION",
    });
    return;
  }

  const { title, transcript, question, conversation = [] } = parsed.data;
  const trimmedQuestion = question.trim();
  const trimmedTranscript = transcript?.trim();
  const trimmedTitle = title?.trim();

  // Deduplication & cache key for this question within the conversation
  const cacheKey = getAiCacheKey("ask", {
    title: trimmedTitle || "",
    transcript: trimmedTranscript || "",
    question: trimmedQuestion,
    conversation,
  });

  const startTime = Date.now();
  let diagnostics: AiDiagnostics | undefined;

  try {
    // Keep lecture context in the system prompt so it is not duplicated in user messages across conversation turns
    const systemPrompt = trimmedTranscript
      ? `${ASK_SYSTEM_PROMPT}\n\nSupporting study context${trimmedTitle ? ` ("${trimmedTitle}")` : ""}:\n${trimmedTranscript}`
      : ASK_SYSTEM_PROMPT;

    const rawResult = await requestLectureLensJson(
      systemPrompt,
      trimmedQuestion,
      conversation,
      {
        maxTokens: 1000,
        operation: "ask",
        cacheKey,
        onDiagnostics: (d) => {
          diagnostics = d;
        },
      },
    );

    const validated = AskLectureResponse.parse(rawResult);
    sendAiSuccess(req, res, validated, "ask", diagnostics);
  } catch (error) {
    sendAiError(req, res, error, "ask", Date.now() - startTime);
  }
});

// ---------------------------------------------------------------------------
// AI Topic Research with Live Web Search Endpoint
// ---------------------------------------------------------------------------
router.post("/research", async (req, res): Promise<void> => {
  const parsed = ResearchTopicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Provide a valid research topic or question (minimum 2 characters).",
      code: "INVALID_QUERY",
    });
    return;
  }

  const { query, mode = "overview" } = parsed.data;
  const trimmedQuery = query.trim();
  const cacheKey = getAiCacheKey("research", { query: trimmedQuery, mode });
  const startTime = Date.now();
  let diagnostics: AiDiagnostics | undefined;

  try {
    // 1. Perform live web search
    const sources = await searchWeb(trimmedQuery, 6);

    // 2. Format search sources
    const sourcesContext = sources
      .map(
        (s, i) =>
          `[Source ${i + 1}] Title: ${s.title}\nURL: ${s.url}\nExcerpt: ${s.snippet}`,
      )
      .join("\n\n");

    let modeDirective = "Provide a balanced, accessible academic overview.";
    if (mode === "detailed") {
      modeDirective =
        "Provide an in-depth, rigorous breakdown with specific technical explanations, architecture/methodology, and nuances.";
    } else if (mode === "exam_prep") {
      modeDirective =
        "Structure the output as a high-yield exam preparation guide highlighting must-know formulas/rules, key definitions, common exam questions, and core takeaways.";
    } else if (mode === "comparison") {
      modeDirective =
        "Structure the output as an analytical comparison contrasting core perspectives, trade-offs, advantages, and distinct differences.";
    }

    const systemPrompt = `You are LectureLens Research, an academic AI synthesis engine. Using only the provided live web search results, formulate an accurate, well-structured synthesis.
${modeDirective}
Ground every statement in the retrieved sources. If any information is uncertain or contradictory across sources, note it clearly in "uncertaintyNote".
Return a JSON object with:
{
  "topic": "${trimmedQuery}",
  "mode": "${mode}",
  "overview": "Concise 2-3 sentence executive orientation",
  "sections": [{ "heading": string, "content": string }],
  "keyConcepts": [{ "term": string, "definition": string }],
  "examples": string[],
  "uncertaintyNote"?: string,
  "sources": [{ "title": string, "url": string, "snippet": string }]
}`;

    const userPrompt = `Research Topic / Question: "${trimmedQuery}"\n\nLive Web Search Results:\n${sourcesContext}`;

    const rawResult = await requestLectureLensJson(
      systemPrompt,
      userPrompt,
      [],
      {
        maxTokens: 2500,
        operation: "research",
        cacheKey,
        onDiagnostics: (d) => {
          diagnostics = d;
        },
      },
    );

    const resultObj = rawResult as Record<string, unknown>;
    resultObj.topic = trimmedQuery;
    resultObj.mode = mode;
    // Guarantee real search links and sources
    resultObj.sources = sources;

    const validated = ResearchTopicResponse.parse(resultObj);
    sendAiSuccess(req, res, validated, "research", diagnostics);
  } catch (error) {
    sendAiError(req, res, error, "research", Date.now() - startTime);
  }
});

export default router;
