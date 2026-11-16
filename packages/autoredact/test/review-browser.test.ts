import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureReport } from "./review-fixture.ts";
import { startReview } from "../src/review/server.ts";
import { hash } from "../src/rules.ts";

test.skipIf(process.env.AUTOREDACT_REVIEW_TEST !== "1")("React review: exact frame, save, undo, reload, export, mobile, and local API boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-browser-"));
  // Two different colors: frame 1 should be blue, proving index selection rather
  // than timestamp guessing. Pixel assertions run inside the browser.
  const video = join(dir, "clip.mp4");
  const encoder = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=640x400:r=1:d=1",
    "-f", "lavfi", "-i", "color=blue:s=640x400:r=1:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { stdout: "ignore", stderr: "ignore" });
  expect(await encoder.exited).toBe(0);
  const report = fixtureReport(video, await readFile(video));
  report.findings.forEach(f => { f.frame = 1; f.seconds = 1; });
  const reportPath = join(dir, "report.json"), statePath = join(dir, "review.json");
  const bytes = JSON.stringify(report, null, 2);
  await writeFile(reportPath, bytes);
  const { server, url } = await startReview(reportPath, statePath, 0);
  const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("heading", { name: "Your decision" }).waitFor();
    const image = page.getByAltText("Source frame 1, with 1 detected regions");
    await image.evaluate((img: HTMLImageElement) => img.decode());
    const rgb = await image.evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(img, 0, 0);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    expect(rgb[2]).toBeGreaterThan(200);
    expect(rgb[0]).toBeLessThan(30);
    expect(await page.locator(".region").count()).toBe(1);
    await page.getByLabel("Raw detections", { exact: true }).check();
    expect(await page.locator(".region").count()).toBe(2);
    await page.getByLabel("Raw detections", { exact: true }).uncheck();
    await page.getByLabel("Review note", { exact: false }).fill("Synthetic test");
    await page.getByRole("button", { name: "Confirmed · withhold", exact: false }).click();
    await page.getByRole("heading", { name: "Every flagged item has a decision." }).waitFor();
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(Object.values(state.decisions).map((d: any) => d.decision)).toEqual(["withhold"]);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    await page.getByRole("button", { name: "Undo last decision" }).click();
    await page.getByRole("heading", { name: "Your decision" }).waitFor();
    await page.keyboard.press("f");
    await page.getByRole("heading", { name: "Every flagged item has a decision." }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Every flagged item has a decision." }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export manifest", exact: false }).click(),
    ]);
    const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(exported.reportSha256).toBe(hash(bytes));
    expect(exported.status).toBe("complete");
    expect(exported.inputs[0].decision).toBe("publish");
    expect(exported.reviewSha256).toBe(hash(await readFile(statePath)));
    expect(await readFile(reportPath, "utf8")).toBe(bytes);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("heading", { name: "Your decision" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);

    expect((await fetch(url + "/api/session")).status).toBe(403);
    const token = await page.locator('meta[name="review-token"]').getAttribute("content");
    expect((await fetch(url + "/api/decision", { method: "POST", headers: {
      "Content-Type": "application/json", "x-review-token": token!, Origin: "https://example.com",
    }, body: "{}" })).status).toBe(403);
    const revision = JSON.parse(await readFile(statePath, "utf8")).revision;
    expect((await fetch(url + "/api/decision", { method: "POST", headers: {
      "Content-Type": "application/json", "x-review-token": token!,
    }, body: JSON.stringify({ revision: revision - 1, groupId: Object.keys(state.decisions)[0], decision: "withhold" }) })).status).toBe(409);
  } finally { await browser.close(); server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 90_000);
