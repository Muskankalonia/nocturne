import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { applicationDefault } from "firebase-admin/app";
import { cookies } from "next/headers";
import { NextResponse, after } from "next/server";

import {
  manualUploadRejection,
  titleFromFileName,
  uploadKindFor,
} from "@/lib/manual-upload";
import { ExtractionError, extractUploadText } from "@/server/document-text";
import { organizations, users } from "@/mocks/organizations";
import {
  nocturneBackend,
  requestManualUploadIngest,
} from "@/server/nocturne-backend";
import { invalidateQueryCache } from "@/server/query-cache";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { ManualUploadCreateResponse } from "@/types/dashboard";
import type { DataScope } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};
const ORG_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MANUAL_SOURCE = "manual_upload";

/** Stored on the retained original so it is served correctly if ever fetched. */
const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".log": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".eml": "message/rfc822",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function unauthorized() {
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

async function authenticatedScope(
  request: Request,
  formData?: FormData,
): Promise<
  | { ok: true; orgId: string; scope: DataScope }
  | { ok: false; response: NextResponse }
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
  const identityMatches = Boolean(
    user
    && user.role === verified.role
    && user.orgId === verified.orgId,
  );
  if (!user || !identityMatches) return { ok: false, response: unauthorized() };

  const url = new URL(request.url);
  const requestedOrgId = String(
    formData?.get("orgId") ?? url.searchParams.get("orgId") ?? "",
  ).trim();
  const orgId = user.role === "SUPER_ADMIN" ? requestedOrgId : user.orgId ?? "";
  if (!ORG_ID_PATTERN.test(orgId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Choose a valid organization before uploading a paste dump." },
        { status: 400, headers: RESPONSE_HEADERS },
      ),
    };
  }

  const organization = organizations.find(
    (candidate) => candidate.orgId === orgId && candidate.enabled,
  );
  if (!organization) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "The selected organization is not enabled in this console." },
        { status: 404, headers: RESPONSE_HEADERS },
      ),
    };
  }

  return { ok: true, orgId, scope: { kind: "org", orgId } };
}

/**
 * Accepts bytes or a string. A UTF-8 string and its own encoded bytes hash
 * identically, which is what keeps the content hash of a .txt upload the same
 * value it was before binary formats were supported.
 */
function sha256(value: string | Buffer): string {
  return typeof value === "string"
    ? createHash("sha256").update(value, "utf8").digest("hex")
    : createHash("sha256").update(value).digest("hex");
}

function objectPathFromSourceFile(sourceFile: string | null): string {
  if (!sourceFile) return "";
  return sourceFile.startsWith("raw/crawls/")
    ? sourceFile
    : `raw/crawls/${sourceFile}`;
}

function objectUriFromPath(bucket: string | null, objectPath: string): string {
  if (!objectPath) return "";
  return bucket ? `gs://${bucket}/${objectPath}` : objectPath;
}

function safeTitle(value: FormDataEntryValue | null, fallback: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  return title.slice(0, 180) || fallback;
}

/**
 * A deployment problem, not a runtime one: the server is missing a bucket or a
 * credential, and no amount of retrying will help. Kept distinct from the
 * generic failure below so the analyst is told to fetch an administrator rather
 * than told to try again, and so the response carries 500 rather than 503.
 */
class UploadConfigError extends Error {}

function requireBucket(): string {
  const bucket =
    process.env.NOCTURNE_MANUAL_UPLOAD_BUCKET?.trim()
    || process.env.GCS_BUCKET?.trim()
    || process.env.NOCTURNE_BUCKET?.trim();
  if (!bucket) {
    throw new UploadConfigError(
      "This server has no upload bucket configured. Set "
      + "NOCTURNE_MANUAL_UPLOAD_BUCKET, GCS_BUCKET, or NOCTURNE_BUCKET.",
    );
  }
  return bucket;
}

