import { describe, expect, it } from "vitest";

import {
  MANUAL_UPLOAD_MAX_BINARY_BYTES,
  MANUAL_UPLOAD_MAX_BYTES,
  MANUAL_UPLOAD_MAX_LABEL,
  formatBytes,
  manualUploadRejection,
  uploadKindFor,
} from "@/lib/manual-upload";

function file(name: string, size: number): File {
  // Content is irrelevant to every rule under test; only name and size are read.
  const handle = new File(["x"], name, { type: "text/plain" });
  Object.defineProperty(handle, "size", { value: size });
  return handle;
}

describe("formatBytes", () => {
  it("leaves sub-kilobyte counts in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up through binary units", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
  });

  it("stops at gigabytes rather than inventing a larger unit", () => {
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GB");
    expect(formatBytes(2048 * 1024 ** 3)).toMatch(/GB$/);
  });

  it("keeps one decimal below ten and drops it above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(15 * 1024 + 512)).toBe("16 KB");
  });

  it("rounds up when asked, so a message never compares a size to itself", () => {
    // One byte over the limit rounds to nearest as "5 MB", making the rejection
    // read "That file is 5 MB. The limit is 5 MB." Rounding up avoids that.
    expect(formatBytes(MANUAL_UPLOAD_MAX_BYTES + 1, "nearest")).toBe("5 MB");
    expect(formatBytes(MANUAL_UPLOAD_MAX_BYTES + 1, "up")).toBe("5.1 MB");
  });
});

describe("manualUploadRejection", () => {
  it("accepts a plain .txt paste dump within the limit", () => {
    expect(manualUploadRejection(file("dump.txt", 2048))).toBeNull();
  });

  it("is case-insensitive about the extension", () => {
    expect(manualUploadRejection(file("DUMP.TXT", 2048))).toBeNull();
  });

  it("accepts the other supported formats", () => {
    for (const name of [
      "dump.md", "notes.csv", "page.html", "report.pdf",
      "brief.docx", "deck.pptx", "screenshot.png", "photo.JPEG",
    ]) {
      expect(manualUploadRejection(file(name, 2048))).toBeNull();
    }
  });

  it("refuses an unsupported extension with a 400", () => {
    const rejection = manualUploadRejection(file("payload.exe", 2048));
    expect(rejection?.status).toBe(400);
    expect(rejection?.reason).toContain("not supported");
  });

  it("refuses a file with no extension at all", () => {
    expect(manualUploadRejection(file("dump", 2048))?.status).toBe(400);
  });

  it("classifies each extension by how it will be parsed", () => {
    expect(uploadKindFor("dump.txt")).toBe("text");
    expect(uploadKindFor("page.HTML")).toBe("html");
    expect(uploadKindFor("report.pdf")).toBe("document");
    expect(uploadKindFor("shot.png")).toBe("image");
    expect(uploadKindFor("payload.exe")).toBeNull();
  });

  it("allows binary formats a larger budget than text", () => {
    // The same byte count is over the limit as text and under it as an image:
    // a screenshot of one forum post routinely clears the text ceiling.
    const overText = MANUAL_UPLOAD_MAX_BYTES + 1;
    expect(manualUploadRejection(file("dump.txt", overText))?.status).toBe(413);
    expect(manualUploadRejection(file("shot.png", overText))).toBeNull();
    expect(
      manualUploadRejection(file("shot.png", MANUAL_UPLOAD_MAX_BINARY_BYTES + 1))
        ?.status,
    ).toBe(413);
  });

  it("refuses an empty file with a 400", () => {
    expect(manualUploadRejection(file("dump.txt", 0))?.status).toBe(400);
  });

  it("refuses an oversized file with a 413 that states both figures", () => {
    const rejection = manualUploadRejection(
      file("dump.txt", MANUAL_UPLOAD_MAX_BYTES + 1),
    );
    expect(rejection?.status).toBe(413);
    expect(rejection?.reason).toBe(
      `That file is 5.1 MB. The limit for this format is ${MANUAL_UPLOAD_MAX_LABEL}.`,
    );
  });

  it("accepts a file exactly at the limit", () => {
    // The check is `>` , so the boundary itself is allowed. Worth pinning:
    // the client and the route share this constant and must agree on it.
    expect(manualUploadRejection(file("dump.txt", MANUAL_UPLOAD_MAX_BYTES))).toBeNull();
  });

  it("labels the limit the same way the rejection message does", () => {
    expect(MANUAL_UPLOAD_MAX_LABEL).toBe("5 MB");
  });
});
