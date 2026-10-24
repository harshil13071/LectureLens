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
  mimetype: string,
  buffer: Buffer,
): Promise<FileExtractionResult> {
  const ext = path.extname(originalName).toLowerCase();
  const safeFilename = path.basename(originalName).slice(0, 120) || "uploaded-document";

  if (!buffer || buffer.length === 0) {
    throw new Error("The uploaded file is empty.");
  }

  let extractedRaw = "";
  let resolvedType = "text/plain";

  if (ext === ".txt" || mimetype.includes("text/plain")) {
    resolvedType = "TXT Document";
    extractedRaw = buffer.toString("utf8");
  } else if (ext === ".pdf" || mimetype.includes("application/pdf")) {
    resolvedType = "PDF Document";
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
  } else if (
    ext === ".docx" ||
    mimetype.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  ) {
    resolvedType = "Word Document (.docx)";
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
      `Unsupported file format (${ext || mimetype}). LectureLens supports .txt, .pdf, and .docx documents.`,
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
