import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import {
  askAssistant,
  checkAssistantRate,
  type AssistantMessage,
} from "@/server/nlq-assistant";
import { mockAskAssistant } from "@/server/mock-assistant";
import { isDemoScope } from "@/server/demo-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import { clientKey } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_LENGTH = 20;

function invalidSessionResponse() {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  // Parse body
  let body: { message?: string; history?: AssistantMessage[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json(
      {
        error: message
          ? `Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters.`
          : "A non-empty message is required.",
      },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  // Verify session
  const cookieStore = await cookies();
  let verified;
  try {
    verified = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    return NextResponse.json(
      { error: "Server session configuration is unavailable." },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
  if (!verified) return invalidSessionResponse();

  const user = users.find(
    (candidate) => candidate.username === verified.username,
  );
  const identityMatches = Boolean(
    user && user.role === verified.role && user.orgId === verified.orgId,
  );
  if (!user || !identityMatches) return invalidSessionResponse();

  if (user.role === "ORG_USER") {
    const organization = organizations.find(
      (candidate) => candidate.orgId === user.orgId && candidate.enabled,
    );
    if (!organization) return invalidSessionResponse();
  }

  // Rate limit
  const rateLimitKey = `assistant:${verified.username}`;
  const rateCheck = checkAssistantRate(rateLimitKey);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded. Please wait before asking another question.",
        retryAfterMs: rateCheck.retryAfterMs,
      },
      { status: 429, headers: RESPONSE_HEADERS },
    );
  }

  // Validate and bound history
  const history: AssistantMessage[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (msg): msg is AssistantMessage =>
            msg &&
            typeof msg === "object" &&
            (msg.role === "user" || msg.role === "assistant") &&
            typeof msg.content === "string" &&
            msg.content.length <= MAX_QUESTION_LENGTH * 2,
        )
        .slice(-MAX_HISTORY_LENGTH)
    : [];

  // Call assistant — use mock for demo scope, explicit mock mode, or missing credentials
  const snowflakeConfigured = Boolean(
    process.env.SNOWFLAKE_ACCOUNT?.trim() &&
    process.env.SNOWFLAKE_USER?.trim() &&
    (process.env.SNOWFLAKE_TOKEN?.trim() || process.env.SNOWFLAKE_PASSWORD?.trim()),
  );
  const useMock =
    isDemoScope(verified.scope) ||
    process.env.NOCTURNE_DATA_SOURCE === "mock" ||
    !snowflakeConfigured;

  try {
    const result = useMock
      ? mockAskAssistant(message)
      : await askAssistant(message, verified.scope, history);

    // Audit log
    console.info(
      JSON.stringify({
        event: "assistant_query",
        username: verified.username,
        orgId: verified.orgId,
        role: verified.role,
        scope: verified.scope.kind,
        question: message.slice(0, 500),
        toolsCalled: result.toolsCalled,
        latencyMs: result.latencyMs,
        timestamp: new Date().toISOString(),
      }),
    );

    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[assistant-route] query failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      { error: "The assistant is temporarily unavailable. Please try again." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}
