/**
 * Text extraction from binary formats (PDF, images).
 * Thin wrappers around unpdf and tesseract.js.
 */

import { extractText } from "unpdf";
import Tesseract from "tesseract.js";

let ocrWorker: Tesseract.Worker | null = null;

async function getOcrWorker(): Promise<Tesseract.Worker> {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker("eng");
  }
  return ocrWorker;
}

/** Extract text content from a PDF buffer. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = new Uint8Array(buffer);
  const result = await extractText(data, { mergePages: true });
  return (result.text as string).trim();
}

/** Extract text from an image buffer via OCR. */
export async function extractImageText(buffer: Buffer): Promise<string> {
  const worker = await getOcrWorker();
  const result = await worker.recognize(buffer);
  return result.data.text.trim();
}

/** Terminate the OCR worker if it was created. Call on shutdown. */
export async function terminateOcrWorker(): Promise<void> {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }
}
