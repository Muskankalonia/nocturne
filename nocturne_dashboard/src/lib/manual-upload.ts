/**
 * Limits and accepted formats for analyst paste-dump uploads, shared by the
 * client form and the route handler that accepts the file.
 *
 * Both ends check, and they check against this one module on purpose. The
 * browser check exists to fail fast and explain itself; the server check is the
 * one that actually holds, because nothing stops a caller posting to
 * /api/manual-uploads directly. Two copies of the rules would eventually
 * disagree, and the failure mode of that is a file the form accepts and the
 * server rejects after the whole body has already been sent.
 */

/**
 * How a file's text gets extracted. The route dispatches on this, so adding a
 * format is a matter of naming its extension and its kind.
 *
 *   text     decoded in-process as UTF-8
 *   html     tags stripped in-process
 *   document parsed by Snowflake AI_PARSE_DOCUMENT (PDF, DOCX, PPTX)
 *   image    read by a Cortex vision model
 */
export type UploadKind = "text" | "html" | "document" | "image";

/**
 * Extension is the only thing trusted to pick a parser.
 *
 * Not the browser-supplied MIME type, which is attacker-controlled and wrong
 * often enough to be useless, and not content sniffing, which would mean
 * deciding what a file is from bytes an adversary chose. An extension that
 * lies produces a failed extraction and a clear error, which is the safe
 * failure.
 */
const EXTENSION_KINDS: Record<string, UploadKind> = {
  // Plain text and text-shaped data.
  ".txt": "text",
  ".md": "text",
  ".csv": "text",
  ".tsv": "text",
  ".log": "text",
  ".json": "text",
  ".yaml": "text",
  ".yml": "text",
  ".eml": "text",

  ".html": "html",
  ".htm": "html",

  ".pdf": "document",
  ".docx": "document",
  ".pptx": "document",

  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".bmp": "image",
  ".tif": "image",
  ".tiff": "image",
};

/**
 * Text and markup stay at the original limit: a paste dump of five megabytes of
 * prose is already a very large one, and raising it mostly raises what a single
 * request can cost downstream.
 *
 * Binary formats get a higher ceiling because the same content costs far more
 * bytes — a phone screenshot of one forum post routinely clears five megabytes
 * while carrying a paragraph of text.
 */
export const MANUAL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const MANUAL_UPLOAD_MAX_BINARY_BYTES = 20 * 1024 * 1024;

export function uploadKindFor(fileName: string): UploadKind | null {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_KINDS[lower.slice(dot)] ?? null;
}

export function maxBytesFor(kind: UploadKind): number {
  return kind === "text" || kind === "html"
    ? MANUAL_UPLOAD_MAX_BYTES
    : MANUAL_UPLOAD_MAX_BINARY_BYTES;
}

/** Every accepted extension, for the file input's `accept` attribute. */
export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_KINDS);

/** Strips the extension for the default title, whatever the format. */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/**
 * Byte counts for people, not for machines: powers of two, at most one decimal,
 * and no trailing ".0". Used in the size-limit copy and in the rejection
 * message, so an analyst who trips the limit sees the same units in both.
 *
 * `mode: "up"` rounds away from zero instead of to nearest. The rejection
 * message needs it: a file one byte over the limit rounds to nearest as "5 MB"
 * and the message then reads "That file is 5 MB. The limit is 5 MB.", which
 * looks like a bug. Rounding up guarantees the reported figure always reads as
 * larger than the limit it is being compared against, at the cost of
 * overstating by at most one display step.
 */
export function formatBytes(bytes: number, mode: "nearest" | "up" = "nearest"): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const round = mode === "up" ? Math.ceil : Math.round;
  const rounded = value < 10 ? round(value * 10) / 10 : round(value);
  return `${rounded} ${units[unit]}`;
}

export const MANUAL_UPLOAD_MAX_LABEL = formatBytes(MANUAL_UPLOAD_MAX_BYTES);
export const MANUAL_UPLOAD_MAX_BINARY_LABEL = formatBytes(
  MANUAL_UPLOAD_MAX_BINARY_BYTES,
);

export interface ManualUploadRejection {
  /** Shown verbatim to the analyst, and returned verbatim by the API. */
  reason: string;
  /** 413 for the size limit, 400 for everything else. */
  status: 400 | 413;
}

/** Null when the file is acceptable, otherwise why it was refused. */
export function manualUploadRejection(file: File): ManualUploadRejection | null {
  const kind = uploadKindFor(file.name);
  if (!kind) {
    return {
      reason:
        "That file type is not supported. Upload text (.txt, .md, .csv, .log), "
        + "a web page (.html), a document (.pdf, .docx, .pptx), or an image "
        + "(.png, .jpg, .webp).",
      status: 400,
    };
  }
  if (file.size < 1) {
    return { reason: "That file is empty.", status: 400 };
  }
  const limit = maxBytesFor(kind);
  if (file.size > limit) {
    return {
      reason:
        `That file is ${formatBytes(file.size, "up")}. `
        + `The limit for this format is ${formatBytes(limit)}.`,
      status: 413,
    };
  }
  return null;
}
