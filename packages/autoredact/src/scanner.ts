import { inventory, fileHash, type InputOptions } from "./inputs.ts";
import { frames, probe } from "./media.ts";
import { visionOCR } from "./ocr.ts";
import { hash, rulesIdentity, scanOCR, scanText, type Match } from "./rules.ts";
import { fingerprint } from "./masks.ts";
import type { Anchor, Finding, OCR, Report, TextItem } from "./types.ts";

export interface ScanOptions extends InputOptions {
  /** Dependency injection for alternate local OCR implementations and tests. */
  ocr?: () => Promise<OCR>;
}
export async function scan(paths: string[], options: ScanOptions = {}): Promise<Report> {
  const input = await inventory(paths, options);
  const report: Report = {
    schema: "autoredact.scan/v1", scanner: "autoredact/0.3.0",
    rules: rulesIdentity,
    policy: { video: "every-decoded-frame", ocr: "apple-vision-accurate", scrutiny: "overlapping-tiles", scope: "text-and-visual-secrets" },
    status: "no-findings", inputs: input.files,
    coverage: { textItems: 0, frames: 0, scrutinyFrames: 0, emptyOCRFrames: 0 },
    findings: [], correlations: [], issues: [...input.issues], frames: [],
  };
  const seen = new Set<string>();
  function finding(match: Match, location: Omit<Finding, "id" | "rule" | "severity" | "boxes">): string {
    const value = { ...location, ...match };
    const id = hash(JSON.stringify(value));
    if (!seen.has(id)) { seen.add(id); report.findings.push({ id, ...value }); }
    return id;
  }
  const triggers: { finding: string; anchor: Anchor }[] = [];
  const textGroups = new Map<string, TextItem[]>();
  for (const text of input.texts) {
    report.coverage.textItems++;
    for (const match of scanText(text.text)) {
      const id = finding(match, { source: text.source, pointer: text.pointer, recordId: text.context.id,
        wallTime: text.context.wallTime, pass: "text" });
      for (const anchor of text.context.anchors ?? []) triggers.push({ finding: id, anchor });
    }
    for (const anchor of text.context.anchors ?? []) {
      const key = anchor.asset;
      if (!textGroups.has(key)) textGroups.set(key, []);
      textGroups.get(key)!.push(text);
    }
  }
  let ocr: OCR | undefined;
  try {
    for (const file of input.files.filter(f => f.kind === "media")) {
      try {
        ocr ??= await (options.ocr ?? visionOCR)();
        const info = await probe(file.path);
        const anchors = (textGroups.get(file.path) ?? []).flatMap(t => t.context.anchors ?? [])
          .filter(a => a.asset === file.path);
        if (anchors.some(a => a.frame !== undefined &&
          (a.frame >= info.times.length || (!info.image && a.seconds !== undefined &&
            Math.abs(info.times[a.frame] - a.seconds) > 0.00001))))
          report.issues.push({ source: file.path, code: "frame-reference-mismatch" });
        let count = 0;
        // Images are decoded through FFmpeg too, covering extensionless archive objects.
        for await (const frame of frames(file.path, info.times)) {
          count++;
          const location = { source: file.path, frame: frame.index,
            seconds: info.image ? undefined : frame.seconds, pass: "ocr" as const };
          const linked = triggers.filter(t => t.anchor.asset === file.path &&
            (t.anchor.frame !== undefined ? t.anchor.frame === frame.index :
              t.anchor.seconds !== undefined ? Math.abs(t.anchor.seconds - (frame.seconds ?? 0)) <= 0.5 : info.image));
          const base = await ocr.recognize(frame.path);
          report.frames!.push({ source: file.path, frame: frame.index,
            seconds: info.image ? undefined : frame.seconds,
            regions: base.lines.map((line, i) => ({
              id: hash(JSON.stringify([file.sha256, frame.index, i, line.box])),
              box: line.box, textHash: fingerprint(line.text),
            })) });
          report.coverage.frames++;
          if (!base.lines.length) report.coverage.emptyOCRFrames++;
          const matches = scanOCR(base.lines);
          const ids = matches.map(m => finding(m, location));
          if (matches.length || linked.length || !base.lines.length) {
            const detail = await ocr.recognize(frame.path, true);
            report.coverage.scrutinyFrames++;
            ids.push(...scanOCR(detail.lines).map(m => finding(m, { ...location, pass: "scrutiny" })));
            // Successful OCR yielding no text is tracked, not silently equated with
            // an OCR exception. It may legitimately be a blank/photo frame.
          }
          for (const link of linked) {
            report.correlations.push({
              textFinding: link.finding, media: file.path, frame: frame.index,
              basis: link.anchor.frame !== undefined ? "frame-reference" : "media-time", visualFindings: ids,
            });
          }
          if (ids.length) {
            // Visual findings rescan the associated record's combined fields, making
            // split text labels/values visible to the same context rules.
            const related = (textGroups.get(file.path) ?? []).filter(t =>
              t.context.anchors?.some(a => a.asset === file.path &&
                (a.frame !== undefined ? a.frame === frame.index :
                  a.seconds !== undefined ? Math.abs(a.seconds - (frame.seconds ?? 0)) <= 0.5 : info.image)));
            const groups = new Map<string, TextItem[]>();
            for (const t of related) {
              const key = `${t.source}:${t.recordPointer}`;
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(t);
            }
            for (const group of groups.values()) {
              const combined = group.filter(t => t.value !== undefined).map(t => t.value).join("\n");
              for (const m of scanText(combined)) {
                const t = group[0];
                const id = finding(m, { source: t.source, pointer: t.recordPointer,
                  recordId: t.context.id, wallTime: t.context.wallTime, pass: "scrutiny" });
                const anchor = t.context.anchors?.find(a => a.asset === file.path);
                report.correlations.push({ textFinding: id, media: file.path, frame: frame.index,
                  basis: anchor?.frame !== undefined ? "frame-reference" : "media-time", visualFindings: ids });
              }
            }
          }
        }
        if (!count) report.issues.push({ source: file.path, code: "no-decoded-frames" });
      } catch {
        report.issues.push({ source: file.path, code: "media-scan-incomplete" });
      }
    }
  } finally { await ocr?.close(); }
  // Bind the report to stable bytes; a changed input invalidates scan completion.
  for (const file of input.files) {
    try {
      if (await fileHash(file.path) !== file.sha256) throw new Error();
    } catch { report.issues.push({ source: file.path, code: "input-changed-during-scan" }); }
  }
  report.status = report.issues.length ? "incomplete" : report.findings.length ? "findings" : "no-findings";
  return report;
}
