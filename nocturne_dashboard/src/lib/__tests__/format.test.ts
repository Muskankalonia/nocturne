import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDate,
  formatDateTime,
  hostOf,
  initialsFromName,
  highRiskLeakTypes,
  leakTypeLabel,
  relativeTime,
  remediationLabel,
  remediationTone,
  routeLabel,
  routeTone,
  scoreReasonLabel,
  shortHash,
} from "@/lib/format";

describe("hostOf", () => {
  it("returns the hostname of a well-formed URL", () => {
    expect(hostOf("http://abcdefgh.onion/threads/42?x=1")).toBe("abcdefgh.onion");
  });

  it("returns the input unchanged when it does not parse", () => {
    // Callers pass TOP_URL straight from the warehouse, which is not
    // guaranteed to be a URL. Falling back to the raw value keeps a venue
    // chip readable instead of rendering an empty string.
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("shortHash", () => {
  it("elides the middle of a full SHA-256", () => {
    expect(shortHash("a".repeat(64))).toBe(`${"a".repeat(8)}…${"a".repeat(8)}`);
  });

  it("leaves a hash shorter than the elision budget alone", () => {
    // Eliding here would produce a string longer than the input.
    expect(shortHash("abcdef")).toBe("abcdef");
  });

  it("honours custom head and tail widths", () => {
    expect(shortHash("0123456789abcdef", 2, 2)).toBe("01…ef");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString());
  });

  it("distinguishes zero from unknown", () => {
    // "0 records" and "an unknown number of records" are different findings,
    // and a nullish count must never render as the former.
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("unknown");
    expect(formatCount(undefined)).toBe("unknown");
  });
});

describe("formatDate / formatDateTime", () => {
  it("renders an ISO date as a bare day", () => {
    expect(formatDate("2026-08-18T14:32:07.512Z")).toBe("2026-08-18");
  });

  it("renders minute precision in UTC", () => {
    expect(formatDateTime("2026-08-18T14:32:07.512Z")).toBe("2026-08-18 14:32Z");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("collapses anything under a minute", () => {
    expect(relativeTime("2026-08-18T11:59:31.000Z", now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(relativeTime("2026-08-18T11:25:00.000Z", now)).toBe("35 min ago");
    expect(relativeTime("2026-08-18T06:00:00.000Z", now)).toBe("6 h ago");
    expect(relativeTime("2026-08-15T12:00:00.000Z", now)).toBe("3 d ago");
  });

  it("switches unit exactly at the boundary", () => {
    expect(relativeTime("2026-08-18T11:00:00.000Z", now)).toBe("1 h ago");
    expect(relativeTime("2026-08-17T12:00:00.000Z", now)).toBe("1 d ago");
  });
});

describe("initialsFromName", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsFromName("Nitish Kumar")).toBe("NK");
    expect(initialsFromName("ada byron lovelace")).toBe("AB");
  });

  it("strips digits and punctuation before splitting into words", () => {
    // "R2-D2 Unit" loses its digits and hyphen first, leaving the two words
    // "RD" and "Unit" — so the initials are R and U, not R and D.
    expect(initialsFromName("R2-D2 Unit")).toBe("RU");
    expect(initialsFromName("  spaced   out  name ")).toBe("SO");
  });

  it("falls back when a name yields no letters at all", () => {
    // A display name of "1234" would otherwise render an empty avatar.
    expect(initialsFromName("1234", "??")).toBe("??");
    expect(initialsFromName("")).toBe("");
  });
});

describe("label and tone maps", () => {
  it("names every closed enum value it claims to cover", () => {
    expect(leakTypeLabel.credential).toBe("Credentials");
    expect(leakTypeLabel.malware_exploit).toBe("Malware / Exploit");
    expect(routeLabel.target_confirmed).toBe("Confirmed Breach");
  });

  it("tones a failed extraction as critical and an irrelevant route as neutral", () => {
    expect(routeTone.extraction_error).toBe("critical");
    expect(routeTone.not_relevant).toBe("neutral");
    expect(routeTone.ambiguous).toBe("medium");
  });

  it("tones an untouched incident more urgently than a contained one", () => {
    expect(remediationTone.new).toBe("critical");
    expect(remediationTone.contained).toBe("ok");
    expect(remediationTone.suppressed).toBe("neutral");
  });

  it("flags credentials and financial data as the high-risk classes", () => {
    expect(highRiskLeakTypes).toEqual(["credential", "financial"]);
  });

  it("translates score reason codes out of pipeline vocabulary", () => {
    expect(scoreReasonLabel.claim_disputed).toBe("Claim disputed elsewhere");
    expect(remediationLabel.false_positive).toBe("False Positive");
  });
});
