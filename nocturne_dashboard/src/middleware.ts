import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Perimeter allowlist for the deployed console.
 *
 * This is a gate, not a security boundary. The security boundary is the signed
 * session cookie in src/server/session.ts and the server-side tenant check in
 * the API routes. This exists so the Cloud Run deployment is not openly
 * reachable while authentication is still being hardened.
 *
 * Both lists default to empty, which disables the gate entirely. Local `next
 * dev` therefore behaves exactly as it did before; the allowlist only bites
 * once the environment sets it.
 *
 * Addresses may be written as a literal or in CIDR form, IPv4 or IPv6:
 *
 *   203.0.113.7            a single host
 *   203.0.113.0/24         a v4 range
 *   2001:db8:1234:5678::/64    a delegated v6 prefix
 *
 * The CIDR form matters for residential IPv6: privacy extensions rotate the
 * host half of the address, often daily, so pinning a full /128 locks you out
 * the next morning. Allowlist the /64 the ISP delegates instead.
 */

const ALLOW_ALL: unique symbol = Symbol("allow-all");

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const octet = Number(parts[i]);
    if (octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  // Drop any zone index ("%eth0"), which is meaningful only on the local host.
  const addr = value.split("%")[0];
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  // A trailing dotted-quad (::ffff:192.0.2.1) stands in for the final two
  // groups, so fold it back into hex before counting.
  const toGroups = (segment: string): string[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const tail = groups[groups.length - 1];
    if (tail.includes(".")) {
      const v4 = parseIpv4(tail);
      if (!v4) return null;
      groups.pop();
      groups.push((((v4[0] << 8) | v4[1]) >>> 0).toString(16));
      groups.push((((v4[2] << 8) | v4[3]) >>> 0).toString(16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;

  const missing = 8 - (head.length + tail.length);
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const group = parseInt(groups[i], 16);
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function parseIp(value: string): Uint8Array | null {
  const addr = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!addr) return null;

  const bytes = addr.includes(":") ? parseIpv6(addr) : parseIpv4(addr);
  if (!bytes || bytes.length !== 16) return bytes;

  // Treat ::ffff:a.b.c.d as the v4 address it represents, so one v4 rule covers
  // a client whichever way the proxy chose to spell it.
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
}

function matchesRule(address: Uint8Array, rule: string): boolean {
  const slash = rule.lastIndexOf("/");
  const network = parseIp(slash === -1 ? rule : rule.slice(0, slash));
  if (!network || network.length !== address.length) return false;

  const totalBits = network.length * 8;
  let bits = totalBits;
  if (slash !== -1) {
    const declared = Number(rule.slice(slash + 1));
    if (!Number.isInteger(declared) || declared < 0 || declared > totalBits) {
      return false;
    }
    bits = declared;
  }

  const wholeBytes = bits >> 3;
  for (let i = 0; i < wholeBytes; i += 1) {
    if (address[i] !== network[i]) return false;
  }
  const remainder = bits & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (address[wholeBytes] & mask) === (network[wholeBytes] & mask);
}

function hostMatches(host: string, allowed: string[]): boolean {
  // Compare without the port: Cloud Run terminates TLS on 443 but a local
  // container is reached on localhost:8080, and both should be expressible.
  const bare = host.toLowerCase().split(":")[0];
  return allowed.some((entry) => entry.toLowerCase().split(":")[0] === bare);
}

/**
 * Kept in step with SESSION_COOKIE_NAME in src/server/session.ts, and declared
 * here rather than imported: that module pulls in node:crypto and asserts it is
 * never bundled for a browser, neither of which belongs in edge middleware.
 */
const SESSION_COOKIE = "__session";

/** Public routes, plus the prefixes that must never be redirected. */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/start"
    || pathname === "/login"
    || pathname.startsWith("/api/")
    || pathname.startsWith("/_next/")
    || pathname === "/icon.png"
    || pathname === "/favicon.ico"
    || pathname === "/nocturne-mark.png"
  );
}

/**
 * Sends a visitor with no session straight to the landing page.
 *
 * AppShell already does this, but only after the client bundle has loaded and
 * /api/auth/session has answered — which is a blank splash and two round trips
 * before a first-time visitor sees anything. Deciding it here turns that into a
 * single 307 to a statically prerendered page.
 *
 * This checks that the cookie *exists*, not that it is valid, and it is not a
 * security boundary — it cannot be, since verifying the signature needs
 * node:crypto. Anyone can set a junk `__session` and reach the shell; they then
 * hit the real check in AppShell and every API route, and land back here. The
 * boundary is still the signed cookie and the server-side tenant check.
 */
function landingRedirect(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return null;
  if (request.cookies.has(SESSION_COOKIE)) return null;

  const url = request.nextUrl.clone();
  url.pathname = "/start";
  url.search = "";
  return NextResponse.redirect(url, 307);
}

export function middleware(request: NextRequest) {
  // Read env inside the handler rather than at module scope. Middleware is
  // bundled ahead of time, and module-scope reads risk being frozen at build
  // time instead of resolved from the Cloud Run runtime environment.
  const allowedIps = parseList(process.env.NOCTURNE_ALLOWED_IPS);
  const allowedHosts = parseList(process.env.NOCTURNE_ALLOWED_HOSTS);

  const ipGate = allowedIps.length > 0 ? allowedIps : ALLOW_ALL;
  const hostGate = allowedHosts.length > 0 ? allowedHosts : ALLOW_ALL;
  const proxyHops = Number(process.env.NOCTURNE_PROXY_HOPS ?? "0");
  const expectsProxy = Number.isInteger(proxyHops) && proxyHops > 0;

  // The perimeter runs first when it is armed: someone outside the allowlist
  // should be refused, not helpfully redirected to the landing page.
  if (ipGate === ALLOW_ALL && hostGate === ALLOW_ALL && !expectsProxy) {
    return landingRedirect(request) ?? NextResponse.next();
  }

  /**
   * When a proxy is expected in front, a request that arrives with too few
   * forwarded hops did not come through it — it went straight to the Cloud Run
   * URL. Steer those back to the canonical hostname.
   *
   * This is deliberately not load-bearing security: a caller who sets their own
   * X-Forwarded-For can manufacture the missing hop. It cannot be closed
   * without an external load balancer, and it does not need to be — what lies
   * behind it is the same login page the canonical hostname serves, still gated
   * by the session cookie. The check keeps casual traffic on one entry point;
   * it is not a boundary.
   */
  if (expectsProxy) {
    const hops = parseList(request.headers.get("x-forwarded-for") ?? undefined);
    if (hops.length <= proxyHops) {
      console.warn(
        `[perimeter] rejected direct-origin hops=${hops.length} `
        + `path=${request.nextUrl.pathname}`,
      );
      return deny();
    }
  }

  const host = request.headers.get("host") ?? "";
  if (hostGate !== ALLOW_ALL && !hostMatches(host, hostGate)) {
    console.warn(
      `[perimeter] rejected host=${JSON.stringify(host)} path=${request.nextUrl.pathname}`,
    );
    return deny();
  }

  if (ipGate !== ALLOW_ALL) {
    const forwarded = request.headers.get("x-forwarded-for");
    let hops = parseList(forwarded ?? undefined);

    /**
     * Trailing hops contributed by a trusted proxy in front of Cloud Run —
     * Firebase Hosting adds exactly one. Drop them before matching, or the
     * proxy's own address fails the check and locks everyone out.
     *
     * This does not weaken the spoof defence below: what gets dropped is the
     * tail we put there ourselves, and the caller's real address still sits
     * inside the portion that must match.
     */
    const proxyHops = Number(process.env.NOCTURNE_PROXY_HOPS ?? "0");
    if (Number.isInteger(proxyHops) && proxyHops > 0) {
      hops = hops.slice(0, Math.max(hops.length - proxyHops, 0));
    }

    /**
     * Cloud Run appends the real peer address to whatever X-Forwarded-For the
     * client sent, so a caller can prepend an allowed address but cannot remove
     * their own. Requiring *every* hop to match turns that into a dead end: the
     * spoofed value passes, the attacker's own address does not.
     *
     * An empty header means the request did not arrive through the Cloud Run
     * front end at all, so fail closed rather than guess.
     */
    const permitted =
      hops.length > 0 &&
      hops.every((hop) => {
        const address = parseIp(hop);
        return address !== null && ipGate.some((rule) => matchesRule(address, rule));
      });

    if (!permitted) {
      console.warn(
        `[perimeter] rejected xff=${JSON.stringify(forwarded)} path=${request.nextUrl.pathname}`,
      );
      return deny();
    }
  }

  return landingRedirect(request) ?? NextResponse.next();
}

function deny() {
  return new NextResponse("Not available from this network.\n", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const config = {
  // Everything except Next's own build assets. Those carry no data, and
  // exempting them keeps the rejection logs readable when a browser that has
  // already loaded the shell retries a chunk.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
