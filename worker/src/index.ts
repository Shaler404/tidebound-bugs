/**
 * Tidebound bug-report Worker (Cloudflare, free tier).
 *
 * POST /report  (multipart/form-data, header X-Report-Key)
 *   fields:
 *     save        (file, gzipped JSON — CURRENT game state)        REQUIRED
 *     lastSave    (file, gzipped JSON — PREVIOUS on-disk save)      optional
 *     commands    (text, JSON — full session timeline: player commands + app
 *                  pause/resume/focus/quit + low-mem + Save markers)            optional
 *     logs        (file, gzipped text — console log ring buffer)    optional
 *     description (text)                                            REQUIRED
 *     meta        (text/json — scalars only, no logs)              REQUIRED
 *
 * Flow:
 *   1. gate on X-Report-Key === env.REPORT_KEY
 *   2. parse multipart, read ALL parts into memory
 *   3. validate (save present + < 5 MB; description non-empty; meta parses JSON)
 *   4. ACK the client immediately ({ ok: true }) — the GitHub round-trip runs in the
 *      background via ctx.waitUntil(fileReport(...)), so the client waits ONLY for the upload.
 *   5. fileReport (background): commit save.json.gz / last_save.json.gz / commands.json /
 *      logs.txt under assets/<YYYY-MM-DD>/<uuid>/ then open an issue. Failures are
 *      swallowed and logged (visible via `wrangler tail`) — the client never learns the issue number.
 *
 * Web/Fetch APIs ONLY (no Node-only globals — no Buffer). Binary parts are read with
 * `(field as File).arrayBuffer()`; gzip is undone with DecompressionStream("gzip"); base64 of raw
 * bytes via base64Bytes; base64 of UTF-8 text via base64Utf8. No private data (token, save body)
 * ever placed in a URL param.
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

/** UTF-8 text → base64 using Web APIs only (TextEncoder + btoa). For text parts (commands.json, logs.txt). */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return base64Bytes(bytes);
}

/**
 * Raw bytes → base64 using Web APIs only (btoa over a binary string). For BINARY parts: the gzipped
 * save / lastSave / logs arrive as bytes (`arrayBuffer()`), and GitHub's Contents API wants base64 of
 * those exact bytes — NOT base64 of any text decoding (which would corrupt the gzip stream).
 */
function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Gunzip gzipped bytes → UTF-8 text using Web APIs only (DecompressionStream). The client gzips the
 * console log; the repo wants logs.txt human-readable, so the Worker inflates it here.
 */
async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
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
 * Issue title from META ONLY (never the description, which is untrusted free text):
 *   `<platform> <type> <time> <deviceModel>`
 * type = "Dev" when isDebugBuild (a Development build OR the Editor) else "Prod";
 * time = meta.timestampUtc trimmed to minutes (guarded when missing → "?").
 */
function issueTitle(meta: Record<string, unknown>): string {
  const platform = meta.platform != null ? String(meta.platform) : "?";
  // isDebugBuild is true on a Development build AND in the Editor; only a Release build is "Prod".
  const isDev = meta.isDebugBuild === true || String(meta.isDebugBuild) === "true";
  const type = isDev ? "Dev" : "Prod";
  const utcRaw = meta.timestampUtc != null ? String(meta.timestampUtc) : "";
  // "2026-06-29T16:25:47.1234567Z" → "2026-06-29 16:25"
  const time = utcRaw.length >= 16 ? utcRaw.slice(0, 16).replace("T", " ") : "?";
  const deviceModel = meta.deviceModel != null ? String(meta.deviceModel) : "?";
  return `${platform} ${type} ${time} ${deviceModel}`;
}

// GitHub rejects an issue body over 65536 chars with a 422 ("body is too long"). The full log + the
// saves are attachments, so the body stays small; this is just a hard backstop for a pathological meta.
const MAX_BODY_CHARS = 60000;

function issueBody(
  description: string,
  saveUrl: string,
  lastSaveUrl: string,
  commandsUrl: string,
  logsUrl: string,
  meta: Record<string, unknown>,
): string {
  // description as a blockquote (each line prefixed with "> "). The BODY may still show the
  // description (only the TITLE must not contain it).
  const quoted = description
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  // meta table — every key EXCEPT recentLogs (logs ship in their own gzipped part / logs.txt; the skip
  // stays defensively in case an older client still folds recentLogs into meta).
  const rows: string[] = ["| Field | Value |", "| --- | --- |"];
  for (const key of Object.keys(meta)) {
    if (key === "recentLogs") continue;
    let value = meta[key];
    if (value === null || value === undefined) value = "";
    const cell = String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
    rows.push(`| ${key} | ${cell} |`);
  }
  const metaTable = rows.join("\n");

  // Attachment links. The saves are GZIPPED — gunzip them to read the JSON. The FULL console log is the
  // logs.txt attachment — it is NOT copied into the body (that would just bloat the issue).
  const links: string[] = [];
  if (saveUrl) links.push(`**Current save (gzipped):** [save.json.gz](${saveUrl})`);
  if (lastSaveUrl) links.push(`**Previous save (gzipped):** [last_save.json.gz](${lastSaveUrl})`);
  if (commandsUrl) links.push(`**Session timeline (commands + lifecycle + save markers):** [commands.json](${commandsUrl})`);
  if (logsUrl) links.push(`**Full console log:** [logs.txt](${logsUrl})`);
  if (links.length === 0) links.push("_(no attachments)_");

  let body = [
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
    "</details>",
  ].join("\n");

  // Hard backstop so a pathological meta/description can never trip the 65536-char 422.
  if (body.length > MAX_BODY_CHARS) {
    body =
      body.slice(0, MAX_BODY_CHARS) +
      "\n\n_…body truncated to fit GitHub's 65536-char limit; see the attached files._";
  }
  return body;
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
    throw new Error(`github returned ${putRes.status}: ${detail.slice(0, 300)}`);
  }
  const putJson = (await putRes.json()) as { content?: { download_url?: string } };
  return putJson.content?.download_url ?? "";
}

