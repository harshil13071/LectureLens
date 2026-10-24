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
      { operation, code: error.code, status: error.status },
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
  if (
    !parsed.success ||
    !parsed.data.transcript.trim() ||
    !parsed.data.question.trim()
  ) {
    res.status(400).json({
      error: "Provide a lecture transcript and a question.",
      code: "INVALID_QUESTION",
    });
    return;
  }

  const { title, transcript, question } = parsed.data;
  try {
    const result = await requestLectureLensJson(
      "You are LectureLens, a careful college study assistant. Answer only from the provided lecture transcript. Return valid JSON only with exactly these fields: answer (string) and foundInTranscript (boolean). If the transcript does not contain enough information to answer, set foundInTranscript to false and clearly say that the lecture transcript does not cover the answer. Never fill gaps with outside knowledge.",
      `Lecture${title ? ` titled "${title}"` : ""} transcript:\n${transcript}\n\nStudent question:\n${question}`,
    );
    res.json(AskLectureResponse.parse(result));
  } catch (error) {
    sendAiError(req, res, error, "ask");
  }
});

export default router;
