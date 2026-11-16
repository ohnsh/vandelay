import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Anchor, Inventory, Mapping, RecordContext } from "./types.ts";

export async function fileHash(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
export async function within(root: string, path: string): Promise<string> {
  const base = await realpath(root), target = await realpath(resolve(root, path));
  const rel = relative(base, target);
  if (isAbsolute(path) || rel === ".." || rel.startsWith(".." + sep)) throw new Error("path-outside-root");
  return target;
}
export function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  if (!path.startsWith("/")) throw new Error("invalid-json-pointer");
  return path.slice(1).split("/").reduce<any>((v, k) =>
    v != null && typeof v === "object" ? v[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, value);
}
const escape = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const object = (v: any): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface InputOptions {
  mediaArchive?: string;
  mapping?: Mapping;
  locate?: (record: unknown, source: string) => RecordContext;
}

export async function inventory(paths: string[], options: InputOptions = {}): Promise<Inventory> {
  const result: Inventory = { files: [], texts: [], issues: [] };
  const seen = new Set<string>();
  const verifiedMedia = new Map<string, { sha256: string; bytes: number }>();
  const issue = (source: string, code: string) => result.issues.push({ source, code });
  const archiveAsset = async (m: any): Promise<string | undefined> => {
    if (!object(m) || !object(m.location)) return;
    if (m.location.kind !== "archive-relative") {
      issue("media-reference", "nonlocal-media"); return;
    }
    if (!options.mediaArchive) { issue("media-reference", "media-archive-required"); return; }
    let target: string;
    try {
      target = await within(options.mediaArchive, m.location.path);
      let actual = verifiedMedia.get(target);
      if (!actual) {
        actual = { sha256: await fileHash(target), bytes: (await stat(target)).size };
        verifiedMedia.set(target, actual);
      }
      if (!/^[a-f0-9]{64}$/.test(m.sha256) || actual.sha256 !== m.sha256 || actual.bytes !== m.bytes) throw new Error();
    } catch { issue("media-reference", "missing-or-invalid-archive-object"); return; }
    await add(target, true);
    return target;
  };
  async function context(record: any, source: string): Promise<RecordContext> {
    if (options.locate) return options.locate(record, source);
    if (options.mapping) {
      const m = options.mapping;
      const get = (p?: string) => p === undefined ? undefined : pointer(record, p);
      const id = get(m.idPointer), wall = get(m.wallTimePointer), asset = get(m.assetPointer);
      const frame = get(m.framePointer), seconds = get(m.secondsPointer);
      if (m.assetPointer && typeof asset !== "string") throw new Error("invalid-record-mapping");
      if (frame !== undefined && (!Number.isSafeInteger(frame) || (frame as number) < 0)) throw new Error("invalid-record-mapping");
      if (seconds !== undefined && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)) throw new Error("invalid-record-mapping");
      if (wall !== undefined && (typeof wall !== "string" || !Number.isFinite(Date.parse(wall)))) throw new Error("invalid-record-mapping");
      const anchors: Anchor[] = [];
      if (typeof asset === "string") {
        const path = await within(dirname(source), asset);
        await add(path, true);
        anchors.push({ asset: path, frame: frame as number | undefined, seconds: seconds as number | undefined });
      }
      return { id: id === undefined ? undefined : String(id), wallTime: wall as string | undefined, anchors };
    }
    if (!object(record) || record.schema !== "vandelay.record/v1") return {};
    const anchors: Anchor[] = [];
    for (const m of record.media ?? []) {
      const asset = await archiveAsset(m);
      if (!asset) continue;
      if (m.selector?.type === "video-frame") {
        const frame = m.selector.frame_index;
        const seconds = Number(m.selector.presentation?.value) / m.selector.presentation?.timescale;
        if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(seconds) || seconds < 0) throw new Error("invalid-frame-selector");
        anchors.push({ asset, frame, seconds });
      } else if (record.kind === "dayflow.screenshots" && record.data?.frame_index != null) {
        const frame = record.data.frame_index;
        if (!Number.isSafeInteger(frame) || frame < 0) throw new Error("invalid-frame-selector");
        anchors.push({ asset, frame, seconds: frame });
      } else anchors.push({ asset });
    }
    return {
      id: String(record.id),
      wallTime: record.time?.at ?? record.time?.start,
      anchors,
    };
  }
  async function walk(value: any, source: string, at: string, ctx: RecordContext, key?: string, recordPointer = at): Promise<void> {
    if (typeof value === "string" || (typeof value === "number" && key)) {
      // Include the field name so {"API_KEY":"..."} is scanned as an assignment.
      result.texts.push({ source, pointer: at, recordPointer, text: key ? `${key}=${value}\n${value}` : String(value), value: String(value), context: ctx });
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) await walk(value[i], source, `${at}/${i}`, ctx, undefined, recordPointer);
    } else if (object(value)) {
      if (value.availability === "missing" || value.availability === "pending-finalization")
        issue(source, "unavailable-media-reference");
      if (value.location?.kind) await archiveAsset(value);
      for (const [k, v] of Object.entries(value)) {
        // Keys can themselves contain secrets.
        result.texts.push({ source, pointer: `${at}/${escape(k)}`, recordPointer, text: k, context: ctx });
        await walk(v, source, `${at}/${escape(k)}`, ctx, k, recordPointer);
      }
    }
  }
  async function add(raw: string, forceMedia = false): Promise<void> {
    const source = resolve(raw);
    try {
      const s = await lstat(source);
      if (s.isSymbolicLink()) { issue(source, "symlink-input"); return; }
      if (s.isDirectory()) {
        for (const name of (await readdir(source)).sort()) {
          if (name === ".git") continue;
          await add(join(source, name));
        }
        return;
      }
      if (!s.isFile()) { issue(source, "unsupported-file"); return; }
      const path = await realpath(source);
      if (seen.has(path)) return;
      seen.add(path);
      const ext = extname(path).toLowerCase();
      const media = forceMedia || [".png", ".jpg", ".jpeg", ".webp", ".heic", ".tiff", ".mp4", ".mov", ".mkv"].includes(ext);
      const text = [".json", ".jsonl", ".txt", ".md", ".env", ".log", ".csv", ".sha256"].includes(ext) || path.endsWith("/.env");
      if (!media && !text) { issue(path, "unsupported-file"); return; }
      const before = await fileHash(path);
      result.files.push({ path, sha256: before, bytes: s.size, kind: media ? "media" : "text" });
      if (media) return;
      const content = await readFile(path, "utf8");
      if (ext === ".json" || ext === ".jsonl") {
        const records = ext === ".jsonl" ? content.split(/\r?\n/).map((line, i) => ({ line, i })).filter(r => r.line.trim())
          .map(r => ({ value: JSON.parse(r.line), at: `line:${r.i + 1}#` })) : [{ value: JSON.parse(content), at: "#" }];
        for (const { value, at } of records) {
          if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) await walk(value[i], path, `${at}/${i}`, await context(value[i], path));
          } else await walk(value, path, at, await context(value, path));
        }
      } else result.texts.push({ source: path, pointer: "#", recordPointer: "#", text: content, value: content, context: {} });
    } catch {
      // Parser and filesystem messages can contain source text; never echo them.
      issue(source, "input-read-or-parse-failed");
    }
  }
  for (const path of paths) await add(path);
  if (!result.files.length) issue("inputs", "no-supported-inputs");
  return result;
}
