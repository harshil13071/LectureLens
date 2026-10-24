import { Router, type IRouter, type Request, type Response } from "express";
import {
  AskLectureBody,
  AskLectureResponse,
  GenerateQuizBody,
  GenerateQuizResponse,
  GenerateStudyNotesBody,
  GenerateStudyNotesResponse,
} from "@workspace/api-zod";
import {
  LectureLensAiError,
  requestLectureLensJson,
} from "../lib/lectureLensAi";

const router: IRouter = Router();

function sendAiError(
  req: Request,
  res: Response,
  error: unknown,
  operation: string,
): void {
  if (error instanceof LectureLensAiError) {
    req.log.warn(
      {
        operation,
        code: error.code,
        status: error.status,
        providerStatus: error.providerStatus,
        providerMessage: error.providerMessage,
      },
      "LectureLens AI request failed",
    );
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  req.log.error({ operation }, "LectureLens response validation failed");
  res.status(502).json({
    error: "The AI response could not be validated. Please try again.",
    code: "AI_RESPONSE_VALIDATION_FAILED",
  });
}

router.post("/study-notes", async (req, res): Promise<void> => {
  const parsed = GenerateStudyNotesBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.transcript.trim()) {
    res.status(400).json({
      error: "Paste a lecture transcript before generating notes.",
      code: "INVALID_TRANSCRIPT",
    });
    return;
  }

  const { title, transcript } = parsed.data;
  try {
    const result = await requestLectureLensJson(
      "You are LectureLens, a careful college study assistant. Use only the provided lecture transcript. Do not invent facts. Return valid JSON only with exactly these fields: overview (string), topics (array of {title:string, notes:string[]}), keyConcepts (array of {term:string, definition:string}), takeaways (string[]), quickRevision (string). Make the notes clear, useful, and faithful to the transcript.",
      `Create structured study notes for this lecture${title ? ` titled "${title}"` : ""}.\n\nTranscript:\n${transcript}`,
    );
    res.json(GenerateStudyNotesResponse.parse(result));
  } catch (error) {
    sendAiError(req, res, error, "study-notes");
  }
});

router.post("/quiz", async (req, res): Promise<void> => {
  const parsed = GenerateQuizBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.transcript.trim()) {
    res.status(400).json({
      error: "Paste a lecture transcript before generating a quiz.",
      code: "INVALID_TRANSCRIPT",
    });
    return;
  }

  const { title, transcript } = parsed.data;
  try {
    const result = await requestLectureLensJson(
      "You are LectureLens, a careful college study assistant. Use only the provided lecture transcript. Return valid JSON only with exactly this shape: {\"questions\":[{\"question\":string,\"options\":[string,string,string,string],\"correctIndex\":integer from 0 to 3,\"explanation\":string}]}. Create exactly five useful multiple-choice questions. Each question must have exactly four distinct answer options, one unambiguous correct answer, and an explanation grounded in the transcript. Do not invent facts.",
      `Create a five-question practice quiz for this lecture${title ? ` titled "${title}"` : ""}.\n\nTranscript:\n${transcript}`,
    );
    res.json(GenerateQuizResponse.parse(result));
  } catch (error) {
    sendAiError(req, res, error, "quiz");
  }
});

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
  try {
    const result = await requestLectureLensJson(
      "You are LectureLens, a careful, friendly AI tutor. Answer the student's question using your general knowledge. Treat any lecture transcript as optional supporting context, never as a limit on what you can answer. When relevant, explain how the answer connects to the lecture; do not claim a point appears in the transcript unless it does. If uncertain, say so and avoid inventing facts. Give clear, beginner-friendly answers with examples when useful. Structure multi-part answers with short headings or bullets, while keeping simple answers concise. Return valid JSON only with exactly these fields: answer (string) and foundInTranscript (boolean). Set foundInTranscript true only if the transcript itself contains information that directly supports the answer; otherwise false.",
      `${transcript?.trim() ? `Lecture${title ? ` titled "${title}"` : ""} transcript (supporting context):\n${transcript.trim()}\n\n` : ""}Student question:\n${question}`,
      conversation,
    );
    res.json(AskLectureResponse.parse(result));
  } catch (error) {
    sendAiError(req, res, error, "ask");
  }
});

export default router;
