import { NextResponse } from "next/server";

import { ObjectStorageError, downloadObject } from "@/server/gcs";
import {
  API_RESPONSE_HEADERS,
  MONITOR_KEY_PATTERN,
  authenticateRequest,
  badRequest,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";
import { getScreenshot } from "@/server/triage-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ monitorKey: string }>;
}

/**
 * Streams one capture back to the browser.
 *
 * A proxy rather than a redirect to a signed URL, so tenant scope is re-checked
 * on every image load and access ends the moment a session does. The response
 * is marked private and no-store: this is a picture of a dark-web listing, and
 * it should not survive in a CDN, a shared cache, or the browser's disk.
 *
 * `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` are
 * the belt and braces — the bytes come from a page an adversary controls, and
 * neither the browser nor an intermediary should ever be tempted to interpret
 * them as anything but an image.
 */
export async function GET(request: Request, context: RouteContext) {
  const { monitorKey } = await context.params;
  if (!MONITOR_KEY_PATTERN.test(monitorKey)) {
    return badRequest("The requested capture identifier is invalid.");
  }

  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const scoped = resolveWriteScope(
    auth.caller,
    new URL(request.url).searchParams.get("orgId"),
  );
  if (!scoped.ok) return scoped.response;

  try {
    const screenshot = await getScreenshot(scoped.orgId, monitorKey);
    if (!screenshot?.objectUri || screenshot.status !== "captured") {
      return NextResponse.json(
        { error: "No capture is available for that row." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    const object = await downloadObject(screenshot.objectUri);
    if (!object) {
      return NextResponse.json(
        { error: "The capture is recorded but its image is missing." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    return new NextResponse(new Uint8Array(object.bytes), {
      headers: {
        "Content-Type": object.contentType.startsWith("image/")
          ? object.contentType
          : "image/png",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        Vary: "Cookie",
      },
    });
  } catch (error) {
    if (error instanceof ObjectStorageError) {
      return serviceUnavailable(
        "nocturne-screenshot-image",
        "object storage",
        error,
        "The capture store is not reachable from this server.",
      );
    }
    return serviceUnavailable(
      "nocturne-screenshot-image",
      "read",
      error,
      "Loading the capture failed.",
    );
  }
}
