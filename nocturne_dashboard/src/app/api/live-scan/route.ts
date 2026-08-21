import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import type { LiveScanListResponse, LiveScanStartResponse } from "@/lib/live-scan";
import { organizations, users } from "@/mocks/organizations";
import type { User } from "@/types";
import {
  CrawlerApiError,
  CrawlerConfigError,
  listCrawlerExecutions,
  startCrawlerRun,
} from "@/server/crawler-job";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store", Vary: "Cookie" };
const DEMO_ORG_ID = "demo_org";
const ORG_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Stops a double-click from spending two crawls. Short, because the real guard
 * is the already-running check below — this one only covers the window between
 * `jobs:run` returning and the new execution becoming visible to `list`.
 */
const COOLDOWN_MS = 20_000;
let lastRunAt = 0;

function unauthorized() {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}

/**
 * A live crawl spends shared Cloud Run/Tor resources, so it is fleet-admin
 * only. The run itself is still scoped to one selected organization; we pass
 * ORG_ID/QUERY/KEYWORDS into the Cloud Run Job so the crawler never fans out
 * across tenants during an on-demand demo.
 */
/**
 * Authenticates the caller and reports who they are.
 *
 * A live leak scan used to be fleet-administrator only. That was the wrong
 * boundary: the scan sweeps one organization's own keywords and writes into
 * that organization's own pipeline, so the person with the strongest reason to
 * run it is the analyst who owns the tenant. What actually needs guarding is
 * *which* organization a caller may scan and whose logs they may read, and that
 * is enforced per request below rather than by withholding the feature.
 */
async function authenticateCaller(): Promise<
  { ok: true; user: User } | { ok: false; response: NextResponse }
> {
  const cookieStore = await cookies();
  let verified;
  try {
    verified = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Server session configuration is unavailable." },
        { status: 500, headers: RESPONSE_HEADERS },
      ),
    };
  }
  if (!verified) return { ok: false, response: unauthorized() };

  const user = users.find((candidate) => candidate.username === verified.username);
  if (!user || user.role !== verified.role || user.orgId !== verified.orgId) {
    return { ok: false, response: unauthorized() };
  }
  return { ok: true, user };
}

