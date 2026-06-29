/**
 * Tidebound bug-report Worker (Cloudflare, free tier).
 *
 * POST /report  (multipart/form-data, header X-Report-Key)
 *   fields:  save (file, application/json) | description (text) | meta (text/json)
 *
 * Flow:
 *   1. gate on X-Report-Key === env.REPORT_KEY
 *   2. parse multipart, pull save / description / meta
 *   3. validate (save parses JSON & < ~1 MB; description non-empty; meta parses JSON)
 *   4. commit save.json to GitHub Contents API under assets/<YYYY-MM-DD>/<uuid>/
 *   5. open an issue (title + body template + labels:["bug-report"])
 *   6. respond 200 {ok,issueNumber,issueUrl}
 *
 * Web/Fetch APIs ONLY (no Node-only globals). Base64 via TextEncoder + btoa.
 * No private data (token, save body) ever placed in a URL param.
 */

interface Env {
  REPORT_KEY: string;
  GH_TOKEN: string;
  GH_OWNER: string;
  GH_REPO: string;
}

const MAX_SAVE_BYTES = 1024 * 1024; // ~1 MB
const GH_API = "https://api.github.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** UTF-8 → base64 using Web APIs only (TextEncoder + btoa). Maps each byte through btoa-safe range. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
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
 * Escape backtick runs in a log line so a crafted log cannot break out of the
 * fenced code block / inject markdown (threat T-kh4-06). Replaces every backtick
 * with a look-alike so no run of ``` can close the fence.
 */
function neutralizeBackticks(s: string): string {
  return s.replace(/`/g, "ˋ"); // MODIFIER LETTER GRAVE ACCENT — visually similar, not a fence char
}

function issueTitle(description: string, platform: string, appVersion: string): string {
  const first = description.slice(0, 60).replace(/\s+/g, " ").trim();
  return `[Bug] ${first} — ${platform} ${appVersion}`;
}

function issueBody(
  description: string,
  downloadUrl: string,
  meta: Record<string, unknown>,
): string {
  // description as a blockquote (each line prefixed with "> ")
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
  const logsBlock = logText.length > 0 ? `\`\`\`\n${logText}\n\`\`\`` : "_(no recent error logs)_";

  return [
    "### Description",
    "",
    quoted,
    "",
    `**Save:** [save.json](${downloadUrl})`,
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

  const saveField = form.get("save");
  const description = String(form.get("description") ?? "");
  const metaRaw = String(form.get("meta") ?? "");

  // 3. validate
  if (!saveField || typeof saveField === "string") {
    return json({ ok: false, error: "validation: save file missing" }, 400);
  }
  const saveText = await (saveField as File).text();
  const saveBytes = new TextEncoder().encode(saveText).length;
  if (saveBytes >= MAX_SAVE_BYTES) {
    return json({ ok: false, error: "validation: save too large" }, 400);
  }
  try {
    JSON.parse(saveText);
  } catch {
    return json({ ok: false, error: "validation: save is not valid JSON" }, 400);
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

  const platform = meta.platform != null ? String(meta.platform) : "?";
  const appVersion = meta.appVersion != null ? String(meta.appVersion) : "?";

  // 4. path prefix
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const prefix = `assets/${today}/${crypto.randomUUID()}/`;

  // 5. commit save.json via Contents API
  let downloadUrl = "";
  try {
    const putUrl = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${prefix}save.json`;
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: ghHeaders(env),
      body: JSON.stringify({
        message: `bug: add save for ${today}`,
        content: base64Utf8(saveText),
        branch: "main",
      }),
    });
    if (!putRes.ok) {
      const detail = await putRes.text();
      console.error("contents PUT failed", putRes.status, detail);
      return json(
        { ok: false, error: `contents: github returned ${putRes.status}` },
        500,
      );
    }
    const putJson = (await putRes.json()) as { content?: { download_url?: string } };
    downloadUrl = putJson.content?.download_url ?? "";
  } catch (err) {
    console.error("contents PUT exception", err);
    return json({ ok: false, error: `contents: ${String(err)}` }, 500);
  }

  // 6. create the issue
  try {
    const issuesUrl = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues`;
    const issueRes = await fetch(issuesUrl, {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({
        title: issueTitle(description, platform, appVersion),
        body: issueBody(description, downloadUrl, meta),
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
