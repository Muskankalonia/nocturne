/**
 * Cloud Run Jobs + Cloud Logging client for the dark-web crawler.
 *
 * The crawler is not part of this application. It is a separate container
 * (`nocturne-crawler`) that runs a Tor browser for anywhere between fifteen
 * minutes and two hours, normally kicked by a twelve-hourly Cloud Scheduler job.
 * This module is the console's read/write handle on it: start one, ask how it is
 * doing, and pull its stdout.
 *
 * Everything here talks to the REST APIs directly rather than pulling in
 * @google-cloud/run and @google-cloud/logging. Those two packages add ~40 MB to
 * an image that runs on a 1 GiB Cloud Run instance, to save perhaps sixty lines
 * of fetch. The credential is the one the rest of the server already uses.
 */

import { applicationDefault } from "firebase-admin/app";

import {
  type LiveScanExecution,
  type LiveScanExecutionState,
  type LiveScanLogLine,
  stageForLogLine,
  toneForLogLine,
} from "@/lib/live-scan";

/**
 * A deployment problem rather than a runtime one — a missing project id, an
 * absent credential, or a service account without access to the job. Retrying
 * never fixes any of them, so the routes answer 500 and name the cause instead
 * of 503 and "try again".
 */
export class CrawlerConfigError extends Error {}

/** Cloud Run refused the call itself: quota, a concurrent run, a bad region. */
export class CrawlerApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Execution ids are Cloud Run generated: job name plus a five-character suffix. */
const EXECUTION_ID_PATTERN = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * How far back an un-cursored log fetch reaches. Comfortably wider than the
 * span of executions Cloud Run still lists, so replaying an old run from the
 * history panel finds its output rather than an empty console.
 */
const LOG_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * RFC3339 with optional sub-second precision, as Cloud Logging emits it. Used
 * to admit a caller's cursor into a filter expression unmodified — anything
 * that does not match this exactly is discarded rather than sanitized.
 */
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

interface CrawlerTarget {
  projectId: string;
  region: string;
  job: string;
}

function crawlerTarget(): CrawlerTarget {
  const projectId =
    process.env.NOCTURNE_CRAWLER_PROJECT?.trim()
    || process.env.FIREBASE_PROJECT_ID?.trim()
    || process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) {
    throw new CrawlerConfigError(
      "This server has no Google Cloud project configured for the crawler. Set "
      + "NOCTURNE_CRAWLER_PROJECT or FIREBASE_PROJECT_ID.",
    );
  }
  return {
    projectId,
    // The crawler lives in us-central1 while the console runs in
    // asia-southeast1. Deliberately not defaulted to the console's own region:
    // that would produce a 404 that reads like a deleted job.
    region: process.env.NOCTURNE_CRAWLER_REGION?.trim() || "us-central1",
    job: process.env.NOCTURNE_CRAWLER_JOB?.trim() || "nocturne-crawler",
  };
}

