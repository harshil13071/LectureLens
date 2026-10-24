import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { getPool } from "@workspace/db";
import { createGoogleIdentityMiddleware, stableGoogleUserId } from "./lib/googleAuth";
import { LectureLensAiError } from "./lib/lectureLensAi";
import {
  chunkMaterial,
  embedTexts,
  quoteMatchesChunk,
  RagError,
  RAG_EMBEDDING_DIMENSIONS,
} from "./lib/rag";
import { createRagRouter } from "./routes/rag";

test("RAG chunking preserves headings and page metadata and overlaps long passages", () => {
  const long = Array.from({ length: 160 }, (_, index) => `concept${index}`).join(" ");
  const chunks = chunkMaterial(`# Cell Biology\n\n${long}`, [{ pageNumber: 7, text: `# Cell Biology\n\n${long}` }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.pageNumber === 7 && chunk.section === "Cell Biology"));
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1_600));
  assert.ok(chunks.some((chunk, index) => index > 0 && chunks[index - 1]!.text.split(" ").some((word) => chunk.text.includes(word))));
});

test("RAG embedding client fails closed and validates compatible API vectors", async () => {
  await assert.rejects(() => embedTexts(["query"], { apiKey: "" }), (error: unknown) => error instanceof RagError && error.code === "EMBEDDING_NOT_CONFIGURED");
  const vector = Array.from({ length: RAG_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
  const result = await embedTexts(["one", "two"], {
    apiKey: "test-only",
    baseUrl: "https://embedding.invalid/v1/",
    fetcher: async (input, init) => {
      assert.equal(String(input), "https://embedding.invalid/v1/embeddings");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: vector }, { index: 0, embedding: vector }] }), { status: 200 });
    },
  });
  assert.equal(result.length, 2);
  assert.equal(result[0]![0], 1);
  await assert.rejects(() => embedTexts(["one"], {
    apiKey: "test-only",
    fetcher: async () => new Response("", { status: 429 }),
  }), (error: unknown) => error instanceof RagError && error.code === "EMBEDDING_RATE_LIMITED");
});

test("citation quotes must exist in retrieved passages", () => {
  assert.equal(quoteMatchesChunk("mitochondria make ATP", "Mitochondria make ATP during cellular respiration."), true);
  assert.equal(quoteMatchesChunk("chloroplasts make ATP", "Mitochondria make ATP during cellular respiration."), false);
});

