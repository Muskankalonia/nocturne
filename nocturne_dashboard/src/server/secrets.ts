import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

if (typeof window !== "undefined") {
  throw new Error("Nocturne secret handling may only run on the server.");
}

/**
 * Authenticated encryption for credentials the console stores on a user's
 * behalf — Jira API tokens, Slack bot tokens.
 *
 * AES-256-GCM rather than plain AES: GCM authenticates the ciphertext, so a
 * value tampered with in the warehouse fails to decrypt instead of silently
 * yielding different bytes. That matters here because the plaintext is fed
 * straight into an outbound HTTP `Authorization` header — a corrupted secret
 * that decrypts to garbage would be sent to Atlassian as if it were real.
 *
 * The key never lives in Snowflake. A warehouse administrator reading
 * INTEGRATION_SETTINGS sees only ciphertext; decryption needs
 * NOCTURNE_SECRET_KEY from the application environment, which is a different
 * blast radius from the database.
 *
 * Stored format is `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version
 * prefix is there so a future key rotation or algorithm change can recognise
 * and migrate old values rather than guessing at them.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

export class SecretConfigError extends Error {}

/**
 * Derives the 32-byte key.
 *
 * A raw 32-byte base64 value is used directly. Anything else is hashed to
 * length, which keeps a hand-typed passphrase working rather than failing at
 * the first save — the alternative is an operator discovering the constraint
 * only when a user clicks Save and gets a 500.
 */
function key(): Buffer {
  const configured = process.env.NOCTURNE_SECRET_KEY?.trim();
  if (!configured) {
    throw new SecretConfigError(
      "NOCTURNE_SECRET_KEY is not set, so integration credentials cannot be "
      + "stored. Generate one with: openssl rand -base64 32",
    );
  }
  if (configured.length < 32) {
    throw new SecretConfigError(
      "NOCTURNE_SECRET_KEY must be at least 32 characters.",
    );
  }

  const decoded = Buffer.from(configured, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(configured, "utf8").digest();
}

/** True when the server is able to store credentials at all. */
export function isSecretStorageConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretConfigError("Stored credential is not in a recognised format.");
  }
  const [, iv, authTag, ciphertext] = parts;

  const decipher = createDecipheriv(
    ALGORITHM,
    key(),
    Buffer.from(iv!, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTag!, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext!, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * What the browser is allowed to see about a stored secret.
 *
 * Enough to recognise which token is saved — the last four characters, the way
 * every payment form shows a card — and nothing that helps reconstruct it. The
 * full value is never sent to a client, not even to the user who typed it.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}

/**
 * Constant-time comparison, for anywhere a stored secret is checked against a
 * presented one. Not used by the settings flow itself, but kept beside the
 * encryption so a future verification path does not reach for `===`.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
