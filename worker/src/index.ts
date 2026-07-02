/**
 * Tidebound bug-report Worker (Cloudflare, free tier).
 *
 * POST /report  (multipart/form-data, header X-Report-Key)
 *   fields:
 *     save        (file, gzipped JSON — CURRENT game state)        REQUIRED
 *     backup0..N  (files, gzipped JSON — the rolling save_<index>.json.gz backups, newest-first;
 *                  each already gzipped on disk, committed verbatim)          optional (0..N)
 *     commands    (file, gzipped JSON — full session timeline: player commands + app
 *                  pause/resume/focus/quit + low-mem + catch-up boundaries + Save markers)  optional
 *     logs        (file, gzipped text — console log ring buffer)    optional
 *     description (text)                                            REQUIRED
 *     meta        (text/json — scalars only, no logs)              REQUIRED
 *     lastSave    (file, gzipped JSON — LEGACY previous-save part)  optional (old clients only)
 *
 * The client contract changed with save-backup-replay (SPEC §10): the old single `lastSave` part was
 * REPLACED by the full rolling-backup set (`backup0..N`, each a `save_<index>.json.gz`), and `commands`
 * is now shipped GZIPPED (was plain text). Both legacy shapes are still accepted so an older installed
 * build keeps working: `lastSave` is committed when present, and a plain-text `commands` string is taken
 * verbatim when a gzipped file part is absent.
 *
 * Flow:
 *   1. gate on X-Report-Key === env.REPORT_KEY
 *   2. parse multipart, read ALL parts into memory
 *   3. validate (save present + < 5 MB; description non-empty; meta parses JSON)
 *   4. ACK the client immediately ({ ok: true }) — the GitHub round-trip runs in the
 *      background via ctx.waitUntil(fileReport(...)), so the client waits ONLY for the upload.
 *   5. fileReport (background): commit save.json.gz / save_<index>.json.gz backups / commands.json /
 *      logs.txt under assets/<YYYY-MM-DD>/<uuid>/ then open an issue. Failures are swallowed and logged
 *      (visible via `wrangler tail`) — the client never learns the issue number.
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
// The client keeps at most 5 rolling backups (BackupManager.DefaultKeep); cap defensively so a buggy
// or hostile client can't force an unbounded fan-out of GitHub commits. Excess backups are dropped + logged.
const MAX_BACKUPS = 10;
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
 * save / backups / logs arrive as bytes (`arrayBuffer()`), and GitHub's Contents API wants base64 of
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
 * console log + the command timeline; the repo wants logs.txt / commands.json human-readable, so the
 * Worker inflates them here.
 */
async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/**
 * Best-effort inflate: try gunzip, and if the bytes are NOT gzip (a mislabeled part, or a legacy client
 * that shipped plain text as a file), fall back to a straight UTF-8 decode so the content still lands.
 */
