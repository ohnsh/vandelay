import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileHash } from "./inputs.ts";
import { hash } from "./rules.ts";
import { maskFilters } from "./masks.ts";
import { groupFindings, parseReport, publication, validateReview, type ReviewState } from "./review/model.ts";
import type { Box, Report } from "./types.ts";
import { frames, probe } from "./media.ts";
const engineDigest = hash(Buffer.concat(["masks.ts", "rendition.ts"].map(path =>
  readFileSync(new URL(path, import.meta.url)))));

/** Offline adapter contract. Source identities remain historical; masks describe a rendition. */
export class ReviewedRendition {
  readonly groups;
  readonly digest: string;
  private readonly mediaHashes = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly masks = new Map<string, { frame: number; box: Box }[]>();
  constructor(readonly report: Report, readonly state: ReviewState,
    readonly reportSha256: string, readonly reviewSha256: string) {
    this.groups = groupFindings(report);
    validateReview(state, reportSha256, this.groups, report);
    if (publication(report, reportSha256, state, reviewSha256).status !== "complete")
      throw new Error("rendition-review-incomplete");
    this.digest = hash(JSON.stringify([reportSha256, reviewSha256, "autoredact.rendition/v1", engineDigest]));
    const hashes = new Map(report.inputs.map(i => [i.path, i.sha256]));
    for (const i of report.inputs) if (i.kind === "media") this.mediaHashes.add(i.sha256);
    const unique = new Map<string, Map<string, { frame: number; box: Box }>>();
    for (const g of this.groups) {
      if (g.frame === undefined) continue;
      const sha256 = hashes.get(g.source)!;
      if (state.decisions[g.id]?.decision === "withhold") this.blocked.add(`${sha256}:${g.frame}`);
      for (const m of state.maskPlan?.frames[g.id] ?? []) {
        const value = { frame: g.frame, box: m.box }, values = unique.get(sha256) ?? new Map();
        values.set(JSON.stringify(value), value); unique.set(sha256, values);
      }
    }
    for (const [sha256, values] of unique) this.masks.set(sha256, [...values.values()]
      .sort((a, b) => a.frame - b.frame || JSON.stringify(a.box).localeCompare(JSON.stringify(b.box))));
  }
  async verifySources() {
    for (const input of this.report.inputs) {
      if ((await stat(input.path)).size !== input.bytes || await fileHash(input.path) !== input.sha256)
        throw new Error("source-missing-or-changed");
    }
  }
  /** A publisher must bind its actual text inputs, not just the media archive. */
  requireText(sha256: string) {
    const inputs = this.report.inputs.filter(i => i.sha256 === sha256 && i.kind === "text");
    if (!inputs.length) throw new Error("publication-text-not-scanned");
    if (this.groups.some(g => inputs.some(i => i.path === g.source) &&
        this.state.decisions[g.id]?.decision === "withhold")) throw new Error("publication-text-withheld");
  }
  requireMedia(sha256: string) {
    if (!this.mediaHashes.has(sha256))
      throw new Error("publication-media-not-scanned");
  }
  allowsFrame(sha256: string, frame: number): boolean {
    this.requireMedia(sha256);
    return !this.blocked.has(`${sha256}:${frame}`);
  }
  masksFor(sha256: string): { frame: number; box: Box }[] {
    this.requireMedia(sha256);
    return this.masks.get(sha256) ?? [];
  }
}
export async function loadRendition(reportPath: string, reviewPath: string): Promise<ReviewedRendition> {
  const [report, review] = await Promise.all([readFile(reportPath), readFile(reviewPath)]);
  const parsed = parseReport(report), reportHash = hash(report);
  return new ReviewedRendition(parsed, validateReview(JSON.parse(review.toString()), reportHash,
    groupFindings(parsed), parsed), reportHash, hash(review));
}
export interface RenderedFrame {
  sourceSha256: string;
  sourceFrame: number;
  sourceSeconds?: number;
  output: { path: string; sha256: string; bytes: number; frame: 0 };
}
export interface RenditionManifest {
  schema: "autoredact.rendition/v1";
  reportSha256: string;
  reviewSha256: string;
  recipe: string;
  /** Lossless replacements only. Unlisted source frames are not publication approvals. */
  frames: RenderedFrame[];
}
/** Frame derivatives are independent of parent containers. A publisher assembles its own
 * chunks from the same mask filters, preserving historical references separately. */
export async function renderRendition(rendition: ReviewedRendition, directory: string): Promise<RenditionManifest> {
  await rendition.verifySources();
  const out = resolve(directory);
  await mkdir(out, { mode: 0o700 }); // Exclusive output directory; manifest is the commit marker.
  const manifest: RenditionManifest = { schema: "autoredact.rendition/v1",
    reportSha256: rendition.reportSha256, reviewSha256: rendition.reviewSha256,
    recipe: rendition.digest, frames: [] };
  try {
    const seen = new Set<string>();
    for (const input of rendition.report.inputs.filter(i => i.kind === "media")) {
      if (seen.has(input.sha256)) continue;
      seen.add(input.sha256);
      const masks = rendition.masksFor(input.sha256);
      if (!masks.length) continue;
      const info = await probe(input.path);
      if (masks.some(m => m.frame >= info.times.length)) throw new Error("rendition-frame-missing");
      for (const f of rendition.report.frames ?? []) if (f.source === input.path && f.seconds !== undefined &&
          (!Number.isFinite(info.times[f.frame]) || Math.abs(info.times[f.frame] - f.seconds) > 0.00001))
        throw new Error("rendition-frame-time-mismatch");
      for await (const decoded of frames(input.path, info.times)) {
        const frame = decoded.index;
        if (!masks.some(m => m.frame === frame) || !rendition.allowsFrame(input.sha256, frame)) continue;
        const temporary = join(out, "frame.png");
        const filters = maskFilters(masks.filter(m => m.frame === frame).map(m => ({ box: m.box })));
        const process = Bun.spawn(["ffmpeg", "-v", "error", "-xerror", "-i", decoded.path, "-map", "0:v:0",
          "-vf", filters.join(","), "-frames:v", "1", "-f", "image2", "-c:v", "png", temporary],
          { stdout: "ignore", stderr: "ignore" });
        if (await process.exited !== 0) throw new Error("rendition-render-failed");
        const bytes = await readFile(temporary), sha256 = hash(bytes), path = `${sha256}.png`;
        await writeFile(join(out, path), bytes, { mode: 0o600 });
        await rm(temporary);
        manifest.frames.push({ sourceSha256: input.sha256, sourceFrame: frame,
          sourceSeconds: rendition.report.frames?.find(f => f.source === input.path && f.frame === frame)?.seconds,
          output: { path, sha256, bytes: bytes.length, frame: 0 } });
      }
    }
    await rendition.verifySources();
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
}
