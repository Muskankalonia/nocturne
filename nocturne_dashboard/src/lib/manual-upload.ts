/**
 * Limits for analyst paste-dump uploads, shared by the client form and the
 * route handler that accepts the file.
 *
 * Both ends check the size, and they check it against this one constant on
 * purpose. The browser check exists to fail fast and explain itself; the server
 * check is the one that actually holds, because nothing stops a caller posting
 * to /api/manual-uploads directly. Two copies of the number would eventually
 * disagree, and the failure mode of that is a file the form accepts and the
 * server rejects after the whole body has already been sent.
 */

export const MANUAL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

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

export interface ManualUploadRejection {
  /** Shown verbatim to the analyst, and returned verbatim by the API. */
  reason: string;
  /** 413 for the size limit, 400 for everything else. */
  status: 400 | 413;
}

/** Null when the file is acceptable, otherwise why it was refused. */
export function manualUploadRejection(file: File): ManualUploadRejection | null {
  if (!file.name.toLowerCase().endsWith(".txt")) {
    return { reason: "Upload a plain .txt paste dump.", status: 400 };
  }
  if (file.size < 1) {
    return { reason: "That file is empty.", status: 400 };
  }
  if (file.size > MANUAL_UPLOAD_MAX_BYTES) {
    return {
      reason:
        `That file is ${formatBytes(file.size, "up")}. `
        + `The limit is ${MANUAL_UPLOAD_MAX_LABEL}.`,
      status: 413,
    };
  }
  return null;
}