async function accessToken(): Promise<string> {
  let token;
  try {
    token = await applicationDefault().getAccessToken();
  } catch (error) {
    throw new CrawlerConfigError(
      "This server could not obtain Google credentials for the crawler job. "
      + `Application Default Credentials are missing or expired (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    );
  }
  if (!token.access_token) {
    throw new CrawlerConfigError(
      "Google Application Default Credentials returned no access token.",
    );
  }
  return token.access_token;
}

async function callGoogleApi<T>(
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; quotaProject?: string },
): Promise<T> {
  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      /**
       * Bill quota to our own project.
       *
       * Without this, user-issued Application Default Credentials — what a
       * developer running `next dev` has — carry no quota project, and Google
       * charges the call to its shared anonymous consumer (project number
       * 764086051850) whose Cloud Logging read limit is a handful of requests
       * per minute. Observed: the third poll of a run returned
       * RESOURCE_EXHAUSTED and the log stream died. On Cloud Run the metadata
       * credential already attributes correctly, so this header only ever
       * confirms what is already true there.
       */
      ...(init.quotaProject ? { "x-goog-user-project": init.quotaProject } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 403 here is almost always the runtime service account missing
    // roles/run.invoker on the job or roles/logging.viewer on the project, and
    // that is worth saying out loud rather than leaving as "forbidden".
    if (response.status === 403) {
      throw new CrawlerConfigError(
        "This server is not authorized to control the crawler job. Grant the "
        + "runtime service account roles/run.invoker on the job and "
        + "roles/logging.viewer on the project.",
      );
    }
    throw new CrawlerApiError(
      `Google API call failed with ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

/** The trailing segment of a `projects/…/executions/<id>` resource name. */
function executionIdFromName(name: string | undefined): string | null {
  if (!name) return null;
  const id = name.split("/").pop() ?? "";
  return EXECUTION_ID_PATTERN.test(id) ? id : null;
}

interface RunExecutionResource {
  name?: string;
  createTime?: string;
  startTime?: string;
  completionTime?: string;
  runningCount?: number;
  succeededCount?: number;
  failedCount?: number;
  cancelledCount?: number;
  logUri?: string;
  conditions?: Array<{
    type?: string;
    state?: string;
    message?: string;
    reason?: string;
  }>;
}

function toLiveScanExecution(resource: RunExecutionResource): LiveScanExecution {
  const executionId = executionIdFromName(resource.name) ?? "";
  const completed = resource.conditions?.find((condition) => condition.type === "Completed");
  const cancelledCount = resource.cancelledCount ?? 0;
  const failedCount = resource.failedCount ?? 0;
  const runningCount = resource.runningCount ?? 0;
  const succeededCount = resource.succeededCount ?? 0;

  let state: LiveScanExecutionState;
  if (cancelledCount > 0) {
    state = "cancelled";
  } else if (completed?.state === "CONDITION_SUCCEEDED") {
    state = "succeeded";
  } else if (completed?.state === "CONDITION_FAILED") {
    state = "failed";
  } else if (runningCount > 0) {
    state = "running";
  } else if (resource.completionTime) {
    // Finished, but no Completed condition either way — treat a task that
    // recorded a success as a success and anything else as a failure rather
    // than leaving it spinning forever in the UI.
    state = succeededCount > 0 ? "succeeded" : "failed";
  } else {
    state = resource.startTime ? "running" : "pending";
  }

  const failureMessage =
    state === "failed" || state === "cancelled"
      ? completed?.message?.slice(0, 300)
        ?? (state === "cancelled" ? "Execution was cancelled." : "Execution failed.")
      : null;

  return {
    executionId,
    state,
    createTime: resource.createTime ?? null,
    startTime: resource.startTime ?? null,
    completionTime: resource.completionTime ?? null,
    runningCount,
    succeededCount,
    failedCount,
    cancelledCount,
    failureMessage,
    logUri: resource.logUri ?? null,
  };
}

function jobResourceName({ projectId, region, job }: CrawlerTarget): string {
  return `projects/${projectId}/locations/${region}/jobs/${job}`;
}

/**
 * Start a crawl.
 *
 * `jobs:run` answers with a long-running operation whose metadata is the new
 * Execution. The name is read from there rather than from a follow-up list call:
 * two runs started seconds apart would make "the newest execution" ambiguous,
 * and attaching the log stream to the wrong one is worse than failing.
 */
export async function startCrawlerRun(): Promise<LiveScanExecution> {
  const target = crawlerTarget();
  const operation = await callGoogleApi<{
    name?: string;
    metadata?: RunExecutionResource & { "@type"?: string };
    response?: RunExecutionResource;
    error?: { message?: string };
  }>(`https://run.googleapis.com/v2/${jobResourceName(target)}:run`, {
    method: "POST",
    body: {},
  });

  if (operation.error?.message) {
    throw new CrawlerApiError(`Cloud Run refused the run: ${operation.error.message}`, 502);
  }

  const resource = operation.metadata ?? operation.response;
  const executionId = executionIdFromName(resource?.name);
  if (!executionId) {
    throw new CrawlerApiError(
      "Cloud Run started a run but did not return an execution name.",
      502,
    );
  }
  return toLiveScanExecution({ ...resource, name: resource?.name });
}

/** One execution's current counters and conditions. */
export async function getCrawlerExecution(executionId: string): Promise<LiveScanExecution> {
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new CrawlerApiError("Not a valid execution id.", 400);
  }
  const target = crawlerTarget();
  const resource = await callGoogleApi<RunExecutionResource>(
    `https://run.googleapis.com/v2/${jobResourceName(target)}/executions/${executionId}`,
    { method: "GET" },
  );
  return toLiveScanExecution(resource);
}

/** Recent executions, newest first — the run history panel. */
export async function listCrawlerExecutions(limit = 8): Promise<LiveScanExecution[]> {
  const target = crawlerTarget();
  const pageSize = Math.min(Math.max(limit, 1), 50);
  const result = await callGoogleApi<{ executions?: RunExecutionResource[] }>(
    `https://run.googleapis.com/v2/${jobResourceName(target)}/executions?pageSize=${pageSize}`,
    { method: "GET" },
  );
  return (result.executions ?? [])
    .map(toLiveScanExecution)
    .filter((execution) => execution.executionId.length > 0)
    .sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""));
}

