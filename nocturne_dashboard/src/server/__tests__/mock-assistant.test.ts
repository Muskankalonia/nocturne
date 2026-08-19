import { describe, expect, it } from "vitest";

import { mockAskAssistant } from "@/server/mock-assistant";

/**
 * The mock is what the demo tenant and any un-credentialed environment answer
 * with, so it is on the path judges will actually click. It has to keep the
 * AssistantResponse contract exactly — the drawer reads these fields directly.
 */
describe("mockAskAssistant", () => {
  it("returns a complete AssistantResponse", () => {
    const result = mockAskAssistant("what's my posture?");
    expect(result).toMatchObject({
      answer: expect.any(String),
      citations: [],
      toolsCalled: expect.any(Array),
      latencyMs: expect.any(Number),
    });
    expect(result.suggestedFollowUps).toHaveLength(3);
  });

  it("routes a question to the matching canned answer", () => {
    expect(mockAskAssistant("how many incidents do I have?").toolsCalled).toEqual(["getCommandCenter"]);
    expect(mockAskAssistant("who are the threat actors?").toolsCalled).toEqual(["getThreatActors"]);
    expect(mockAskAssistant("show me the pipeline stages").toolsCalled).toEqual(["getPipeline"]);
    expect(mockAskAssistant("which is the most severe?").toolsCalled).toEqual(["getBreachMonitor"]);
  });

  it("answers a methodology question without claiming a tool ran", () => {
    // Scoring and grounding are explained from product knowledge. Reporting a
    // tool call here would misrepresent where the answer came from.
    expect(mockAskAssistant("how is severity calculated?").toolsCalled).toEqual([]);
    expect(mockAskAssistant("how does evidence grounding work?").toolsCalled).toEqual([]);
    expect(mockAskAssistant("what does corroboration mean?").toolsCalled).toEqual([]);
  });

  it("matches regardless of case", () => {
    expect(mockAskAssistant("WHO ARE THE THREAT ACTORS?").toolsCalled).toEqual(["getThreatActors"]);
  });

  it("takes the first matching pattern when a question spans topics", () => {
    // Patterns are ordered, and the incident-count answer is listed first.
    expect(mockAskAssistant("how many incidents involve threat actors?").toolsCalled)
      .toEqual(["getCommandCenter"]);
  });

  it("falls back to a menu of examples rather than an error", () => {
    const result = mockAskAssistant("what is the airspeed velocity of an unladen swallow?");
    expect(result.answer).toMatch(/I can help you with questions about your breach data/);
    expect(result.toolsCalled).toEqual([]);
    expect(result.suggestedFollowUps).toHaveLength(3);
  });

  it("handles an empty question", () => {
    expect(mockAskAssistant("").suggestedFollowUps).toHaveLength(3);
  });

  it("never emits citations, because nothing was really queried", () => {
    // A citation links to /leaks/{key}. Fabricating one from canned text would
    // send an analyst to an incident that does not exist.
    for (const question of ["how many incidents?", "who are the actors?", "posture"]) {
      expect(mockAskAssistant(question).citations).toEqual([]);
    }
  });

  it("always offers exactly three follow-ups", () => {
    for (const question of [
      "how many breaches", "most severe", "actors", "severity scoring",
      "grounding", "posture", "pipeline", "corroboration", "unmatched",
    ]) {
      expect(mockAskAssistant(question).suggestedFollowUps, question).toHaveLength(3);
    }
  });
});
