import { applicationDefault } from "firebase-admin/app";

if (typeof window !== "undefined") {
  throw new Error("Nocturne object storage access may only run on the server.");
}

/**
 * Minimal read access to Google Cloud Storage.
 *
 * Deliberately not the `@google-cloud/storage` client: the manual-upload route
 * already talks to the JSON API directly with an Application Default
 * Credentials token, and a second SDK for one GET would add a large dependency
 * to say the same thing.
 *
 * There is no signed-URL minting here, and that is the design. V4 signing needs
 * a service-account private key, which Cloud Run's ambient identity does not
 * expose — and a signed URL to a screenshot of a dark-web listing is a bearer
 * token for unmasked source material that outlives the session it was issued
 * in. Images are proxied through an authenticated console route instead, so
 * access is re-checked on every fetch.
 */

export class ObjectStorageError extends Error {}

export function parseGsUri(uri: string): { bucket: string; object: string } | null {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri.trim());
  if (!match) return null;
  return { bucket: match[1]!, object: match[2]! };
}

async function accessToken(): Promise<string> {
  let token;
  try {
    token = await applicationDefault().getAccessToken();
  } catch (error) {
    throw new ObjectStorageError(
      "This server could not obtain Google credentials for object storage. "
      + `Application Default Credentials are missing or expired (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    );
  }
  if (!token.access_token) {
    throw new ObjectStorageError(
      "Google Application Default Credentials returned no access token.",
    );
  }
  return token.access_token;
}

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

/** Downloads one object. Returns null when it is not there. */
export async function downloadObject(gsUri: string): Promise<StoredObject | null> {
  const parsed = parseGsUri(gsUri);
  if (!parsed) throw new ObjectStorageError(`Not a gs:// URI: ${gsUri.slice(0, 80)}`);

  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
      parsed.bucket,
    )}/o/${encodeURIComponent(parsed.object)}?alt=media`,
    { headers: { Authorization: `Bearer ${await accessToken()}` } },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ObjectStorageError(
      `Object storage responded ${response.status}: ${detail.slice(0, 200)}`,
    );
  }

  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}