interface LogEntryResource {
  insertId?: string;
  timestamp?: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: { message?: string; [key: string]: unknown };
}

/**
 * Flatten a log entry to one line of text.
 *
 * The crawler prints plain strings, but Tor's own notices and any structured
 * logging arrive as jsonPayload. Falling back to the serialized payload keeps
 * the promise the page makes — every line, nothing hidden — instead of dropping
 * entries the console does not recognise.
 */
function logEntryText(entry: LogEntryResource): string {
  if (typeof entry.textPayload === "string") return entry.textPayload;
  const message = entry.jsonPayload?.message;
  if (typeof message === "string") return message;
  if (entry.jsonPayload) return JSON.stringify(entry.jsonPayload);
  return "";
}

/**
 * Fetch this execution's stdout/stderr.
 *
 * `since` makes the poll incremental: the client hands back the newest timestamp
 * it has and gets only what arrived after it. Cloud Logging's `timestamp >` is
 * exclusive but entries within the same execution can share a timestamp to
 * microsecond precision, so the client also dedupes on insertId — belt and
 * braces, because a dropped log line in a live demo is invisible until someone
 * asks why the rail did not move.
 *
 * Note that Cloud Logging is eventually consistent by a few seconds. A finished
 * execution can still be growing its log tail, which is why the page keeps
 * polling briefly after the run reports terminal.
 */
export async function fetchCrawlerLogs(
  executionId: string,
  options: { since?: string | null; limit?: number } = {},
): Promise<LiveScanLogLine[]> {
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new CrawlerApiError("Not a valid execution id.", 400);
  }
  const target = crawlerTarget();

  const filters = [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${target.job}"`,
    `labels."run.googleapis.com/execution_name"="${executionId}"`,
  ];

  /**
   * A lower bound is mandatory, not an optimization.
   *
   * With no timestamp in the filter, entries:list scopes itself to roughly the
   * last 24 hours. Combined with `orderBy: timestamp asc` that window starts
   * after any older execution already finished, and the call returns zero
   * entries for a run that plainly has logs — verified against a two-day-old
   * execution, which answers 0 ascending and 5 descending. So every request
   * carries an explicit bound: the caller's cursor when polling, and otherwise
   * a lookback wide enough to cover any execution old enough to still be listed.
   *
   * The cursor is validated against RFC3339 and then used verbatim rather than
   * round-tripped through Date. Date only carries milliseconds, and Cloud
   * Logging stamps microseconds: normalizing "…:51.695530Z" to "…:51.695Z"
   * widens the bound just enough to re-include the entry it was supposed to
   * exclude, so that line comes back on every poll and the cursor never
   * advances past it. Verified — the second poll of a finished run returned the
   * same trailing entry indefinitely. The regex is what keeps a query-string
   * value out of the filter expression.
   */
  const since = options.since ?? "";
  if (RFC3339_PATTERN.test(since)) {
    filters.push(`timestamp>"${since}"`);
  } else {
    filters.push(
      `timestamp>="${new Date(Date.now() - LOG_LOOKBACK_MS).toISOString()}"`,
    );
  }

  const result = await callGoogleApi<{ entries?: LogEntryResource[] }>(
    "https://logging.googleapis.com/v2/entries:list",
    {
      method: "POST",
      quotaProject: target.projectId,
      body: {
        resourceNames: [`projects/${target.projectId}`],
        filter: filters.join(" "),
        orderBy: "timestamp asc",
        pageSize: Math.min(Math.max(options.limit ?? 300, 1), 1000),
      },
    },
  );

  return (result.entries ?? [])
    .map((entry, index): LiveScanLogLine | null => {
      const text = logEntryText(entry);
      if (!text.trim()) return null;
      return {
        id: entry.insertId ?? `${entry.timestamp ?? ""}-${index}`,
        timestamp: entry.timestamp ?? "",
        text,
        tone: toneForLogLine(text, entry.severity),
        stage: stageForLogLine(text),
      };
    })
    .filter((line): line is LiveScanLogLine => line !== null);
}