test("Google identity middleware requires a bearer token and derives ownership from verified subject", async () => {
  const app = express();
  app.get("/", createGoogleIdentityMiddleware(async (token, audience) => {
    assert.equal(audience, "test-google-client");
    return token === "test-google-id-token-123456789" ? { sub: "provider-subject-1" } : null;
  }), (_req, res) => res.json({ userId: res.locals.ragUserId }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  try {
    const noToken = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(noToken.status, 401);
    const valid = await fetch(`http://127.0.0.1:${port}/`, { headers: { Authorization: "Bearer test-google-id-token-123456789" } });
    assert.equal(valid.status, 200);
    const body = await valid.json() as { userId: string };
    assert.equal(body.userId, stableGoogleUserId("provider-subject-1"));
    assert.notEqual(body.userId, "provider-subject-1");
    const invalid = await fetch(`http://127.0.0.1:${port}/`, { headers: { Authorization: "Bearer unknown-google-id-token-123456789" } });
    assert.equal(invalid.status, 401);
  } finally {
    if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("RAG routes scope indexing, retrieval, citations, and deletion to the verified user (PostgreSQL required)", { skip: !process.env.DATABASE_URL }, async () => {
  const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "rag-test-client";
  const ownerSubject = `google-subject-rag-one-${crypto.randomUUID()}`;
  const otherSubject = `google-subject-rag-two-${crypto.randomUUID()}`;
  const users = new Map([
    ["test-google-token-user-one-123456789", ownerSubject],
    ["test-google-token-user-two-123456789", otherSubject],
  ]);
  const fakeEmbed = async (texts: string[]) => texts.map((text) => {
    const vector = new Array<number>(RAG_EMBEDDING_DIMENSIONS).fill(0);
    vector[0] = /mitochondria/i.test(text) ? 1 : 0;
    vector[1] = /photosynthesis/i.test(text) ? 1 : 0;
    vector[2] = vector[0] || vector[1] ? 0 : 1;
    return vector;
  });
  const app = express();
  app.use(express.json({ limit: "300kb" }));
  app.use("/api/rag", createRagRouter({
    pool: getPool,
    verifyToken: async (token) => {
      const sub = users.get(token);
      return sub ? { sub } : null;
    },
    embed: fakeEmbed,
    answer: async (_question, sources) => ({
      answer: "Mitochondria generate ATP during cellular respiration.",
      insufficientMaterial: false,
      citations: sources[0] ? [{ sourceRef: sources[0].sourceRef, quote: sources[0].text.slice(0, 100) }] : [],
    }),
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/rag`;
  const ownerToken = "test-google-token-user-one-123456789";
  const otherToken = "test-google-token-user-two-123456789";
  const key = `test:${crypto.randomUUID()}`;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  const ownerFetch = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...headers(ownerToken), ...(init.headers ?? {}) } });
  const otherFetch = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...headers(otherToken), ...(init.headers ?? {}) } });
  let documentId = "";
  let otherDocumentId = "";
  try {
    const created = await ownerFetch("/documents", { method: "POST", body: JSON.stringify({ sourceKey: key, sourceType: "note", title: "Cellular Respiration", subject: "Biology", content: "Mitochondria generate ATP during cellular respiration. The inner membrane contains the electron transport chain." }) });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { document: { id: string; chunkCount: number; reused: boolean } };
    documentId = createdBody.document.id;
    assert.equal(createdBody.document.reused, false);
    assert.ok(createdBody.document.chunkCount > 0);

    const otherCreated = await otherFetch("/documents", { method: "POST", body: JSON.stringify({ sourceKey: `test:${crypto.randomUUID()}`, sourceType: "note", title: "Private Biology", subject: "Biology", content: "Mitochondria is a private document belonging to a different Google account." }) });
    assert.equal(otherCreated.status, 201);
    otherDocumentId = ((await otherCreated.json()) as { document: { id: string } }).document.id;

    const retry = await ownerFetch("/documents", { method: "POST", body: JSON.stringify({ sourceKey: key, sourceType: "note", title: "Cellular Respiration", subject: "Biology", content: "Mitochondria generate ATP during cellular respiration. The inner membrane contains the electron transport chain." }) });
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { document: { reused: boolean } }).document.reused, true);

    const listed = await ownerFetch("/documents");
    const ownerDocuments = (await listed.json() as { documents: Array<{ id: string }> }).documents;
    assert.deepEqual(ownerDocuments.map((item) => item.id), [documentId]);
    assert.equal((await ownerFetch(`/documents/${otherDocumentId}`)).status, 404);

    const answer = await ownerFetch("/ask", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?" }) });
    assert.equal(answer.status, 200);
    const answerBody = await answer.json() as { answer: string; citations: Array<{ documentId: string; title: string; quote: string }> };
    assert.match(answerBody.answer, /ATP/);
    assert.equal(answerBody.citations.length, 1);
    assert.equal(answerBody.citations[0]!.documentId, documentId);
    assert.equal(answerBody.citations[0]!.title, "Cellular Respiration");

    const selectedContext = await ownerFetch("/context", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?", documentIds: [documentId], subject: "Biology" }) });
    assert.equal(selectedContext.status, 200);
    const selectedPassages = (await selectedContext.json() as { passages: Array<{ documentId: string; text: string }> }).passages;
    assert.ok(selectedPassages.length > 0);
    assert.ok(selectedPassages.every((passage) => passage.documentId === documentId));

    const noSelection = await ownerFetch("/ask", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?", documentIds: [] }) });
    assert.equal((await noSelection.json() as { citations: unknown[] }).citations.length, 0);

    const changed = await ownerFetch("/documents", { method: "POST", body: JSON.stringify({ sourceKey: key, sourceType: "note", title: "Cellular Respiration", subject: "Biology", content: "Mitochondria generate ATP through oxidative phosphorylation at the inner membrane." }) });
    assert.equal(changed.status, 200);
    assert.equal(((await changed.json()) as { document: { id: string; reused: boolean } }).document.reused, false);
    const updatedAnswer = await ownerFetch("/ask", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?" }) });
    assert.equal(((await updatedAnswer.json()) as { citations: Array<{ quote: string }> }).citations[0]?.quote.includes("oxidative phosphorylation"), true);

    const otherAnswer = await otherFetch("/ask", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?" }) });
    const otherAnswerBody = await otherAnswer.json() as { citations: Array<{ documentId: string }> };
    assert.equal(otherAnswer.status, 200);
    assert.equal(otherAnswerBody.citations[0]?.documentId, otherDocumentId);
    const crossUserFilter = await ownerFetch("/ask", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?", documentIds: [otherDocumentId] }) });
    assert.equal((await crossUserFilter.json() as { citations: unknown[] }).citations.length, 0);
    const crossUserContext = await ownerFetch("/context", { method: "POST", body: JSON.stringify({ question: "How do mitochondria produce energy?", documentIds: [otherDocumentId] }) });
    assert.equal(((await crossUserContext.json()) as { passages: unknown[] }).passages.length, 0);

    assert.equal((await ownerFetch(`/documents/${otherDocumentId}`, { method: "DELETE" })).status, 404);
    assert.equal((await otherFetch(`/documents/${otherDocumentId}`, { method: "DELETE" })).status, 200);
    const empty = await otherFetch("/ask", { method: "POST", body: JSON.stringify({ question: "What does this material say?" }) });
    assert.equal((await empty.json() as { citations: unknown[] }).citations.length, 0);

    const oversized = await ownerFetch("/documents", { method: "POST", body: JSON.stringify({ sourceKey: `test:${crypto.randomUUID()}`, sourceType: "note", title: "Oversized", content: "x".repeat(250_001) }) });
    assert.equal(oversized.status, 400);

    const retryKey = `retry:${crypto.randomUUID()}`;
    let retryDocumentId = "";
    let embeddingAttempts = 0;
    const retryApp = express();
    retryApp.use(express.json());
    retryApp.use("/api/rag", createRagRouter({
      pool: getPool,
      verifyToken: async (token) => { const sub = users.get(token); return sub ? { sub } : null; },
      embed: async (texts) => {
        embeddingAttempts++;
        if (embeddingAttempts === 1) throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", 502, "Embedding service unavailable");
        return fakeEmbed(texts);
      },
    }));
    const retryServer = http.createServer(retryApp);
    await new Promise<void>((resolve) => retryServer.listen(0, "127.0.0.1", resolve));
    try {
      const retryPort = (retryServer.address() as { port: number }).port;
      const retryUrl = `http://127.0.0.1:${retryPort}/api/rag/documents`;
      const body = JSON.stringify({ sourceKey: retryKey, sourceType: "note", title: "Retry me", content: "Photosynthesis converts light energy into chemical energy." });
      const failed = await fetch(retryUrl, { method: "POST", headers: headers(ownerToken), body });
      const failedBody = await failed.text();
      assert.equal(failed.status, 502, failedBody);
      const failedRows = await ownerFetch("/documents");
      const failedDocument = ((await failedRows.json()) as { documents: Array<{ id: string; status: string; title: string }> }).documents.find((item) => item.title === "Retry me");
      assert.equal(failedDocument?.status, "failed");
      const retried = await fetch(retryUrl, { method: "POST", headers: headers(ownerToken), body });
      assert.equal(retried.status, 200);
      const retriedDocument = (await retried.json()) as { document: { id: string; status: string } };
      retryDocumentId = retriedDocument.document.id;
      assert.equal(retriedDocument.document.id, failedDocument?.id);
      const refreshed = await ownerFetch("/documents");
      const ready = ((await refreshed.json()) as { documents: Array<{ id: string; status: string }> }).documents.find((item) => item.id === retryDocumentId);
      assert.equal(ready?.status, "ready");
    } finally {
      await new Promise<void>((resolve, reject) => retryServer.close((error) => error ? reject(error) : resolve()));
    }

    const failingApp = express();
    failingApp.use(express.json());
    failingApp.use("/api/rag", createRagRouter({
      pool: getPool,
      verifyToken: async (token) => { const sub = users.get(token); return sub ? { sub } : null; },
      embed: fakeEmbed,
      answer: async () => { throw new LectureLensAiError("AI unavailable", 503, "AI_NOT_CONFIGURED"); },
    }));
    const failingServer = http.createServer(failingApp);
    await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    try {
      const failingPort = (failingServer.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${failingPort}/api/rag/ask`, { method: "POST", headers: headers(ownerToken), body: JSON.stringify({ question: "What do mitochondria do?" }) });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { code: string }).code, "AI_NOT_CONFIGURED");
    } finally {
      await new Promise<void>((resolve, reject) => failingServer.close((error) => error ? reject(error) : resolve()));
    }

    const brokenDbApp = express();
    brokenDbApp.use(express.json());
    brokenDbApp.use("/api/rag", createRagRouter({
      pool: (() => { throw new Error("simulated database outage"); }) as unknown as typeof getPool,
      verifyToken: async (token) => { const sub = users.get(token); return sub ? { sub } : null; },
    }));
    const brokenDbServer = http.createServer(brokenDbApp);
    await new Promise<void>((resolve) => brokenDbServer.listen(0, "127.0.0.1", resolve));
    try {
      const brokenDbPort = (brokenDbServer.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${brokenDbPort}/api/rag/documents`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.status, 500);
      assert.equal((await response.json() as { code: string }).code, "RAG_OPERATION_FAILED");
    } finally {
      await new Promise<void>((resolve, reject) => brokenDbServer.close((error) => error ? reject(error) : resolve()));
    }

    const badQuoteRouter = createRagRouter({
      pool: getPool,
      verifyToken: async (token) => { const sub = users.get(token); return sub ? { sub } : null; },
      embed: fakeEmbed,
      answer: async () => ({ answer: "Unsupported claim", insufficientMaterial: false, citations: [{ sourceRef: "S1", quote: "This phrase does not occur in the passage" }] }),
    });
    const citationApp = express();
    citationApp.use(express.json());
    citationApp.use("/api/rag", badQuoteRouter);
    const citationServer = http.createServer(citationApp);
    await new Promise<void>((resolve) => citationServer.listen(0, "127.0.0.1", resolve));
    try {
      const port2 = (citationServer.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port2}/api/rag/ask`, { method: "POST", headers: headers(ownerToken), body: JSON.stringify({ question: "What do mitochondria do?" }) });
      const body = await response.json() as { insufficientMaterial: boolean; citations: unknown[] };
      assert.equal(body.citations.length, 0);
      assert.equal(body.insufficientMaterial, true);
    } finally {
      await new Promise<void>((resolve, reject) => citationServer.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    if (documentId) await getPool().query("DELETE FROM rag_documents WHERE user_id=$1 AND id=$2", [stableGoogleUserId(ownerSubject), documentId]).catch(() => undefined);
    if (otherDocumentId) await getPool().query("DELETE FROM rag_documents WHERE user_id=$1 AND id=$2", [stableGoogleUserId(otherSubject), otherDocumentId]).catch(() => undefined);
    await getPool().query("DELETE FROM rag_documents WHERE user_id=$1 AND source_key LIKE 'retry:%'", [stableGoogleUserId(ownerSubject)]).catch(() => undefined);
    await getPool().query("DELETE FROM rag_usage_limits WHERE user_id = ANY($1::char(64)[])", [[stableGoogleUserId(ownerSubject), stableGoogleUserId(otherSubject)]]).catch(() => undefined);
    if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
