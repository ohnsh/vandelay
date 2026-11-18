import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprint, follow, frameID, planMasks, validatePlan } from "../src/masks.ts";
import { fixtureReport } from "./review-fixture.ts";
import { hash } from "../src/rules.ts";
import { emptyReview, groupFindings, publication } from "../src/review/model.ts";
import { ReviewStore } from "../src/review/store.ts";
import { loadRendition, renderRendition, ReviewedRendition } from "../src/rendition.ts";
import type { Report } from "../src/types.ts";

export function maskReport(source = "/video.mp4", bytes = Buffer.from("fixture")): Report {
  const report = fixtureReport(source, bytes);
  report.findings = []; report.status = "no-findings";
  report.frames = [0, 1, 2].map(frame => ({
    source, frame, seconds: frame,
    regions: [{ id: hash(`region${frame}`), box: [0.1 + frame * 0.1, 0.2, 0.2, 0.2],
      textHash: fingerprint(frame === 2 ? "OTHER" : "same text") }],
  }));
  return report;
}
test("OCR following preserves relative edits, exact normalization, duplicates and bounded scope", () => {
  expect(fingerprint("e\u0301 \n name")).toBe(fingerprint("é name"));
  expect(fingerprint("Name")).not.toBe(fingerprint("name"));
  const moved = follow([0.05, 0.1, 0.4, 0.4], [0.1, 0.2, 0.2, 0.2], [0.2, 0.3, 0.1, 0.1])!;
  [0.175, 0.25, 0.2, 0.2].forEach((value, i) => expect(moved[i]).toBeCloseTo(value));
  const report = maskReport(), first = report.frames![0], id = frameID(first.source, 0);
  report.frames![1].regions.push({ ...report.frames![1].regions[0], id: hash("duplicate"), box: [0.6, 0.7, 0.2, 0.2] });
  const mask = { box: first.regions[0].box, anchor: first.regions[0], scope: { start: 0, end: 2 } };
  const plan = planMasks(report, undefined, id, [mask]);
  expect(Object.keys(plan.frames)).toHaveLength(2);
  expect(plan.frames[frameID(first.source, 1)]).toHaveLength(2);
  validatePlan(plan, report);
  const edited = structuredClone(plan);
  edited.frames[frameID(first.source, 1)][0].box = [0, 0, 1, 1];
  expect(() => validatePlan(edited, report)).toThrow("invalid-mask-plan");
  expect(() => planMasks(report, plan, id, [{ ...mask, scope: { start: 0, end: 3 } }])).toThrow("invalid-mask-scope");
  expect(() => planMasks(report, plan, id, [{ ...mask, anchor: { ...mask.anchor, textHash: hash("forged") } }])).toThrow("invalid-mask-anchor");
  expect(planMasks(report, plan, id, []).frames).toEqual({});
});
test("mask transactions invalidate affected approvals, bind review revisions and preserve originals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-mask-state-"));
  try {
    const source = join(dir, "source.mp4"), bytes = Buffer.from("fixture");
    await writeFile(source, bytes);
    const report = maskReport(source, bytes), path = join(dir, "report.json"), state = join(dir, "review.json");
    const original = JSON.stringify(report); await writeFile(path, original);
    const store = await ReviewStore.open(path, state), first = report.frames![0], id = frameID(source, 0);
    for (const group of store.groups) await store.update(store.state.revision, group.id, "publish", "");
    const prior = store.state.revision;
    await store.masks(prior, id, [{ box: first.regions[0].box, anchor: first.regions[0], scope: { start: 0, end: 2 } }]);
    expect(store.state.decisions[id]).toBeUndefined();
    expect(store.state.decisions[frameID(source, 1)]).toBeUndefined();
    expect(store.state.decisions[frameID(source, 2)].decision).toBe("publish");
    expect(publication(report, store.reportSha256, store.state).status).toBe("pending-review");
    await expect(store.masks(prior, id, [])).rejects.toThrow("revision-conflict");
    expect((await ReviewStore.open(path, state)).state.maskPlan).toEqual(store.state.maskPlan);
    for (const group of store.groups) await store.update(store.state.revision, group.id, "publish", "");
    // Approval is for a derivative, never for the original file.
    expect(publication(report, store.reportSha256, store.state).inputs[0].decision).toBe("withhold");
    const rendition = await loadRendition(path, state);
    expect(rendition.masksFor(report.inputs[0].sha256)).toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe(original);
    await store.masks(store.state.revision, id, []);
    expect(store.state.maskPlan!.frames).toEqual({});
    expect(store.state.maskPlan!.reviewFrames).toContain(frameID(source, 1));
    expect(publication(report, store.reportSha256, store.state).status).toBe("pending-review");
    await writeFile(source, "changed");
    await expect(store.masks(store.state.revision, id, [])).rejects.toThrow("source-missing-or-changed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("physical aliases share masks, while unrelated assets do not", () => {
  const report = maskReport(), source = report.frames![0];
  report.inputs.push({ ...report.inputs[0], path: "/alias.mp4" }, { ...report.inputs[0], path: "/other.mp4", sha256: hash("other") });
  report.frames!.push({ ...source, source: "/alias.mp4" }, { ...source, source: "/other.mp4" });
  const plan = planMasks(report, undefined, frameID(source.source, 0), [{ box: [0, 0, 0.5, 0.5] }]);
  expect(plan.frames[frameID("/alias.mp4", 0)]).toHaveLength(1);
  expect(plan.frames[frameID("/other.mp4", 0)]).toBeUndefined();
  validatePlan(plan, report);
});
test("lossless rendition pixels are masked at moved anchors with exact source mapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-mask-render-"));
  try {
    const source = join(dir, "source.mp4");
    const child = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=white:s=100x100:r=1:d=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    const original = await readFile(source), report = maskReport(source, original), digest = hash(JSON.stringify(report));
    const state = emptyReview(digest), first = report.frames![0], id = frameID(source, 0);
    state.maskPlan = planMasks(report, undefined, id, [{ box: first.regions[0].box, anchor: first.regions[0], scope: { start: 0, end: 2 } }]);
    state.schema = "autoredact.review/v2";
    expect(() => new ReviewedRendition(report, state, digest, hash("review"))).toThrow("rendition-review-incomplete");
    for (const g of groupFindings(report)) state.decisions[g.id] = { decision: "publish", note: "", updatedAt: new Date().toISOString() };
    const rendition = new ReviewedRendition(report, state, digest, hash(JSON.stringify(state)));
    const out = join(dir, "rendered"), manifest = await renderRendition(rendition, out);
    expect(manifest.frames.map(f => f.sourceFrame)).toEqual([0, 1]);
    for (const result of manifest.frames) {
      const decoder = Bun.spawn(["ffmpeg", "-v", "error", "-i", join(out, result.output.path),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe", stderr: "ignore" });
      const rgb = new Uint8Array(await new Response(decoder.stdout).arrayBuffer());
      expect(await decoder.exited).toBe(0);
      const x = result.sourceFrame === 0 ? 15 : 25;
      expect([...rgb.slice((25 * 100 + x) * 3, (25 * 100 + x) * 3 + 3)]).toEqual([0, 0, 0]);
      expect(rgb[(5 * 100 + 5) * 3]).toBeGreaterThan(240);
      expect(hash(await readFile(join(out, result.output.path)))).toBe(result.output.sha256);
    }
    expect(await readFile(source)).toEqual(original);
    await expect(renderRendition(rendition, out)).rejects.toThrow();
    await writeFile(source, "changed");
    await expect(renderRendition(rendition, join(dir, "stale"))).rejects.toThrow("source-missing-or-changed");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("PNG masks replace transparency with opaque black and cover fractional edge pixels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-alpha-"));
  try {
    const source = join(dir, "transparent.png");
    const child = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
      "color=white@0:s=100x100,format=rgba", "-frames:v", "1", source], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    const report = maskReport(source, await readFile(source));
    report.frames = [{ ...report.frames![0], seconds: undefined }];
    const digest = hash(JSON.stringify(report)), state = emptyReview(digest), id = frameID(source, 0);
    state.schema = "autoredact.review/v2";
    state.maskPlan = planMasks(report, undefined, id, [{ box: [0.105, 0.205, 0.2, 0.2] }]);
    state.decisions[id] = { decision: "publish", note: "", updatedAt: new Date().toISOString() };
    const out = join(dir, "out");
    const manifest = await renderRendition(new ReviewedRendition(report, state, digest, hash(JSON.stringify(state))), out);
    const child2 = Bun.spawn(["ffmpeg", "-v", "error", "-i", join(out, manifest.frames[0].output.path),
      "-pix_fmt", "rgba", "-f", "rawvideo", "-"], { stdout: "pipe", stderr: "ignore" });
    const rgba = new Uint8Array(await new Response(child2.stdout).arrayBuffer());
    expect(await child2.exited).toBe(0);
    for (const [x, y] of [[10, 20], [30, 40]]) {
      const index = (y * 100 + x) * 4;
      expect([...rgba.slice(index, index + 4)]).toEqual([0, 0, 0, 255]);
    }
    expect(rgba[3]).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
