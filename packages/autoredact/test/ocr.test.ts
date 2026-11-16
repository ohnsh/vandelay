import { expect, test } from "bun:test";
import { mkdtemp, rm, copyFile, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/index.ts";
import { visionOCR } from "../src/ocr.ts";
import { hash, scanOCR } from "../src/rules.ts";

const enabled = process.env.AUTOREDACT_OCR_TEST === "1" && process.platform === "darwin";
test.skipIf(!enabled)("real Vision: env/dashboard, every video frame, synchronized escalation and failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-ocr-test-"));
  const run = async (args: string[]) => {
    const p = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
    const diagnostics = await new Response(p.stderr).text();
    if (await p.exited !== 0) throw new Error(diagnostics);
  };
  try {
    await run(["swiftc", new URL("./fixtures.swift", import.meta.url).pathname, "-o", join(dir, "fixtures")]);
    await run([join(dir, "fixtures"), dir]);
    const ocr = await visionOCR();
    try {
      expect(scanOCR((await ocr.recognize(join(dir, "clean.png"))).lines)).toEqual([]);
      for (const name of ["env", "dashboard", "vercel", "small"]) {
        const result = await ocr.recognize(join(dir, `${name}.png`));
        expect(scanOCR(result.lines).length).toBeGreaterThan(0);
        if (name === "env") expect(scanOCR(result.lines).some(m => m.boxes?.some(b => b[1] > 0.5))).toBe(true);
      }
    } finally { await ocr.close(); }
    // Exactly one out of three frames contains secrets, at 30 fps.
    for (const [i, name] of ["clean", "env", "clean"].entries())
      await copyFile(join(dir, `${name}.png`), join(dir, `frame${i}.png`));
    const video = join(dir, "clip.mp4");
    await run(["ffmpeg", "-v", "error", "-framerate", "30", "-i", join(dir, "frame%d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const report = await scan([video]);
    expect(report.status).toBe("findings");
    expect(report.coverage.frames).toBe(3);
    expect(report.findings.some(f => f.frame === 1 && f.rule === "secret-assignment")).toBe(true);
    expect(report.findings.some(f => f.frame === 0 || f.frame === 2)).toBe(false);

    const records = join(dir, "records.jsonl");
    await writeFile(records, JSON.stringify({ id: "note1", image: "clean.png", frame: 0, text: "API_KEY=synthetic-record-secret" }));
    const linked = await scan([records], { mapping: { idPointer: "/id", assetPointer: "/image", framePointer: "/frame" } });
    expect(linked.status).toBe("findings");
    expect(linked.coverage.scrutinyFrames).toBe(1);
    expect(linked.correlations.length).toBeGreaterThan(0);
    expect(linked.correlations[0].visualFindings).toEqual([]);

    // Reverse escalation: separate record fields have no baseline finding;
    // the linked dashboard image supplies the trigger to inspect them together.
    await writeFile(records, JSON.stringify({ id: "dashboard1", image: "dashboard.png",
      label: "API Token", value: "synthetic_dashboard_0123456789" }));
    const reverse = await scan([records], { mapping: { idPointer: "/id", assetPointer: "/image" } });
    expect(reverse.findings.some(f => f.recordId === "dashboard1" && f.pass === "scrutiny" && f.rule === "credential-field-text")).toBe(true);

    // Vandelay Daycap-style frame selector and verified extensionless media archive.
    const archive = join(dir, "archive"); await mkdir(archive);
    const bytes = await readFile(video), digest = hash(bytes);
    await copyFile(video, join(archive, digest));
    const record = {
      schema: "vandelay.record/v1", id: "capture/1", kind: "capture", text: "API_KEY=synthetic-record-secret",
      media: [{ sha256: digest, bytes: bytes.length, location: { kind: "archive-relative", path: digest },
        selector: { type: "video-frame", frame_index: 1, presentation: { value: "33333", timescale: 1000000 } } }],
    };
    await writeFile(records, JSON.stringify(record));
    const archived = await scan([records], { mediaArchive: archive });
    expect(archived.status).toBe("findings");
    expect(archived.coverage.frames).toBe(3);
    expect(archived.correlations.some(c => c.frame === 1 && c.visualFindings.length)).toBe(true);
    record.media[0].selector.frame_index = 7;
    await writeFile(records, JSON.stringify(record));
    const mismatched = await scan([records], { mediaArchive: archive });
    expect(mismatched.status).toBe("incomplete");
    expect(mismatched.issues.some(i => i.code === "frame-reference-mismatch")).toBe(true);

    const failed = await scan([join(dir, "clean.png")], { ocr: async () => ({
      recognize: async () => { throw new Error("simulated"); }, close: async () => {},
    }) });
    expect(failed.status).toBe("incomplete");
    expect(failed.coverage.frames).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 180_000);
