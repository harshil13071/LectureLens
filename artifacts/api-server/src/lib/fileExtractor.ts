import mammoth from "mammoth";
import path from "node:path";

export interface FileExtractionResult {
  filename: string;
  fileType: string;
  textLength: number;
  text: string;
  warning?: string;
}

const MAX_TRANSCRIPT_CHARS = 40_000;

export async function extractTextFromFile(
  originalName: string,
  _mimetype: string,
  buffer: Buffer,
): Promise<FileExtractionResult> {
  const ext = path.extname(originalName).toLowerCase();
  const safeFilename = path.basename(originalName).slice(0, 120) || "uploaded-document";

  if (!buffer || buffer.length === 0) {
    throw new Error("The uploaded file is empty.");
  }

  let extractedRaw = "";
  let resolvedType = "text/plain";

  if (ext === ".txt") {
    resolvedType = "TXT Document";
    try {
      extractedRaw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("This TXT document is not valid UTF-8 text.");
    }
    if (extractedRaw.includes("\0")) {
      throw new Error("This TXT document appears to contain binary data rather than readable text.");
    }
  } else if (ext === ".pdf") {
    resolvedType = "PDF Document";
    const pdfHeader = Buffer.from("%PDF-");
    if (!buffer.subarray(0, 1024).includes(pdfHeader)) {
      throw new Error("This file does not contain a valid PDF signature. Please choose a readable PDF document.");
    }
    try {
      // Load PDF.js only for PDF uploads. This keeps optional canvas initialization
      // failures from preventing the API server from starting.
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      extractedRaw = parsed.text || "";
    } catch (pdfErr) {
      const msg = pdfErr instanceof Error ? pdfErr.message : "Malformed PDF";
      throw new Error(`Could not parse PDF file (${msg}). Please verify the file is not damaged or password-protected.`);
    }

    // Check for scanned PDFs without selectable text
    const stripped = extractedRaw.replace(/\s+/g, "");
    if (stripped.length < 20) {
      throw new Error(
        "This PDF contains no readable text. It appears to be a scanned image or protected document, which requires OCR to extract text.",
      );
    }
  } else if (ext === ".docx") {
    resolvedType = "Word Document (.docx)";
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      throw new Error("This file does not have a valid DOCX document signature.");
    }
    try {
      const result = await mammoth.extractRawText({ buffer });
      extractedRaw = result.value || "";
    } catch (docxErr) {
      const msg = docxErr instanceof Error ? docxErr.message : "Malformed DOCX";
      throw new Error(`Could not read Word document (${msg}). Please ensure it is a valid .docx file.`);
    }

    if (!extractedRaw.trim()) {
      throw new Error("The Word document does not contain readable text.");
    }
  } else {
    throw new Error(
      `Unsupported file format (${ext || _mimetype || "unknown"}). LectureLens supports .txt, .pdf, and .docx documents.`,
    );
  }

  // Clean text: normalize linebreaks and trim whitespace
  let cleanedText = extractedRaw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\0/g, "")
    .trim();

  if (!cleanedText) {
    throw new Error("No readable text could be found in the uploaded file.");
  }

  let warning: string | undefined;
  if (cleanedText.length > MAX_TRANSCRIPT_CHARS) {
    cleanedText = cleanedText.slice(0, MAX_TRANSCRIPT_CHARS);
    warning = `The document exceeds the limit and was trimmed to the first ${MAX_TRANSCRIPT_CHARS.toLocaleString()} characters for optimal study material generation.`;
  }

  return {
    filename: safeFilename,
    fileType: resolvedType,
    textLength: cleanedText.length,
    text: cleanedText,
    warning,
  };
}
