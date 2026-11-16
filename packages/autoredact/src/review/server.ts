import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, pointer } from "../inputs.ts";
import { hash } from "../rules.ts";
import { publication, type ReviewGroup } from "./model.ts";
import { ReviewStore } from "./store.ts";

async function verified(store: ReviewStore, source: string) {
  const input = store.report.inputs.find(i => i.path === source);
  if (!input || (await stat(source)).size !== input.bytes || await fileHash(source) !== input.sha256)
    throw new Error("source-missing-or-changed");
  return input;
}
export async function framePNG(store: ReviewStore, group: ReviewGroup): Promise<Uint8Array<ArrayBuffer>> {
  if (group.kind !== "frame" || group.frame === undefined) throw new Error("not-a-frame");
  await verified(store, group.source);
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-xerror", "-i", group.source,
    "-map", "0:v:0", "-vf", `select=eq(n\\,${group.frame})`, "-frames:v", "1", "-fps_mode", "passthrough",
    "-f", "image2pipe", "-c:v", "png", "-"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const png = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    if (await child.exited !== 0 || png.length < 8 || png[0] !== 137 || png[1] !== 80) throw new Error("frame-decode-failed");
    await verified(store, group.source);
    return png;
  } finally { clearTimeout(timer); }
}
export async function textExcerpt(store: ReviewStore, group: ReviewGroup) {
  await verified(store, group.source);
  const bytes = await readFile(group.source);
  await verified(store, group.source);
  const content = bytes.toString("utf8"), location = group.pointer ?? "#";
  const line = /^line:(\d+)#(.*)$/.exec(location);
  let value: unknown;
  if (line) {
    const raw = content.split(/\r?\n/)[Number(line[1]) - 1];
    if (raw === undefined) throw new Error("text-location-missing");
    value = pointer(JSON.parse(raw), line[2]);
  } else if (group.source.endsWith(".json")) value = pointer(JSON.parse(content), location.replace(/^#/, ""));
  else value = content;
  if (value === undefined) throw new Error("text-location-missing");
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { text: text.slice(0, 24_000), truncated: text.length > 24_000 };
}
async function enrichCaptureTimes(store: ReviewStore) {
  const mediaByHash = new Map(store.report.inputs.filter(i => i.kind === "media").map(i => [i.sha256, i.path]));
  const groups = new Map(store.groups.map(g => [`${g.source}:${g.frame}`, g]));
  for (const input of store.report.inputs.filter(i => basename(i.path) === "records.jsonl")) {
    try {
      await verified(store, input.path);
      const content = await readFile(input.path, "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.schema !== "vandelay.record/v1") continue;
        for (const media of record.media ?? []) {
          const frame = media.selector?.frame_index ?? (record.kind === "dayflow.screenshots" ? record.data?.frame_index : undefined);
          if (!Number.isSafeInteger(frame)) continue;
          const group = groups.get(`${mediaByHash.get(media.sha256)}:${frame}`);
          if (group && !group.wallTime) {
            group.wallTime = record.time?.at ?? record.time?.start;
            group.recordId = record.id;
          }
        }
      }
    } catch { /* Optional display context only; frame/text fetches verify their own sources. */ }
  }
}
export async function buildAssets() {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../web/main.tsx", import.meta.url))],
    target: "browser", minify: true, naming: "app.[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new Error("review-ui-build-failed");
  return new Map(await Promise.all(built.outputs.map(async o =>
    ["/assets/" + basename(o.path), { bytes: await o.arrayBuffer(), type: o.type }] as const)));
}
export async function startReview(reportPath: string, statePath: string, port = 4317) {
  const store = await ReviewStore.open(reportPath, statePath);
  await enrichCaptureTimes(store);
  store.groups.sort((a, b) => a.wallTime && b.wallTime ? a.wallTime.localeCompare(b.wallTime) :
    a.wallTime ? -1 : b.wallTime ? 1 : 0);
  const assets = await buildAssets();
  const token = crypto.randomUUID();
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="review-token" content="${token}"><title>AutoRedact · Review</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;
  const headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    maxRequestBodySize: 16_384,
    async fetch(request, server) {
      const url = new URL(request.url);
      const host = `127.0.0.1:${server.port}`;
      if (request.headers.get("host") !== host) return json({ error: "invalid-host" }, 403);
      if (request.headers.get("origin") && request.headers.get("origin") !== `http://${host}`)
        return json({ error: "invalid-origin" }, 403);
      const route = url.pathname;
      if (request.method === "GET" && route === "/") return new Response(html, { headers: { ...headers, "Content-Type": "text/html" } });
      const asset = assets.get(route);
      if (request.method === "GET" && asset) return new Response(asset.bytes, { headers: { ...headers, "Content-Type": asset.type } });
      if (request.headers.get("x-review-token") !== token && url.searchParams.get("token") !== token)
        return json({ error: "invalid-session" }, 403);
      try {
        if (request.method === "GET" && route === "/api/session") {
          await store.refresh();
          return json({ name: basename(store.reportPath), reportSha256: store.reportSha256, report: store.report,
            groups: store.groups, review: store.state, statePath: store.statePath });
        }
        if (request.method === "POST" && route === "/api/decision") {
          const data = await request.json();
          const state = await store.update(data.revision, data.groupId, data.decision, data.note ?? "");
          return json(state);
        }
        if (request.method === "GET" && route === "/api/review")
          return new Response(store.exportBytes(), { headers: { ...headers, "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="review.json"' } });
        if (request.method === "GET" && route === "/api/publication") {
          const manifest = publication(store.report, store.reportSha256, store.state, hash(store.exportBytes()));
          return new Response(JSON.stringify(manifest, null, 2) + "\n", { headers: { ...headers, "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="publication.json"' } });
        }
        const match = /^\/api\/(frame|text)\/([a-f0-9]{64})$/.exec(route);
        if (request.method === "GET" && match) {
          const group = store.groups.find(g => g.id === match[2]);
          if (!group) return json({ error: "unknown-review-item" }, 404);
          if (match[1] === "text" && group.kind === "text") return json(await textExcerpt(store, group));
          if (match[1] === "frame" && group.kind === "frame") return new Response(await framePNG(store, group),
            { headers: { ...headers, "Content-Type": "image/png" } });
        }
        return json({ error: "not-found" }, 404);
      } catch (error) {
        const code = error instanceof Error ? error.message : "request-failed";
        // Native/filesystem diagnostics can contain private data; return known codes only.
        const allowed = ["revision-conflict", "invalid-decision", "review-locked", "review-changed-on-disk",
          "report-changed-on-disk", "source-missing-or-changed", "frame-decode-failed", "text-location-missing"];
        return json({ error: allowed.includes(code) ? code : "request-failed" },
          /conflict|changed-on-disk|locked/.test(code) ? 409 : 400);
      }
    },
  });
  return { server, store, url: `http://127.0.0.1:${server.port}` };
}
