/**
 * Tidebound bug-report Worker (Cloudflare, free tier).
 *
 * POST /report  (multipart/form-data, header X-Report-Key)
 *   fields:
 *     save        (file, gzipped JSON — CURRENT game state)   REQUIRED
 *     lastSave    (file, gzipped JSON — PREVIOUS on-disk save) optional
 *     commands    (text, JSON — player commands since last save) optional
 *     description (text)                                       REQUIRED
 *     meta        (text/json)                                  REQUIRED
 *
 * Flow:
 *   1. gate on X-Report-Key === env.REPORT_KEY
 *   2. parse multipart, pull the parts
 *   3. validate (save present + < 5 MB; description non-empty; meta parses JSON)
 *   4. commit save.json.gz / last_save.json.gz / commands.json under assets/<YYYY-MM-DD>/<uuid>/
 *   5. open an issue (title from META only + body template + labels:["bug-report"])
 *   6. respond 200 {ok,issueNumber,issueUrl}
 *
 * Web/Fetch APIs ONLY (no Node-only globals — no Buffer). Binary parts are read with
 * `(field as File).arrayBuffer()`; base64 of raw bytes via base64Bytes; base64 of UTF-8 text via
 * base64Utf8. No private data (token, save body) ever placed in a URL param.
 */

interface Env {
  REPORT_KEY: string;
  GH_TOKEN: string;
  GH_OWNER: string;
  GH_REPO: string;
}

// Generous per-part byte cap. Gzipped saves are ~22 KB; this leaves enormous headroom while still
// rejecting a runaway upload before it reaches the GitHub Contents API.
const MAX_PART_BYTES = 5 * 1024 * 1024; // 5 MB
const GH_API = "https://api.github.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** UTF-8 text → base64 using Web APIs only (TextEncoder + btoa). For text parts (commands.json). */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return base64Bytes(bytes);
}

/**
 * Raw bytes → base64 using Web APIs only (btoa over a binary string). For BINARY parts: the gzipped
 * save / lastSave arrive as bytes (`arrayBuffer()`), and GitHub's Contents API wants base64 of those
 * exact bytes — NOT base64 of any text decoding (which would corrupt the gzip stream).
 */
function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** GitHub REST headers — token in the header, never the URL. */
function ghHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tidebound-bug-worker",
    "Content-Type": "application/json",
  };
}

/**
 * Escape backtick runs in a log line so a crafted log cannot break out of the fenced code block /
 * inject markdown. Replaces every backtick with a look-alike so no run of ``` can close the fence.
 */
function neutralizeBackticks(s: string): string {
  return s.replace(/`/g, "ˋ"); // MODIFIER LETTER GRAVE ACCENT — visually similar, not a fence char
}

/**
 * Issue title from META ONLY (never the description, which is untrusted free text):
 *   `[Bug] <platform> <appVersion> · <deviceModel> · <utcShort>`
 * utcShort = meta.timestampUtc trimmed to minutes (guarded when missing → "?").
 */
function issueTitle(meta: Record<string, unknown>): string {
  const platform = meta.platform != null ? String(meta.platform) : "?";
  const appVersion = meta.appVersion != null ? String(meta.appVersion) : "?";
  const deviceModel = meta.deviceModel != null ? String(meta.deviceModel) : "?";
  const utcRaw = meta.timestampUtc != null ? String(meta.timestampUtc) : "";
  // "2026-06-29T16:25:47.1234567Z" → "2026-06-29 16:25"
  const utcShort = utcRaw.length >= 16 ? utcRaw.slice(0, 16).replace("T", " ") : "?";
  return `[Bug] ${platform} ${appVersion} · ${deviceModel} · ${utcShort}`;
}

function issueBody(
  description: string,
  saveUrl: string,
  lastSaveUrl: string,
  commandsUrl: string,
  meta: Record<string, unknown>,
): string {
  // description as a blockquote (each line prefixed with "> "). The BODY may still show the
  // description (only the TITLE must not contain it).
  const quoted = description
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  // meta table — every key EXCEPT recentLogs
  const rows: string[] = ["| Field | Value |", "| --- | --- |"];
  for (const key of Object.keys(meta)) {
    if (key === "recentLogs") continue;
    let value = meta[key];
    if (value === null || value === undefined) value = "";
    const cell = String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
    rows.push(`| ${key} | ${cell} |`);
  }
  const metaTable = rows.join("\n");

  // recentLogs → fenced code block (backticks neutralized so logs can't break the fence)
  const logs = Array.isArray(meta.recentLogs) ? (meta.recentLogs as unknown[]) : [];
  const logText = logs
    .map((l) => neutralizeBackticks(String(l)))
    .join("\n");
  const logsBlock = logText.length > 0 ? `\`\`\`\n${logText}\n\`\`\`` : "_(no recent logs)_";

  // Attachment links. The saves are GZIPPED — gunzip them to read the JSON.
  const links: string[] = [];
  if (saveUrl) links.push(`**Current save (gzipped):** [save.json.gz](${saveUrl})`);
  if (lastSaveUrl) links.push(`**Previous save (gzipped):** [last_save.json.gz](${lastSaveUrl})`);
  if (commandsUrl) links.push(`**Player commands since last save:** [commands.json](${commandsUrl})`);
  if (links.length === 0) links.push("_(no attachments)_");

  return [
    "### Description",
    "",
    quoted,
    "",
    "### Attachments",
    "",
    ...links,
    "",
    "> The `.gz` files are gzip-compressed JSON — gunzip them to read.",
    "",
    "<details><summary>Meta</summary>",
    "",
    metaTable,
    "",
    "**Recent logs**",
    "",
    logsBlock,
    "",
    "</details>",
  ].join("\n");
}

/** Read a multipart field as raw bytes, or null when the field is absent / a plain string. */
async function readBytes(form: FormData, name: string): Promise<Uint8Array | null> {
  const field = form.get(name);
  if (!field || typeof field === "string") return null;
  const buf = await (field as File).arrayBuffer();
  return new Uint8Array(buf);
}

/** Commit one file (base64 content) via the GitHub Contents API; returns its download_url ("" on miss). */
async function commitFile(
  env: Env,
  path: string,
  base64Content: string,
  message: string,
): Promise<string> {
  const putUrl = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify({
      message,
      content: base64Content,
      branch: "main",
    }),
  });
  if (!putRes.ok) {
    const detail = await putRes.text();
    console.error("contents PUT failed", path, putRes.status, detail);
    throw new Error(`github returned ${putRes.status}`);
  }
  const putJson = (await putRes.json()) as { content?: { download_url?: string } };
  return putJson.content?.download_url ?? "";
}