async function gunzipTextSafe(bytes: Uint8Array): Promise<string> {
  try {
    return await gunzipText(bytes);
  } catch {
    try {
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }
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
 * Sanitize an UNTRUSTED backup part filename before it goes into a repo path. The client sends
 * `save_<index>.json.gz`; accept only that exact shape and otherwise synthesize a safe, collision-free
 * name from the part index. This blocks path traversal (`../`, absolute paths) and any surprise chars.
 */
function safeBackupName(rawName: string | undefined, partIndex: number): string {
  const name = rawName ?? "";
  if (/^save_\d{1,20}\.json\.gz$/.test(name)) return name;
  return `save_backup${partIndex}.json.gz`;
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
  backupLinks: Array<{ name: string; url: string }>,
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
  // The rolling backups (newest-first) — triage loads one + replays the timeline to reconstruct state.
  if (backupLinks.length > 0) {
    links.push(`**Rolling backups (gzipped, newest first):**`);
    for (const b of backupLinks) links.push(`- [${b.name}](${b.url})`);
  }
  // Legacy single previous-save part (only older clients still send it).
  if (lastSaveUrl) links.push(`**Previous save (gzipped, legacy):** [last_save.json.gz](${lastSaveUrl})`);
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

/** One rolling backup part: a sanitized `save_<index>.json.gz` filename + its already-gzipped bytes. */
interface BackupPart {
  name: string;
  bytes: Uint8Array;
}

/** The validated, in-memory report payload handed to the background filer. */
interface ReportData {
  prefix: string;
  today: string;
  saveBytes: Uint8Array;
  backups: BackupPart[];
  lastSaveBytes: Uint8Array | null;
  commandsBytes: Uint8Array | null;
  commandsTextRaw: string;
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
    const {
      prefix, today, saveBytes, backups, lastSaveBytes, commandsBytes, commandsTextRaw, logsBytes,
      description, meta,
    } = data;

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

    // Resolve the command timeline. New clients gzip it into a file part (commandsBytes); a legacy client
    // sends it as a plain-text string field (commandsTextRaw). Prefer the string, else inflate the bytes.
    let commandsText = commandsTextRaw;
    if (commandsText.trim().length === 0 && commandsBytes && commandsBytes.length > 0) {
      commandsText = await gunzipTextSafe(commandsBytes);
    }

    // Commit the attachments via the Contents API. The save/backup bytes are already gzipped —
    // base64 the RAW bytes (base64Bytes). The log + commands are committed as PLAIN text
    // (gunzipped → base64Utf8) so the repo files are human-readable.
    let saveUrl = "";
    let lastSaveUrl = "";
    let commandsUrl = "";
    let logsUrl = "";
    const backupLinks: Array<{ name: string; url: string }> = [];

    saveUrl = await commitFile(
      env,
      `${prefix}save.json.gz`,
      base64Bytes(saveBytes),
      `bug: add current save (gz) for ${today}`,
    );

    // Every rolling backup (already gzipped on disk) — committed verbatim under its own stamped filename
    // so triage can order them by index and replay the timeline onto one. A single failing commit is
    // logged and skipped (via commitFile's throw) but must not abort the whole report.
    for (const backup of backups) {
      try {
        const url = await commitFile(
          env,
          `${prefix}${backup.name}`,
          base64Bytes(backup.bytes),
          `bug: add rolling backup ${backup.name} for ${today}`,
        );
        backupLinks.push({ name: backup.name, url });
      } catch (err) {
        console.error("backup commit failed", backup.name, err);
      }
    }

    // Legacy single previous-save part (older clients only). Committed as last_save.json.gz when present.
    if (lastSaveBytes) {
      lastSaveUrl = await commitFile(
        env,
        `${prefix}last_save.json.gz`,
        base64Bytes(lastSaveBytes),
        `bug: add previous save (gz) for ${today}`,
      );
    }

    // The full session timeline (player commands + app pause/resume/focus/quit + low-memory + catch-up
    // boundaries + Save markers, interleaved chronologically) as a PLAIN-text attachment — committed so
    // triage can correlate the Save markers' savedUtc/savedSimTime to the attached save files (which
    // entries fell between which saves).
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
        body: issueBody(description, saveUrl, backupLinks, lastSaveUrl, commandsUrl, logsUrl, meta),
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

  // commands: a NEW gzipped file part (commands.json.gz) OR a LEGACY plain-text string field.
  const commandsField = form.get("commands");
  let commandsTextRaw = "";
  let commandsBytes: Uint8Array | null = null;
  if (typeof commandsField === "string") {
    commandsTextRaw = commandsField;
  } else if (commandsField) {
    try {
      const buf = new Uint8Array(await (commandsField as File).arrayBuffer());
      if (buf.length >= MAX_PART_BYTES) {
        console.warn("commands part oversized; dropping", buf.length);
      } else {
        commandsBytes = buf;
      }
    } catch (err) {
      console.error("reading commands part failed", err);
    }
  }

  // Read the binary parts (gzipped bytes): save, logs, legacy lastSave.
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

  // Collect the rolling backup parts (backup0..backupN, newest-first). Filenames are UNTRUSTED, so
  // sanitize before use in a repo path. An oversized/unreadable/empty backup is skipped — a supplementary
  // blob must never fail the whole report.
  const backups: Array<{ index: number; name: string; bytes: Uint8Array }> = [];
  try {
    for (const [field, value] of form.entries()) {
      const m = /^backup(\d+)$/.exec(field);
      if (!m || typeof value === "string") continue;
      let buf: Uint8Array;
      try {
        buf = new Uint8Array(await (value as File).arrayBuffer());
      } catch (err) {
        console.error("reading backup part failed", field, err);
        continue;
      }
      if (buf.length === 0) continue;
      if (buf.length >= MAX_PART_BYTES) {
        console.warn("skipping oversized backup part", field, buf.length);
        continue;
      }
      const partIndex = Number(m[1]);
      backups.push({ index: partIndex, name: safeBackupName((value as File).name, partIndex), bytes: buf });
    }
  } catch (err) {
    console.error("enumerating backup parts failed", err);
  }
  // Newest-first (backup0 is newest). Cap defensively — the client keeps at most 5.
  backups.sort((a, b) => a.index - b.index);
  if (backups.length > MAX_BACKUPS) {
    console.warn(`received ${backups.length} backups; committing first ${MAX_BACKUPS}`);
    backups.length = MAX_BACKUPS;
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
      backups: backups.map((b) => ({ name: b.name, bytes: b.bytes })),
      lastSaveBytes,
      commandsBytes,
      commandsTextRaw,
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