function uniqueList(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function crawlerOptionsForOrg(orgId: string) {
  if (!ORG_ID_PATTERN.test(orgId)) {
    return { ok: false as const, error: "Select a valid organization before starting a scan." };
  }
  if (orgId === DEMO_ORG_ID) {
    return {
      ok: false as const,
      error: "Demo Organization is sample data. Select Odido or European Commission before starting a live leak scan.",
    };
  }

  const organization = organizations.find((candidate) => candidate.orgId === orgId);
  if (!organization || !organization.enabled) {
    return {
      ok: false as const,
      error: "Select an enabled monitored organization before starting a live leak scan.",
    };
  }

  const leakTerms = [
    "leak",
    "breach",
    "credentials",
    "credential",
    "password",
    "passwords",
    "dump",
    "database",
    "customer",
    "employee",
    "access",
    "sale",
    "ransom",
    "escrow",
  ];
  const targetTerms = uniqueList([
    organization.canonicalName,
    ...organization.aliases,
    ...organization.domains,
    ...organization.products,
  ]);

  return {
    ok: true as const,
    organization,
    options: {
      orgId: organization.orgId,
      query: `"${organization.canonicalName}"`,
      keywords: uniqueList([...targetTerms, ...leakTerms]),
    },
  };
}

function failure(error: unknown, fallback: string) {
  console.error(
    "[nocturne-live-scan] failed:",
    error instanceof Error ? error.message : "unknown server error",
  );
  // Same split the upload route makes: a misconfigured server needs an
  // administrator, an unreachable one needs patience, and telling an analyst to
  // retry a missing IAM binding wastes everybody's afternoon.
  if (error instanceof CrawlerConfigError) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
  if (error instanceof CrawlerApiError && error.status === 400) {
    return NextResponse.json(
      { error: "Not a valid crawler execution." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }
  return NextResponse.json(
    { error: fallback },
    { status: 503, headers: RESPONSE_HEADERS },
  );
}

export async function POST(request: Request) {
  const auth = await authenticateCaller();
  if (!auth.ok) return auth.response;

  let payload: { orgId?: unknown } = {};
  try {
    payload = (await request.json()) as { orgId?: unknown };
  } catch {
    payload = {};
  }

  const requestedOrgId = typeof payload.orgId === "string" ? payload.orgId.trim() : "";

  // Tenant isolation for the start action.
  //
  // A super admin has no organization of their own, so they must name the one
  // they are scanning. An organization user's is fixed by their session and the
  // body is checked against it rather than trusted — otherwise opening this
  // feature would let any tenant start a crawl, and spend a warehouse, against
  // another tenant's keywords.
  const orgId = auth.user.role === "SUPER_ADMIN" ? requestedOrgId : auth.user.orgId ?? "";
  if (auth.user.role !== "SUPER_ADMIN" && requestedOrgId && requestedOrgId !== orgId) {
    return NextResponse.json(
      { error: "You can only scan your own organization." },
      { status: 403, headers: RESPONSE_HEADERS },
    );
  }

  const crawlerOptions = crawlerOptionsForOrg(orgId);
  if (!crawlerOptions.ok) {
    return NextResponse.json(
      { error: crawlerOptions.error },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const now = Date.now();
  const waited = now - lastRunAt;
  if (waited < COOLDOWN_MS) {
    return NextResponse.json(
      { error: `A scan was just started. Wait ${Math.ceil((COOLDOWN_MS - waited) / 1000)}s.` },
      { status: 429, headers: RESPONSE_HEADERS },
    );
  }

  try {
    // One crawl at a time. Two concurrent Tor crawls fight over exit capacity
    // and produce two partial batches instead of one good one, so an analyst
    // who asks for a second scan gets attached to the one already running
    // rather than told "no".
    const running = (await listCrawlerExecutions(5)).find(
      (execution) => execution.state === "running" || execution.state === "pending",
    );
    if (running) {
      const response: LiveScanStartResponse = {
        executionId: running.executionId,
        statusUrl: `/api/live-scan/${running.executionId}`,
        message: `A live scan is already running. Showing that run before starting ${crawlerOptions.organization.canonicalName}.`,
      };
      return NextResponse.json(response, { status: 200, headers: RESPONSE_HEADERS });
    }

    lastRunAt = now;
    const execution = await startCrawlerRun(crawlerOptions.options);
    const response: LiveScanStartResponse = {
      executionId: execution.executionId,
      statusUrl: `/api/live-scan/${execution.executionId}`,
      message: `Live leak scan started for ${crawlerOptions.organization.canonicalName}. Tor takes about 90 seconds to bootstrap.`,
    };
    return NextResponse.json(response, { status: 202, headers: RESPONSE_HEADERS });
  } catch (error) {
    lastRunAt = 0; // a start that failed should not hold the cooldown
    return failure(error, "Could not start the live leak scan.");
  }
}

export async function GET() {
  const auth = await authenticateCaller();
  if (!auth.ok) return auth.response;

  try {
    const all = await listCrawlerExecutions(8);
    // An organization user sees only runs of their own organization. Scheduled
    // fleet sweeps carry no ORG_ID and are withheld entirely: they cover every
    // tenant, so their very existence and timing is fleet information.
    const executions =
      auth.user.role === "SUPER_ADMIN"
        ? all
        : all.filter((execution) => execution.orgId === auth.user.orgId);

    const response: LiveScanListResponse = {
      executions,
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(response, { headers: RESPONSE_HEADERS });
  } catch (error) {
    return failure(error, "Live scan history is temporarily unavailable.");
  }
}
