import { executeQuery } from "@/server/nocturne-backend";
import type { UploadKind } from "@/lib/manual-upload";

if (typeof window !== "undefined") {
  throw new Error("Nocturne document extraction may only run on the server.");
}

/**
 * Turns an uploaded file into the plain text the ingestion pipeline expects.
 *
 * Everything downstream of a manual upload — indicator regexes, L2 extraction,
 * claim grounding — reads one field: the page's raw text. So the whole job of
 * supporting PDFs, Word documents and screenshots is to produce that same
 * field, and nothing after this module needs to know a PDF was ever involved.
 *
 * Where the work happens differs by format, and deliberately:
 *
 *   text, html   decoded and stripped in this process. Cheap, no round trip,
 *                and no third party sees the content.
 *   document     Snowflake AI_PARSE_DOCUMENT, reading the object in place from
 *                the uploads stage. LAYOUT mode keeps tables as markdown, which
 *                matters because a paste dump's value is often a table of
 *                fields and counts that reflows into nonsense without it.
 *   image        A Cortex vision model. Classical OCR reads dark-mode forum
 *                screenshots badly, and those are most of what gets pasted.
 *
 * The document and image paths never send bytes through the console: the file
 * is already in GCS, and Snowflake reads it from there.
 */

/** Vision-capable. `claude-sonnet-4-5` returns NULL for image input. */
const VISION_MODEL = "claude-4-sonnet";
const UPLOAD_STAGE = "@NOCTURNE.RAW.GCS_UPLOAD_ORIGINALS_STAGE";

export class ExtractionError extends Error {}

/**
 * Minimal, dependency-free HTML to text.
 *
 * Script and style bodies are dropped whole rather than tag-stripped, because
 * stripping tags out of a <script> leaves its source code behind as prose and
 * the indicator regexes downstream would happily mine it for "credentials".
 */
function htmlToText(html: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level tags become newlines so paragraphs survive as paragraphs.
    .replace(/<\/(p|div|section|article|tr|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (match) => entities[match.toLowerCase()] ?? match)
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** AI_PARSE_DOCUMENT answers `{ content, metadata }`. */
async function parseDocument(stagePath: string): Promise<string> {
  const rows = await executeQuery(
    `SELECT AI_PARSE_DOCUMENT(
       TO_FILE('${UPLOAD_STAGE}', ?),
       OBJECT_CONSTRUCT('mode', 'LAYOUT')
     ) AS PARSED`,
    [stagePath],
  );
  const raw = rows[0]?.PARSED;
  if (!raw) throw new ExtractionError("The document could not be read.");

  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    content?: string;
  };
  const content = parsed.content?.trim();
  if (!content) {
    throw new ExtractionError(
      "No text could be read from that document. If it is a scan, upload it as "
      + "an image instead.",
    );
  }
  return content;
}

/**
 * Transcription prompt for a screenshot.
 *
 * It asks for a verbatim transcription and nothing else. A model asked to
 * "describe" or "summarize" a leak screenshot would paraphrase the very strings
 * — addresses, hashes, record counts — that the indicator extraction exists to
 * find, and the summary would then be treated by every downstream stage as if
 * it were the source page.
 */
const TRANSCRIBE_PROMPT =
  "Transcribe every piece of visible text in this image exactly as it appears, "
  + "preserving line breaks, usernames, timestamps, email addresses, hashes and "
  + "numbers verbatim. Do not summarize, translate, correct, or comment. If the "
  + "image contains a table, keep its rows on separate lines. Output only the "
  + "transcribed text.";

async function transcribeImage(stagePath: string): Promise<string> {
  // The {0} placeholder is required. Without it Cortex silently drops the file
  // and the model answers as though no image were attached, which reads as a
  // model failure rather than a call built wrong.
  const rows = await executeQuery(
    `SELECT AI_COMPLETE(
       ?,
       PROMPT(?, TO_FILE('${UPLOAD_STAGE}', ?))
     ) AS TRANSCRIPT`,
    [VISION_MODEL, `${TRANSCRIBE_PROMPT} {0}`, stagePath],
  );

  const raw = rows[0]?.TRANSCRIPT;
  if (!raw) {
    throw new ExtractionError("The image could not be read by the vision model.");
  }
  // AI_COMPLETE with PROMPT() returns a bare string, JSON-quoted by the driver.
  let text = String(raw).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text) as string;
    } catch {
      // Leave it as-is; the quotes are cosmetic.
    }
  }
  text = text.trim();
  if (!text) {
    throw new ExtractionError("No readable text was found in that image.");
  }
  return text;
}

/**
 * The stage is backed by GCS, which has no change notification, so its
 * directory table does not know about an object uploaded seconds ago. TO_FILE
 * resolves through that directory table, so without this refresh a file that is
 * definitely in the bucket reports as missing.
 */
async function refreshUploadStage(): Promise<void> {
  await executeQuery(`ALTER STAGE NOCTURNE.RAW.GCS_UPLOAD_ORIGINALS_STAGE REFRESH`);
}

export interface ExtractionResult {
  text: string;
  /** How the text was obtained, recorded on the page for provenance. */
  method: "utf8" | "html-strip" | "ai-parse-document" | "vision-transcription";
}

/**
 * Extracts the text for one upload.
 *
 * `stagePath` is the object's path relative to the uploads stage, and is only
 * consulted for the formats that need Snowflake to read the file. It is built
 * by the route from an identifier the route generated, never from the uploaded
 * file's own name.
 */
export async function extractUploadText(input: {
  kind: UploadKind;
  bytes: Buffer;
  stagePath: string;
}): Promise<ExtractionResult> {
  switch (input.kind) {
    case "text":
      return { text: input.bytes.toString("utf8"), method: "utf8" };

    case "html":
      return {
        text: htmlToText(input.bytes.toString("utf8")),
        method: "html-strip",
      };

    case "document":
      await refreshUploadStage();
      return {
        text: await parseDocument(input.stagePath),
        method: "ai-parse-document",
      };

    case "image":
      await refreshUploadStage();
      return {
        text: await transcribeImage(input.stagePath),
        method: "vision-transcription",
      };
  }
}