/** The validated, in-memory report payload handed to the background filer. */
interface ReportData {
  prefix: string;
  today: string;
  saveBytes: Uint8Array;
  lastSaveBytes: Uint8Array | null;
  commandsText: string;
  logsBytes: Uint8Array | null;
  description: string;
  meta: Record<string, unknown>;
}

/**
 * Background filer: commit the attachments and open the issue. Runs OFF the client's request path via
 * ctx.waitUntil, so a slow GitHub round-trip never blocks the in-game send. The WHOLE thing is wrapped
 * so it never throws to the (already-acked) client — every failure is logged and swallowed, visible
 * through `wrangler tail`. The per-stage GitHub error logging (commitFile + the issue POST) is kept.
 */
async function fileReport(env: Env, data: ReportData): Promise<void> {
  try {
    const { prefix, today, saveBytes, lastSaveBytes, commandsText, logsBytes, description, meta } = data;

    // Inflate the gzipped log part to plain text for the human-readable logs.txt attachment.
    let logsText = "";
    if (logsBytes && logsBytes.length > 0) {
      try {
        logsText = await gunzipText(logsBytes);
      } catch (err) {
        console.error("logs gunzip failed", err);
        logsText = "";
      }
    }

    // Commit the attachments via the Contents API. The save/lastSave bytes are already gzipped —
    // base64 the RAW bytes (base64Bytes). The log is committed as PLAIN text (gunzipped → base64Utf8)
    // so the repo file is human-readable.
    let saveUrl = "";
    let lastSaveUrl = "";
    let commandsUrl = "";
    let logsUrl = "";

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
    // The full session timeline (player commands + app pause/resume/focus/quit + low-memory + Save markers,
    // interleaved chronologically) as a PLAIN-text attachment — committed verbatim so triage can correlate
    // the Save markers' savedUtc/savedSimTime to the attached save files (which entries fell between which
    // saves).
    if (commandsText.trim().length > 0) {
      commandsUrl = await commitFile(
        env,
        `${prefix}commands.json`,
        base64Utf8(commandsText),
        `bug: add session timeline for ${today}`,
      );
    }
    // Full console log as a separate PLAIN-text attachment — keeps it OUT of the issue body (which has
    // a 65536-char limit) while preserving every captured line, human-readable in the repo.
    if (logsText.length > 0) {
      logsUrl = await commitFile(
        env,
        `${prefix}logs.txt`,
        base64Utf8(logsText),
        `bug: add console log for ${today}`,
      );
    }

    // Create the issue.
    const issuesUrl = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues`;
    const issueRes = await fetch(issuesUrl, {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({
        title: issueTitle(meta),
        body: issueBody(description, saveUrl, lastSaveUrl, commandsUrl, logsUrl, meta),
        labels: ["bug-report"],
      }),
    });
    if (!issueRes.ok) {
      const detail = await issueRes.text();
      console.error("issues POST failed", issueRes.status, detail);
      return;
    }
  } catch (err) {
    console.error("fileReport failed", err);
  }
}

async function handleReport(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Read the binary parts (gzipped bytes): save, lastSave, logs.
  let saveBytes: Uint8Array | null;
  let lastSaveBytes: Uint8Array | null;
  let logsBytes: Uint8Array | null;
  try {
    saveBytes = await readBytes(form, "save");
    lastSaveBytes = await readBytes(form, "lastSave");
    logsBytes = await readBytes(form, "logs");
  } catch (err) {
    return json({ ok: false, error: `parse: could not read upload parts (${String(err)})` }, 400);
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
  if (logsBytes && logsBytes.length >= MAX_PART_BYTES) {
    return json({ ok: false, error: "validation: logs too large" }, 400);
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

  // 4. pre-generate the path prefix (date + uuid).
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const prefix = `assets/${today}/${crypto.randomUUID()}/`;

  // 5. fire the GitHub work in the BACKGROUND and ack immediately — the client waits only for the
  //    upload, never the whole GitHub round-trip. The issue number is not known at ack time and is
  //    deliberately not returned.
  ctx.waitUntil(
    fileReport(env, {
      prefix,
      today,
      saveBytes,
      lastSaveBytes,
      commandsText,
      logsBytes,
      description,
      meta,
    }),
  );
  return json({ ok: true }, 200);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/report") {
      return handleReport(request, env, ctx);
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
