import { hash } from "../src/rules.ts";
import type { Report } from "../src/types.ts";

export function fixtureReport(source: string, bytes: Uint8Array, media = true): Report {
  return {
    schema: "autoredact.scan/v1", scanner: "autoredact/0.2.0",
    rules: { version: "secrets/1", sha256: hash("rules") },
    policy: { video: "every-decoded-frame", ocr: "apple-vision-accurate", scrutiny: "overlapping-tiles", scope: "text-and-visual-secrets" },
    status: "findings", inputs: [{ path: source, sha256: hash(bytes), bytes: bytes.length, kind: media ? "media" : "text" }],
    coverage: { frames: media ? 1 : 0, textItems: media ? 0 : 1, scrutinyFrames: 1, emptyOCRFrames: 0 },
    findings: [
      { id: hash("baseline"), source, frame: media ? 0 : undefined, pointer: media ? undefined : "line:1#/text",
        rule: "secret-assignment", severity: "review", pass: media ? "ocr" : "text", boxes: media ? [[0.1, 0.2, 0.3, 0.04]] : undefined },
      { id: hash("scrutiny"), source, frame: media ? 0 : undefined, pointer: media ? undefined : "line:1#/text",
        rule: "secret-assignment", severity: "review", pass: "scrutiny", boxes: media ? [[0.1, 0.21, 0.3, 0.02]] : undefined },
    ], correlations: [], issues: [],
  };
}