async function accessToken(): Promise<string> {
  let token;
  try {
    token = await applicationDefault().getAccessToken();
  } catch (error) {
    // Almost always absent or expired Application Default Credentials, which
    // reads as a mysterious outage unless it is named.
    throw new UploadConfigError(
      "This server could not obtain Google credentials for the upload bucket. "
      + `Application Default Credentials are missing or expired (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    );
  }
  if (!token.access_token) {
    throw new UploadConfigError(
      "Google Application Default Credentials returned no access token.",
    );
  }
  return token.access_token;
}

async function uploadGcsObject(
  bucket: string,
  objectPath: string,
  payload: Buffer,
  metadata: Record<string, string>,
  contentType = "application/x-ndjson",
): Promise<string> {
  const boundary = `nocturne_${randomUUID()}`;
  const objectMetadata = {
    name: objectPath,
    // Store literal gzip bytes for Snowflake's GZIP file format to decode.
    // Do not set GCS Content-Encoding here: some readers can receive
    // decompressed/transcoded bytes, which makes Snowflake report a gzip
    // decompression error for an otherwise valid .jsonl.gz object.
    contentType,
    metadata,
  };
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
      + `${JSON.stringify(objectMetadata)}\r\n`
      + `--${boundary}\r\n`
      + `Content-Type: ${contentType}\r\n`
      + "\r\n",
      "utf8",
    ),
    payload,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  const response = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
      bucket,
    )}/o?uploadType=multipart&ifGenerationMatch=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GCS upload failed with ${response.status}: ${text.slice(0, 300)}`);
  }
  return `gs://${bucket}/${objectPath}`;
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.clone().formData();
  } catch {
    return NextResponse.json(
      { error: "Submit a multipart form with a file." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const auth = await authenticatedScope(request, formData);
  if (!auth.ok) return auth.response;

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A file is required." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }
  // Same rule the form applies, from the same module. A caller who skips the
  // form still hits it here, which is the check that actually holds.
  const rejection = manualUploadRejection(file);
  if (rejection) {
    return NextResponse.json(
      { error: rejection.reason },
      { status: rejection.status, headers: RESPONSE_HEADERS },
    );
  }

  // The extension decides the parser; manualUploadRejection has already refused
  // anything not on the allowlist, so this cannot be null here.
  const kind = uploadKindFor(file.name)!;
  const bytes = Buffer.from(await file.arrayBuffer());
  const title = safeTitle(formData.get("title"), titleFromFileName(file.name));

  // Hashed over the *original bytes*, not the extracted text.
  //
  // For a .txt file these are the same value, so existing rows keep matching.
  // For everything else the bytes are the stable identity: two runs of a vision
  // model over one screenshot can differ by a character, and hashing the
  // transcript would make the same image look like a new dump every time. It
  // also means the duplicate check below happens before any extraction, so
  // re-uploading a PDF costs nothing.
  const contentSha256 = sha256(bytes);

  try {
    const existingUpload = await nocturneBackend.findManualUploadByContentSha256(
      auth.scope,
      contentSha256,
    );
    if (existingUpload) {
      const objectPath = objectPathFromSourceFile(existingUpload.sourceFile);
      const bucket =
        process.env.NOCTURNE_MANUAL_UPLOAD_BUCKET?.trim()
        || process.env.GCS_BUCKET?.trim()
        || process.env.NOCTURNE_BUCKET?.trim()
        || null;
      const response: ManualUploadCreateResponse = {
        uploadId: existingUpload.uploadId,
        orgId: auth.orgId,
        title: existingUpload.title,
        objectPath,
        objectUri: objectUriFromPath(bucket, objectPath),
        statusUrl: `/api/manual-uploads/${existingUpload.uploadId}`,
        message: "This paste dump was already uploaded; showing the existing run.",
      };
      return NextResponse.json(response, { status: 200, headers: RESPONSE_HEADERS });
    }

    const fetchedAt = new Date().toISOString();
    const crawlDate = fetchedAt.slice(0, 10);
    const uploadId = randomUUID();
    const url = `manual-upload://${uploadId}`;
    const bucket = requireBucket();

    // The original is stored first, and under a name this server generated:
    // the uploaded file name never reaches a path. Snowflake reads the object
    // in place for the formats that need parsing, so the bytes are not sent
    // back through a query.
    //
    // It is also the audit trail. Extraction is lossy and occasionally wrong,
    // and without the original there is no way to check a claim back against
    // what was actually uploaded.
    const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    const originalStagePath = `org_id=${auth.orgId}/${uploadId}${extension}`;
    const originalObjectPath = `uploads/originals/${originalStagePath}`;
    await uploadGcsObject(
      bucket,
      originalObjectPath,
      bytes,
      {
        source: MANUAL_SOURCE,
        org_id: auth.orgId,
        upload_id: uploadId,
        original_filename: file.name.slice(0, 200),
      },
      CONTENT_TYPES[extension] ?? "application/octet-stream",
    );

    let extracted;
    try {
      extracted = await extractUploadText({
        kind,
        bytes,
        stagePath: originalStagePath,
      });
    } catch (extractionError) {
      // The original stays in the bucket on a failed extraction, deliberately:
      // it is the only way to see what could not be read.
      if (extractionError instanceof ExtractionError) {
        return NextResponse.json(
          { error: extractionError.message },
          { status: 422, headers: RESPONSE_HEADERS },
        );
      }
      throw extractionError;
    }
    const rawText = extracted.text;
    if (!rawText.trim()) {
      return NextResponse.json(
        { error: "No text could be read from that file." },
        { status: 422, headers: RESPONSE_HEADERS },
      );
    }
    const docId = sha256([auth.orgId, MANUAL_SOURCE, url, fetchedAt].join("\0"));
    const dedupeKey = sha256([auth.orgId, MANUAL_SOURCE, contentSha256].join("\0"));
    const runId = `manual_${uploadId}`;
    const record = {
      schema_version: 2,
      org_id: auth.orgId,
      doc_id: docId,
      dedupe_key: dedupeKey,
      run_id: runId,
      source: MANUAL_SOURCE,
      query: "manual paste dump",
      url,
      title,
      fetched_at: fetchedAt,
      depth: 0,
      keywords_matched: [],
      links_found: 0,
      content_length: Buffer.byteLength(rawText, "utf8"),
      content_sha256: contentSha256,
      raw_text: rawText,
      // Provenance for the extraction. Additive keys: the ingestion COPY reads
      // named paths out of the VARIANT and ignores anything it was not told
      // about, so older readers are unaffected.
      upload_format: kind,
      extraction_method: extracted.method,
      original_object: `gs://${bucket}/${originalObjectPath}`,
    };
    const gzippedJsonl = gzipSync(`${JSON.stringify(record)}\n`);
    const objectPath =
      `raw/crawls/org_id=${auth.orgId}/crawl_date=${crawlDate}/`
      + `run_id=${runId}/task=manual/attempt=0/part-00000.jsonl.gz`;

    const objectUri = await uploadGcsObject(bucket, objectPath, gzippedJsonl, {
      source: MANUAL_SOURCE,
      org_id: auth.orgId,
      upload_id: uploadId,
    });

    // One-shot manual ingest only: load exactly this uploaded object and leave
    // the crawler schedule exactly as it was. Stream-triggered AI tasks handle
    // new candidates asynchronously after ingest lands the row.
    //
    // Started *after* the response rather than awaited. The COPY and the
    // dynamic-table refreshes behind it take minutes, and holding the request
    // open for them bought nothing: the console already polls this upload's
    // status, on a cadence it slows down specifically while raw ingest is
    // outstanding. `after` is what keeps the work alive past the response on a
    // platform that would otherwise stop the instance once it is sent.
    after(() => {
      requestManualUploadIngest(objectPath);
    });

    // Invalidated now rather than after the COPY. These caches are keyed by
    // scope and expire on their own; the poll re-reads regardless, and holding
    // the response open purely to time a cache eviction would defeat the point.
    invalidateQueryCache("command-center");
    invalidateQueryCache("breach-monitor");
    invalidateQueryCache("pipeline");
    invalidateQueryCache("knowledge-graph");

    const response: ManualUploadCreateResponse = {
      uploadId,
      orgId: auth.orgId,
      title,
      objectPath,
      objectUri,
      statusUrl: `/api/manual-uploads/${uploadId}`,
      message:
        "Paste dump stored. Ingestion is running — this page follows it through "
        + "the pipeline on its own.",
    };
    return NextResponse.json(response, { status: 202, headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-manual-upload] failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    // A misconfigured server and an unreachable one need different answers:
    // retrying fixes the second and never fixes the first. The config text is
    // curated in UploadConfigError rather than echoed from an arbitrary
    // exception, so nothing internal leaks into the response.
    if (error instanceof UploadConfigError) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "Could not upload the paste dump and start ingestion." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

export async function GET(request: Request) {
  const auth = await authenticatedScope(request);
  if (!auth.ok) return auth.response;

  try {
    const response = await nocturneBackend.listManualUploads(auth.scope);
    return NextResponse.json(response, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-manual-upload-list] live query failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Live paste-dump uploads are temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}
