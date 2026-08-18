/**
 * Nocturne Console — Cortex COMPLETE wrapper.
 *
 * Calls SNOWFLAKE.CORTEX.COMPLETE through the existing Snowflake connection.
 * Uses the same connection pool / singleton as nocturne-backend.ts.
 */

import snowflake, {
  type Connection,
  type ConnectionOptions,
} from "snowflake-sdk";

if (typeof window !== "undefined") {
  throw new Error("Cortex COMPLETE may only run on the server.");
}

/* ── Connection (reuses the same config as nocturne-backend) ───────────────── */

let connectionPromise: Promise<Connection> | null = null;

function loadConfig() {
  const account = process.env.SNOWFLAKE_ACCOUNT?.trim();
  const username = process.env.SNOWFLAKE_USER?.trim();
  const token = process.env.SNOWFLAKE_TOKEN?.trim() || null;
  const password = process.env.SNOWFLAKE_PASSWORD?.trim() || null;
  if (!account || !username || (!token && !password)) {
    throw new Error("Snowflake credentials not configured for Cortex.");
  }
  return {
    account,
    username,
    token,
    password,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE?.trim() || "COMPUTE_WH",
    role: process.env.SNOWFLAKE_ROLE?.trim() || "ACCOUNTADMIN",
    database: process.env.SNOWFLAKE_DATABASE?.trim() || "NOCTURNE",
    schema: process.env.SNOWFLAKE_SCHEMA?.trim() || "DASHBOARD",
  };
}

async function getConnection(): Promise<Connection> {
  if (connectionPromise) {
    try {
      const existing = await connectionPromise;
      if (existing.isUp() && (await existing.isValidAsync())) return existing;
    } catch {
      // Recreate below
    }
  }

  connectionPromise = (async () => {
    const config = loadConfig();
    const options: ConnectionOptions = {
      account: config.account,
      username: config.username,
      warehouse: config.warehouse,
      role: config.role,
      database: config.database,
      schema: config.schema,
      application: "NOCTURNE_ASSISTANT",
      timeout: 60_000,
      clientSessionKeepAlive: false,
      fetchAsString: ["Number", "Date"],
      ...(config.token
        ? { authenticator: "PROGRAMMATIC_ACCESS_TOKEN", token: config.token }
        : { password: config.password! }),
    };
    const connection = snowflake.createConnection(options);
    await connection.connectAsync();
    return connection;
  })();

  return connectionPromise;
}

/* ── Cortex COMPLETE call ──────────────────────────────────────────────────── */

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 2048;
const TEMPERATURE = 0;

interface CortexMessage {
  role: string;
  content: string;
}

/**
 * Calls Snowflake Cortex COMPLETE via SQL.
 *
 * The tool-calling protocol is embedded in the system prompt rather than
 * using Cortex's native function-calling (which requires specific model
 * support). The model emits [TOOL_CALL: name(args)] when it needs data.
 */
export async function cortexComplete(
  messages: CortexMessage[],
): Promise<string> {
  const connection = await getConnection();

  // Format messages as a JSON array for the prompt parameter
  const messagesJson = JSON.stringify(messages);

  const sql = `
    SELECT SNOWFLAKE.CORTEX.COMPLETE(
      ?,
      PARSE_JSON(?),
      OBJECT_CONSTRUCT(
        'temperature', ${TEMPERATURE},
        'max_tokens', ${MAX_TOKENS}
      )
    ) AS RESPONSE
  `;

  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      binds: [MODEL, messagesJson],
      fetchAsString: ["Number", "Date"],
      complete: (error, _statement, rows) => {
        if (error) {
          console.error("[cortex-complete] query failed:", error.message);
          // Fallback: return a generic "unavailable" message rather than crash
          resolve(
            "I'm temporarily unable to process your question. The AI service is unavailable. Please try again in a moment.",
          );
          return;
        }

        const resultRow = rows?.[0] as Record<string, unknown> | undefined;
        if (!resultRow?.RESPONSE) {
          resolve(
            "I received an empty response from the AI service. Please try rephrasing your question.",
          );
          return;
        }

        // Cortex COMPLETE returns a VARIANT which snowflake-sdk may deliver as
        // an object or a JSON string depending on fetchAsString settings.
        try {
          const raw = resultRow.RESPONSE;
          let parsed: unknown = raw;

          // If it's a string, parse it
          if (typeof raw === "string") {
            try {
              parsed = JSON.parse(raw);
            } catch {
              // If it's not valid JSON, it's already the plain text answer
              resolve(raw);
              return;
            }
          }

          // Navigate the Cortex COMPLETE response structure
          if (parsed && typeof parsed === "object") {
            const obj = parsed as Record<string, unknown>;

            // Format: { choices: [{ messages: "text" }] }
            if (Array.isArray(obj.choices) && obj.choices.length > 0) {
              const choice = obj.choices[0] as Record<string, unknown>;
              if (typeof choice.messages === "string") {
                resolve(choice.messages);
                return;
              }
              // Format: { choices: [{ message: { content: "text" } }] }
              if (choice.message && typeof choice.message === "object") {
                const msg = choice.message as Record<string, unknown>;
                if (typeof msg.content === "string") {
                  resolve(msg.content);
                  return;
                }
              }
              // Format: { choices: [{ text: "..." }] }
              if (typeof choice.text === "string") {
                resolve(choice.text);
                return;
              }
            }

            // Format: { message: { content: "text" } }
            if (obj.message && typeof obj.message === "object") {
              const msg = obj.message as Record<string, unknown>;
              if (typeof msg.content === "string") {
                resolve(msg.content);
                return;
              }
            }

            // Format: { content: "text" }
            if (typeof obj.content === "string") {
              resolve(obj.content);
              return;
            }

            // Format: { messages: "text" }
            if (typeof obj.messages === "string") {
              resolve(obj.messages);
              return;
            }

            // Last resort: stringify the object for debugging
            console.warn("[cortex-complete] unexpected response shape:", JSON.stringify(obj).slice(0, 500));
            resolve(JSON.stringify(obj));
            return;
          }

          // Primitive value
          resolve(String(parsed));
        } catch (parseError) {
          // If all parsing fails, stringify whatever we got
          resolve(String(resultRow.RESPONSE));
        }
      },
    });
  });
}