async function handleReport(request: Request, env: Env): Promise<Response> {
  // 1. auth gate
  const key = request.headers.get("X-Report-Key");
  if (!key || key !== env.REPORT_KEY) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // 2. parse multipart
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ ok: false, error: "parse: bad multipart body" }, 400);
  }

  const description = String(form.get("description") ?? "");
  const metaRaw = String(form.get("meta") ?? "");
  const commandsRaw = form.get("commands");
  const commandsText = typeof commandsRaw === "string" ? commandsRaw : "";

  // Read the binary save parts (gzipped bytes).
  let saveBytes: Uint8Array | null;
  let lastSaveBytes: Uint8Array | null;
  try {
    saveBytes = await readBytes(form, "save");
    lastSaveBytes = await readBytes(form, "lastSave");
  } catch (err) {
    return json({ ok: false, error: `parse: could not read save parts (${String(err)})` }, 400);
  }

  // 3. validate
  if (!saveBytes) {
    return json({ ok: false, error: "validation: save file missing" }, 400);
  }
  if (saveBytes.length >= MAX_PART_BYTES) {
    return json({ ok: false, error: "validation: save too large" }, 400);
  }
  if (lastSaveBytes && lastSaveBytes.length >= MAX_PART_BYTES) {
    return json({ ok: false, error: "validation: lastSave too large" }, 400);
  }
  if (description.trim().length === 0) {
    return json({ ok: false, error: "validation: description is empty" }, 400);
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metaRaw) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "validation: meta is not valid JSON" }, 400);
  }

  // 4. path prefix
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const prefix = `assets/${today}/${crypto.randomUUID()}/`;

  // 5. commit the attachments via the Contents API. The save bytes are already gzipped — base64 the
  //    RAW bytes (base64Bytes), never a text decode.
  let saveUrl = "";
  let lastSaveUrl = "";
  let commandsUrl = "";
  try {
    saveUrl = await commitFile(
      env,
      `${prefix}save.json.gz`,
      base64Bytes(saveBytes),
      `bug: add current save (gz) for ${today}`,
    );
    if (lastSaveBytes) {
      lastSaveUrl = await commitFile(
        env,
        `${prefix}last_save.json.gz`,
        base64Bytes(lastSaveBytes),
        `bug: add previous save (gz) for ${today}`,
      );
    }
    if (commandsText.trim().length > 0) {
      commandsUrl = await commitFile(
        env,
        `${prefix}commands.json`,
        base64Utf8(commandsText),
        `bug: add command journal for ${today}`,
      );
    }
  } catch (err) {
    console.error("contents commit exception", err);
    return json({ ok: false, error: `contents: ${String(err)}` }, 500);
  }

  // 6. create the issue
  try {
    const issuesUrl = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues`;
    const issueRes = await fetch(issuesUrl, {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({
        title: issueTitle(meta),
        body: issueBody(description, saveUrl, lastSaveUrl, commandsUrl, meta),
        labels: ["bug-report"],
      }),
    });
    if (!issueRes.ok) {
      const detail = await issueRes.text();
      console.error("issues POST failed", issueRes.status, detail);
      return json(
        { ok: false, error: `issues: github returned ${issueRes.status}` },
        500,
      );
    }
    const issueJson = (await issueRes.json()) as { number?: number; html_url?: string };
    // 7. success
    return json({
      ok: true,
      issueNumber: issueJson.number,
      issueUrl: issueJson.html_url,
    });
  } catch (err) {
    console.error("issues POST exception", err);
    return json({ ok: false, error: `issues: ${String(err)}` }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/report") {
      return handleReport(request, env);
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
