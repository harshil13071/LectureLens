import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "./app";
import {
  sanitizeProviderMessage,
  extractJsonObject,
  getAiCacheKey,
  clearAiCache,
  LectureLensAiError,
} from "./lib/lectureLensAi";

// Realistic lecture transcript
const REALISTIC_LECTURE_TRANSCRIPT = `
Today we're exploring operating systems, specifically how virtual memory and paging work.
In modern computer architectures, physical RAM is limited, but programs often need more memory
than what is physically installed. Virtual memory is an abstraction provided by the OS and hardware
that gives each process the illusion of having a large, contiguous address space.

The address space is divided into fixed-size chunks called pages, typically 4 kilobytes in size.
Physical memory is similarly divided into page frames of the exact same size.
When a program accesses memory, the CPU's Memory Management Unit, or MMU, translates virtual addresses
into physical addresses using a page table maintained by the operating system kernel.

If a process references a page that is not currently mapped into physical RAM, the MMU triggers a page fault.
This is a hardware interrupt that transfers control to the operating system's page fault handler.
The OS locates the required page on backing storage (like a swap file on an SSD), loads it into an available
frame in RAM, updates the page table entry to mark it valid, and resumes the executing process.

When physical RAM is completely full and a new page must be brought in, the OS must choose an existing page
to evict. Page replacement algorithms like Least Recently Used (LRU) or Clock approximations are used to
decide which page to write back to disk if modified, and replace.
`;

// Realistic long lecture transcript (multi-topic university lecture)
const LONG_LECTURE_TRANSCRIPT = REALISTIC_LECTURE_TRANSCRIPT.repeat(8);

