import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "../src/rules.ts";
import { emptyReview, groupFindings, parseReport, publication, validateReview } from "../src/review/model.ts";
import { encodeReview, ReviewStore } from "../src/review/store.ts";
import { textExcerpt } from "../src/review/server.ts";
import { fixtureReport } from "./review-fixture.ts";
async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-review-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("scrutiny duplicates become one review item and display box, preserving both finding IDs", () => {
  const report = fixtureReport("/frame.png", Buffer.from("image"));
  const groups = groupFindings(report);
  expect(groups).toHaveLength(1);
  expect(groups[0].boxes).toHaveLength(1);
  expect(groups[0].boxes[0].findingIds).toHaveLength(2);
  expect(groups[0].findings).toHaveLength(2);
  report.findings.push({ ...report.findings[0], id: hash("later"), frame: 1 });
  expect(groupFindings(report)).toHaveLength(2);
});
test("publication decisions preserve unreviewed, withheld and incomplete states", () => {
  const report = fixtureReport("/frame.png", Buffer.from("image"));
  const digest = hash(JSON.stringify(report)), groups = groupFindings(report), review = emptyReview(digest);
  expect(publication(report, digest, review).status).toBe("pending-review");
  expect(publication(report, digest, review).inputs[0].decision).toBe("unreviewed");
  review.decisions[groups[0].id] = { decision: "withhold", note: "real secret", updatedAt: new Date().toISOString() };
  let manifest = publication(report, digest, review);
  expect(manifest.status).toBe("complete");
  expect(manifest.inputs[0].decision).toBe("withhold");
  expect(manifest.groups[0].findingIds).toHaveLength(2);
  review.decisions[groups[0].id].decision = "publish";
  expect(publication(report, digest, review).inputs[0].decision).toBe("publish");
  report.issues.push({ source: "/missing.mp4", code: "missing" });
  manifest = publication(report, digest, review);
  expect(manifest.status).toBe("incomplete-scan");
  expect(manifest.inputs[0].decision).toBe("unreviewed");
  expect(() => validateReview(review, hash("different"), groups)).toThrow();
  review.decisions[hash("unknown")] = review.decisions[groups[0].id];
  expect(() => validateReview(review, digest, groups)).toThrow();
});
test("saved review survives restart, rejects stale edits, and never changes report bytes", async () => temporary(async dir => {
  const reportPath = join(dir, "report.json"), statePath = join(dir, "review.json");
  const reportBytes = JSON.stringify(fixtureReport(join(dir, "image.png"), Buffer.from("image")), null, 2);
  await writeFile(reportPath, reportBytes);
  await expect(ReviewStore.open(reportPath, reportPath)).rejects.toThrow("review-would-overwrite-report");
  const store = await ReviewStore.open(reportPath, statePath), id = store.groups[0].id;
  await store.update(0, id, "withhold", "Sensitive environment");
  expect(store.state.revision).toBe(1);
  expect(await readFile(reportPath, "utf8")).toBe(reportBytes);
  expect((await ReviewStore.open(reportPath, statePath)).state.decisions[id].decision).toBe("withhold");
  await expect(store.update(0, id, "publish", "")).rejects.toThrow("revision-conflict");
  const concurrent = await Promise.allSettled([store.update(1, id, "publish", ""), store.update(1, id, "withhold", "")]);
  expect(concurrent.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const other = await ReviewStore.open(reportPath, statePath);
  await other.update(2, id, "withhold", "other session");
  await expect(store.update(2, id, "publish", "")).rejects.toThrow("review-changed-on-disk");
  await store.refresh();
  expect(store.state.revision).toBe(3);
  // Preserve exact review bytes, even when another tool reformats the JSON.
  const reformatted = JSON.stringify(store.state) + "\n\n";
  await writeFile(statePath, reformatted);
  await store.refresh();
  expect(store.exportBytes()).toBe(reformatted);
  await store.update(3, id, null, "");
  expect(store.state.decisions).toEqual({});
  await writeFile(reportPath, reportBytes + "\n");
  await expect(store.update(4, id, "publish", "")).rejects.toThrow("report-changed-on-disk");
}));
test("text inspection resolves JSONL pointers and refuses altered source bytes", async () => temporary(async dir => {
  const source = join(dir, "records.jsonl"), bytes = Buffer.from('{"text":"API_KEY=synthetic-key"}\n');
  await writeFile(source, bytes);
  const path = join(dir, "report.json");
  await writeFile(path, JSON.stringify(fixtureReport(source, bytes, false)));
  const store = await ReviewStore.open(path, join(dir, "review.json"));
  expect(await textExcerpt(store, store.groups[0])).toEqual({ text: "API_KEY=synthetic-key", truncated: false });
  await writeFile(source, '{"text":"replacement"}');
  await expect(textExcerpt(store, store.groups[0])).rejects.toThrow("source-missing-or-changed");
}));
test("apply-review writes hash-bound manifest and does not overwrite an existing output", async () => temporary(async dir => {
  const report = fixtureReport("/frame.png", Buffer.from("image"));
  const bytes = JSON.stringify(report), digest = hash(bytes);
  const state = emptyReview(digest), id = groupFindings(report)[0].id;
  state.decisions[id] = { decision: "publish", note: "synthetic", updatedAt: new Date().toISOString() };
  const r = join(dir, "report.json"), s = join(dir, "review.json"), output = join(dir, "publication.json");
  await writeFile(r, bytes); await writeFile(s, encodeReview(state));
  const invoke = () => Bun.spawn(["bun", new URL("../src/cli.ts", import.meta.url).pathname, "apply-review", r, "--review", s, "--out", output], { stdout: "ignore", stderr: "ignore" }).exited;
  expect(await invoke()).toBe(0);
  const manifest = JSON.parse(await readFile(output, "utf8"));
  expect(manifest.reportSha256).toBe(digest);
  expect(manifest.reviewSha256).toBe(hash(await readFile(s)));
  expect(manifest.inputs[0].decision).toBe("publish");
  expect(await invoke()).toBe(2);
  expect(await readFile(r, "utf8")).toBe(bytes);
}));
test("report parsing rejects unknown source paths and duplicate finding IDs", () => {
  const report = fixtureReport("/frame.png", Buffer.from("image"));
  report.findings[0].source = "/not-in-report.png";
  expect(() => parseReport(Buffer.from(JSON.stringify(report)))).toThrow("invalid-finding");
  report.findings[0].source = report.inputs[0].path;
  report.findings[1].id = report.findings[0].id;
  expect(() => parseReport(Buffer.from(JSON.stringify(report)))).toThrow("invalid-finding");
});
test("a clean complete scan needs no review decisions; incomplete coverage still blocks publish", () => {
  const report = fixtureReport("/notes.txt", Buffer.from("notes"), false);
  report.findings = [];
  report.status = "no-findings";
  const digest = hash(JSON.stringify(report)), review = emptyReview(digest);
  expect(publication(report, digest, review).status).toBe("complete");
  expect(publication(report, digest, review).inputs[0].decision).toBe("publish");
  report.status = "incomplete";
  expect(publication(report, digest, review).status).toBe("incomplete-scan");
  expect(publication(report, digest, review).inputs[0].decision).toBe("unreviewed");
});