function createMinimalPdf(text: string, imageOnly = false): Buffer {
  const escapedText = text.replace(/[\\()]/g, "\\$&");
  const stream = imageOnly
    ? "q 300 0 0 200 100 300 cm /Im0 Do Q"
    : text ? `BT /F1 16 Tf 72 720 Td (${escapedText}) Tj ET` : "q Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >>${imageOnly ? " /XObject << /Im0 6 0 R >>" : ""} >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  if (imageOnly) {
    objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\nFF>\nendstream");
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function createStoredZip(entries: Array<[string, string]>): Buffer {
  const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [filename, contents] of entries) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.from(contents, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("sanitizeProviderMessage redacts secrets, API keys, and sensitive URLs", () => {
  const sensitive1 = "Error with Authorization: Bearer gsk_abc123456789XYZ! Access denied.";
  const sanitized1 = sanitizeProviderMessage(sensitive1);
  assert.ok(!sanitized1?.includes("gsk_abc123456789XYZ"));
  assert.ok(sanitized1?.includes("[redacted]") || sanitized1?.includes("Bearer [redacted]"));

  const sensitive2 = "Invalid api_key: gsk_supersecretkey123456 at https://api.groq.com/openai/v1";
  const sanitized2 = sanitizeProviderMessage(sensitive2);
  assert.ok(!sanitized2?.includes("gsk_supersecretkey123456"));
  assert.ok(!sanitized2?.includes("https://api.groq.com"));
  assert.ok(sanitized2?.includes("[provider URL]"));
});

test("extractJsonObject parses clean JSON, markdown-wrapped JSON, and strips reasoning tags", () => {
  // Clean JSON
  const rawClean = JSON.stringify({ overview: "Test", number: 42 });
  assert.deepEqual(extractJsonObject(rawClean), { overview: "Test", number: 42 });

  // Markdown code fence wrapped
  const markdownWrapped = "```json\n" + JSON.stringify({ answer: "Yes", foundInTranscript: true }) + "\n```";
  assert.deepEqual(extractJsonObject(markdownWrapped), { answer: "Yes", foundInTranscript: true });

  // With <think> reasoning tokens from reasoning models
  const reasoningWithJson = "<think>\nLet me think step by step.\nThe question is about virtual memory.\n</think>\n" +
    JSON.stringify({ answer: "Virtual memory uses paging.", foundInTranscript: true });
  assert.deepEqual(extractJsonObject(reasoningWithJson), { answer: "Virtual memory uses paging.", foundInTranscript: true });

  // Outermost object with conversational preamble and suffix
  const surrounded = "Here is the response:\n" + JSON.stringify({ status: "ok" }) + "\nHope that helps!";
  assert.deepEqual(extractJsonObject(surrounded), { status: "ok" });

  // Invalid JSON
  assert.throws(() => extractJsonObject("not a json at all"), (err) => {
    return err instanceof LectureLensAiError && err.code === "AI_INVALID_FORMAT";
  });
});

test("getAiCacheKey produces consistent SHA-256 keys", () => {
  const key1 = getAiCacheKey("study-notes", { title: "OS", transcript: "Paging" });
  const key2 = getAiCacheKey("study-notes", { title: "OS", transcript: "Paging" });
  const key3 = getAiCacheKey("study-notes", { title: "OS", transcript: "Different" });

  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
  assert.ok(key1.startsWith("study-notes:"));
});

test("API Endpoints validation and behavior with mock provider", async (t) => {
  // Start express server on random port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const upload = (filename: string, bytes: string | Uint8Array, contentType = "application/octet-stream") => {
    const form = new FormData();
    const blobBody: string | ArrayBuffer = typeof bytes === "string" ? bytes : Uint8Array.from(bytes).buffer as ArrayBuffer;
    form.append("file", new Blob([blobBody], { type: contentType }), filename);
    return form;
  };

  t.after(() => {
    server.close();
  });

  await t.test("POST /study-notes returns 400 for empty transcript", async () => {
    const res = await fetch(`${baseUrl}/study-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "   " }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string };
    assert.equal(body.code, "INVALID_TRANSCRIPT");
  });

  await t.test("POST /quiz returns 400 for empty transcript", async () => {
    const res = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string };
    assert.equal(body.code, "INVALID_TRANSCRIPT");
  });

  await t.test("POST /ask returns 400 for empty question", async () => {
    const res = await fetch(`${baseUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string };
    assert.equal(body.code, "INVALID_QUESTION");
  });

  await t.test("POST /extract-text extracts TXT content regardless of claimed MIME type", async () => {
    const text = "A readable lecture transcript with more than a few words.";
    const res = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("lecture.TXT", text, "application/octet-stream"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { filename: string; fileType: string; textLength: number; text: string };
    assert.equal(body.filename, "lecture.TXT");
    assert.equal(body.fileType, "TXT Document");
    assert.equal(body.text, text);
    assert.equal(body.textLength, text.length);
  });

  await t.test("POST /extract-text rejects missing, unsupported, and empty files", async () => {
    const missing = await fetch(`${baseUrl}/extract-text`, { method: "POST", body: new FormData() });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json() as { code: string }).code, "NO_FILE_UPLOADED");

    const unsupported = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("notes.exe", "Not a supported material type.", "text/plain"),
    });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json() as { code: string }).code, "EXTRACTION_FAILED");

    const empty = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("empty.txt", new Uint8Array()),
    });
    assert.equal(empty.status, 400);
    assert.match((await empty.json() as { error: string }).error, /empty/i);

    const emptyPdf = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("empty.pdf", new Uint8Array(), "application/pdf"),
    });
    assert.equal(emptyPdf.status, 400);
    assert.match((await emptyPdf.json() as { error: string }).error, /empty/i);
  });

  await t.test("POST /extract-text enforces the 15 MB limit", async () => {
    const overLimit = new Uint8Array(15 * 1024 * 1024 + 1);
    const res = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("large.txt", overLimit),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json() as { code: string }).code, "FILE_TOO_LARGE");
  });

  await t.test("POST /extract-text extracts readable PDF and DOCX content", async () => {
    const pdfText = "PDF extraction confirms readable lecture material.";
    const pdfRes = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("lecture.pdf", createMinimalPdf(pdfText), "application/pdf"),
    });
    assert.equal(pdfRes.status, 200);
    const pdfResult = await pdfRes.json() as { fileType: string; text: string };
    assert.equal(pdfResult.fileType, "PDF Document");
    assert.ok(pdfResult.text.includes(pdfText));

    const docxText = "DOCX extraction confirms readable lecture material.";
    const docxBuffer = createStoredZip([
      ["[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"],
      ["_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"],
      ["word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${docxText}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`],
    ]);
    const docxRes = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("lecture.docx", docxBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    });
    assert.equal(docxRes.status, 200);
    const docxResult = await docxRes.json() as { fileType: string; text: string };
    assert.equal(docxResult.fileType, "Word Document (.docx)");
    assert.ok(docxResult.text.includes(docxText));
  });

  await t.test("POST /extract-text explains when a PDF has no readable text", async () => {
    const res = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("scanned.pdf", createMinimalPdf("", true), "application/pdf"),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; code: string };
    assert.equal(body.code, "EXTRACTION_FAILED");
    assert.match(body.error, /no readable text|OCR/i);
  });

  await t.test("POST /extract-text returns useful errors for malformed PDF and DOCX data", async () => {
    const malformedPdf = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("broken.pdf", "%PDF-1.7\nnot a valid PDF", "application/pdf"),
    });
    assert.equal(malformedPdf.status, 400);
    const malformedPdfBody = await malformedPdf.json() as { code: string; error: string };
    assert.equal(malformedPdfBody.code, "EXTRACTION_FAILED");
    assert.match(malformedPdfBody.error, /Could not parse PDF|valid PDF signature/i);

    const malformedDocx = await fetch(`${baseUrl}/extract-text`, {
      method: "POST",
      body: upload("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])),
    });
    assert.equal(malformedDocx.status, 400);
    assert.match((await malformedDocx.json() as { error: string }).error, /Word Document|DOCX/i);
  });

  await t.test("POST /study-notes returns 503 when GROQ_API_KEY is not configured", async () => {
    const origKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    clearAiCache();

    const res = await fetch(`${baseUrl}/study-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: REALISTIC_LECTURE_TRANSCRIPT }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { code: string; error: string };
    assert.equal(body.code, "AI_NOT_CONFIGURED");
    assert.ok(body.error.includes("GROQ_API_KEY"));

    if (origKey) process.env.GROQ_API_KEY = origKey;
  });
});

test("Realistic mock integration test verifying Notes, Quiz, and Ask schemas and caching", async (t) => {
  // Set up a mock Groq HTTP server
  let mockCallCount = 0;
  let lastRequestBody: Record<string, unknown> | null = null;
  let returnStatus = 200;
  let returnPayload: unknown | ((callCount: number) => unknown) = null;
  let returnHeaders: Record<string, string> = { "Content-Type": "application/json" };

  const mockGroqServer = http.createServer(async (req, res) => {
    mockCallCount++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    if (bodyText) {
      lastRequestBody = JSON.parse(bodyText);
    }

    for (const [k, v] of Object.entries(returnHeaders)) {
      res.setHeader(k, v);
    }
    res.statusCode = returnStatus;
    res.end(JSON.stringify(typeof returnPayload === "function" ? returnPayload(mockCallCount) : returnPayload));
  });

  await new Promise<void>((resolve) => mockGroqServer.listen(0, resolve));
  const mockAddress = mockGroqServer.address() as { port: number };
  const mockGroqUrl = `http://127.0.0.1:${mockAddress.port}/openai/v1/chat/completions`;

  // Start app server
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  // Mock global fetch for Groq API
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    if (urlStr.startsWith("https://api.groq.com/openai/v1/chat/completions")) {
      return originalFetch(mockGroqUrl, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  process.env.GROQ_API_KEY = "gsk_test_mock_key_12345";
  process.env.GROQ_MODEL = "openai/gpt-oss-20b";
  clearAiCache();

  t.after(() => {
    globalThis.fetch = originalFetch;
    mockGroqServer.close();
    server.close();
  });

  // 1. Test Study Notes with realistic transcript
  await t.test("Study Notes generation with realistic transcript", async () => {
    clearAiCache();
    mockCallCount = 0;
    returnStatus = 200;
    returnPayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              overview: "This lecture covers operating systems and virtual memory.",
              topics: [
                {
                  title: "Virtual Memory Architecture",
                  notes: ["Abstracts physical RAM into virtual pages.", "Managed by the MMU hardware."],
                },
                {
                  title: "Page Faults & Handling",
                  notes: ["Page faults are hardware interrupts.", "OS swaps missing pages from disk."],
                },
              ],
              keyConcepts: [
                { term: "MMU", definition: "Memory Management Unit translates virtual to physical addresses." },
                { term: "Page Fault", definition: "Interrupt triggered when a page is not present in RAM." },
              ],
              takeaways: ["Virtual memory gives programs an illusion of contiguous RAM.", "Page tables map pages to frames."],
              quickRevision: "Virtual memory uses pages, frames, and page tables to manage physical RAM safely.",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 350, completion_tokens: 180, total_tokens: 530 },
    };

    const res = await fetch(`${baseUrl}/study-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Operating Systems — Virtual Memory",
        transcript: REALISTIC_LECTURE_TRANSCRIPT,
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(mockCallCount, 1);
    assert.ok(res.headers.has("server-timing"));

    const data = await res.json() as Record<string, unknown>;
    assert.ok(data.overview);
    assert.ok(Array.isArray(data.topics));
    assert.ok(Array.isArray(data.keyConcepts));
    assert.ok(Array.isArray(data.takeaways));
    assert.ok(data.quickRevision);

    // Verify token limits and reasoning_format were sent to Groq
    assert.ok(lastRequestBody);
    assert.equal(lastRequestBody.max_tokens, 2500);
    assert.equal(lastRequestBody.reasoning_format, "parsed");
    assert.deepEqual(lastRequestBody.response_format, { type: "json_object" });

    // 2. Test Cache Reuse (submitting identical request should hit cache and NOT call provider)
    const cachedRes = await fetch(`${baseUrl}/study-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Operating Systems — Virtual Memory",
        transcript: REALISTIC_LECTURE_TRANSCRIPT,
      }),
    });
    assert.equal(cachedRes.status, 200);
    assert.equal(mockCallCount, 1); // Mock call count did NOT increase!
  });

  // 3. Test Quiz generation with realistic transcript
  await t.test("Quiz generation with realistic transcript", async () => {
    mockCallCount = 0;
    returnStatus = 200;
    returnPayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              questions: [
                {
                  question: "What is the typical size of a memory page?",
                  options: ["512 bytes", "4 kilobytes", "64 kilobytes", "1 megabyte"],
                  correctIndex: 1,
                  explanation: "Modern architectures typically use 4 kilobyte pages.",
                },
                {
                  question: "Which component translates virtual addresses to physical addresses?",
                  options: ["ALU", "GPU", "MMU", "DMA Controller"],
                  correctIndex: 2,
                  explanation: "The Memory Management Unit (MMU) performs address translation.",
                },
                {
                  question: "What event occurs when an accessed page is not in physical RAM?",
                  options: ["Segmentation fault", "Page fault", "Bus error", "Stack overflow"],
                  correctIndex: 1,
                  explanation: "A page fault is raised when a referenced page is not present in RAM.",
                },
                {
                  question: "What does the OS do during a page fault?",
                  options: [
                    "Terminates the program",
                    "Loads the page from backing store into RAM",
                    "Reboots the kernel",
                    "Flushes the instruction cache",
                  ],
                  correctIndex: 1,
                  explanation: "The OS page fault handler retrieves the page from secondary storage.",
                },
                {
                  question: "Which algorithm is commonly used for page replacement?",
                  options: ["Bubble sort", "LRU (Least Recently Used)", "Dijkstra's algorithm", "Binary search"],
                  correctIndex: 1,
                  explanation: "LRU is a standard page replacement strategy.",
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 280, completion_tokens: 220, total_tokens: 500 },
    };

    const res = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Operating Systems — Virtual Memory",
        transcript: REALISTIC_LECTURE_TRANSCRIPT,
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(mockCallCount, 1);
    const data = await res.json() as { questions: unknown[] };
    assert.equal(data.questions.length, 5);
    assert.equal(lastRequestBody?.max_tokens, 1200);
  });

  await t.test("Quiz generation honors requested settings and never reuses a cached quiz", async () => {
    const makeQuestion = (index: number, type: "mcq" | "short_answer") => type === "mcq"
      ? {
          type,
          question: `Generated MCQ ${index + 1}`,
          options: ["A", "B", "C", "D"],
          correctIndex: 1,
          explanation: "Grounded in the lecture.",
        }
      : {
          type,
          question: `Generated short answer ${index + 1}`,
          expectedAnswer: "A concise expected answer.",
          keyPoints: ["Core point"],
          explanation: "Grounded in the lecture.",
        };

    const cases = [
      { questionCount: 10, questionType: "short_answer", difficulty: "hard", types: Array.from({ length: 10 }, () => "short_answer" as const) },
      { questionCount: 15, questionType: "mixed", difficulty: "mixed", types: Array.from({ length: 15 }, (_, index) => index % 2 === 0 ? "mcq" as const : "short_answer" as const) },
      { questionCount: 6, questionType: "mcq", difficulty: "easy", types: Array.from({ length: 6 }, () => "mcq" as const) },
    ];

    for (const settings of cases) {
      mockCallCount = 0;
      returnStatus = 200;
      returnPayload = {
        choices: [{ message: { content: JSON.stringify({
          questions: settings.types.map((type, index) => makeQuestion(index, type)),
        }) } }],
      };

      const requestBody = {
        transcript: REALISTIC_LECTURE_TRANSCRIPT,
        questionCount: settings.questionCount,
        questionType: settings.questionType,
        difficulty: settings.difficulty,
      };
      const res = await fetch(`${baseUrl}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      assert.equal(res.status, 200);
      const data = await res.json() as { questions: Array<{ type: string }> };
      assert.equal(data.questions.length, settings.questionCount);
      assert.deepEqual(new Set(data.questions.map((question) => question.type)), new Set(settings.types));
      assert.equal(mockCallCount, 1);

      const messages = lastRequestBody?.messages as Array<{ role: string; content: string }>;
      const expectedTypeDirective = settings.questionType === "short_answer"
        ? `Generate exactly ${settings.questionCount} short-answer questions.`
        : settings.questionType === "mixed"
          ? `Generate exactly ${settings.questionCount} mixed questions`
          : `Generate exactly ${settings.questionCount} multiple-choice questions.`;
      assert.ok(messages[0].content.includes(expectedTypeDirective));
      const expectedDifficultyDirective = settings.difficulty === "mixed"
        ? "Distribute the difficulty across easy, medium, and challenging questions."
        : `Calibrate the questions specifically for ${settings.difficulty} difficulty.`;
      assert.ok(messages[0].content.includes(expectedDifficultyDirective));

      // Identical inputs must make a new provider request rather than return the previous quiz.
      returnPayload = {
        choices: [{ message: { content: JSON.stringify({
          questions: settings.types.map((type, index) => ({
            ...makeQuestion(index, type),
            question: `Fresh response ${index + 1}`,
          })),
        }) } }],
      };
      const repeatedRes = await fetch(`${baseUrl}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      assert.equal(repeatedRes.status, 200);
      const repeatedData = await repeatedRes.json() as { questions: Array<{ question: string }> };
      assert.equal(mockCallCount, 2);
      assert.equal(repeatedData.questions[0].question, "Fresh response 1");
    }

    mockCallCount = 0;
    returnPayload = (callCount: number) => ({
      choices: [{ message: { content: JSON.stringify({
        questions: [{
          type: "mcq",
          question: callCount === 1 ? "What does the MMU translate?" : "How does the OS respond to a page fault?",
          options: ["A", "B", "C", "D"],
          correctIndex: 1,
          explanation: "Grounded in the lecture.",
        }],
      }) } }],
    });
    const additionalRes = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: REALISTIC_LECTURE_TRANSCRIPT, questionCount: 1, questionType: "mcq", difficulty: "hard", previousQuestions: ["What does the MMU translate?"] }),
    });
    assert.equal(additionalRes.status, 200);
    assert.equal(mockCallCount, 2);
    const additionalData = await additionalRes.json() as { questions: Array<{ question: string }> };
    assert.equal(additionalData.questions[0].question, "How does the OS respond to a page fault?");
    const additionalPrompt = (lastRequestBody?.messages as Array<{ role: string; content: string }>)[1].content;
    assert.match(additionalPrompt, /What does the MMU translate\?/);

    mockCallCount = 0;
    returnPayload = {
      choices: [{ message: { content: JSON.stringify({
        questions: [{ type: "mcq", question: "What does the MMU translate?", options: ["A", "B", "C", "D"], correctIndex: 1, explanation: "Grounded." }],
      }) } }],
    };
    const duplicateRes = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: REALISTIC_LECTURE_TRANSCRIPT, questionCount: 1, previousQuestions: ["What does the MMU translate?"] }),
    });
    assert.equal(duplicateRes.status, 502);
    assert.equal(mockCallCount, 2, "duplicate rejection retries only once");
    const duplicateBody = await duplicateRes.json() as { error: string };
    assert.match(duplicateBody.error, /not support enough distinct questions/);

    mockCallCount = 0;
    returnPayload = {
      choices: [{ message: { content: JSON.stringify({
        questions: Array.from({ length: 5 }, (_, index) => makeQuestion(index, "mcq")),
      }) } }],
    };
    const shortResponse = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: REALISTIC_LECTURE_TRANSCRIPT, questionCount: 10, questionType: "mcq", difficulty: "medium" }),
    });
    assert.equal(shortResponse.status, 502);
    const shortResponseBody = await shortResponse.json() as { error: string };
    assert.match(shortResponseBody.error, /returned 5 questions; 10 were requested/);
  });

  // 4. Test Ask with conversation history and context
  await t.test("Ask tutor with conversation history", async () => {
    mockCallCount = 0;
    returnStatus = 200;
    returnPayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: "The MMU (Memory Management Unit) uses the page table to translate virtual to physical addresses.",
              foundInTranscript: true,
            }),
          },
        },
      ],
    };

    const res = await fetch(`${baseUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Operating Systems — Virtual Memory",
        transcript: REALISTIC_LECTURE_TRANSCRIPT,
        question: "How does the MMU know where physical memory is?",
        conversation: [
          { role: "user", content: "What is virtual memory?" },
          { role: "assistant", content: "Virtual memory provides an abstraction of contiguous memory." },
        ],
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(mockCallCount, 1);
    const data = await res.json() as { answer: string; foundInTranscript: boolean };
    assert.ok(data.answer);
    assert.equal(data.foundInTranscript, true);

    // Verify system prompt contains transcript and user message only contains the question
    const messages = lastRequestBody?.messages as Array<{ role: string; content: string }>;
    assert.ok(messages[0].content.includes("Supporting study context"));
    assert.ok(messages[0].content.includes(REALISTIC_LECTURE_TRANSCRIPT.trim()));
    assert.equal(messages[messages.length - 1].content, "How does the MMU know where physical memory is?");
    assert.equal(lastRequestBody?.max_tokens, 1000);
  });

  // 5. Test Long Transcript (simulating a full 40k-character lecture)
  await t.test("Handling long lecture transcript efficiently", async () => {
    clearAiCache();
    mockCallCount = 0;
    returnStatus = 200;
    returnPayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              overview: "Comprehensive notes for extended lecture.",
              topics: [{ title: "Memory Systems", notes: ["Deep dive into OS memory."] }],
              keyConcepts: [{ term: "Virtual Memory", definition: "Memory management abstraction." }],
              takeaways: ["Scalable memory handling."],
              quickRevision: "Summary of complete lecture.",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 3200, completion_tokens: 150, total_tokens: 3350 },
    };

    const res = await fetch(`${baseUrl}/study-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Long Lecture — Advanced Virtual Memory",
        transcript: LONG_LECTURE_TRANSCRIPT,
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(mockCallCount, 1);
  });

  // 6. Test Rate Limit 429 Handling with Retry-After
  await t.test("Rate limit HTTP 429 response handling and Retry-After header", async () => {
    clearAiCache();
    mockCallCount = 0;
    returnStatus = 429;
    returnHeaders = {
      "Content-Type": "application/json",
      "Retry-After": "10",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "10s",
    };
    returnPayload = {
      error: {
        message: "Rate limit reached for model openai/gpt-oss-20b on tokens per minute (TPM). Please try again in 10s.",
      },
    };

    const res = await fetch(`${baseUrl}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: REALISTIC_LECTURE_TRANSCRIPT,
      }),
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "10");
    const data = await res.json() as { error: string; code: string; retryAfter: number };
    assert.equal(data.code, "AI_RATE_LIMITED");
    assert.equal(data.retryAfter, 10);
    assert.ok(data.error.includes("429"));
  });
});
