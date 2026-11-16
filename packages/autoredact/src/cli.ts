#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { scan } from "./scanner.ts";
import type { Mapping } from "./types.ts";
import { reviewCLI, reviewHelp } from "./review/cli.ts";

const help = `autoredact scan INPUT... [--media-archive DIR] [--mapping FILE] [--report FILE | --json]

Scan text/JSON/JSONL, images, videos, or directories (including Vandelay day/bundle directories).
All decoded video frames are scanned. External Vandelay media requires --media-archive.
--mapping FILE  JSON Pointer mapping for synchronized records (see agent-notes/autoredact.md).
--report FILE   Write a private JSON report (must not already exist).
--json          Write the full report to stdout, including when there are no findings.

Default: silence on a complete scan with no findings; locations/counts otherwise.
Exit 0: complete, no findings. 1: findings. 2: incomplete or invalid invocation.
No media or records are modified. OCR requires macOS, Swift, FFmpeg, and ffprobe.
${reviewHelp}
`;
export async function main(args = process.argv.slice(2)): Promise<number> {
  if (["review", "apply-review"].includes(args[0])) return reviewCLI(args);
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "media-archive": { type: "string" }, mapping: { type: "string" },
      report: { type: "string" }, json: { type: "boolean" },
    },
  });
  if (values.help) { console.log(help); return 0; }
  if (positionals.shift() !== "scan" || !positionals.length || (values.json && values.report)) {
    console.error(help); return 2;
  }
  let mapping: Mapping | undefined;
  if (values.mapping) {
    mapping = JSON.parse(await readFile(values.mapping, "utf8"));
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) ||
        Object.entries(mapping).some(([k, v]) => !["idPointer", "wallTimePointer", "assetPointer", "framePointer", "secondsPointer"].includes(k) ||
          typeof v !== "string" || (v !== "" && !v.startsWith("/")))) throw new Error();
  }
  // The report must be outside scanned directories; an existing report there
  // would itself be scanned. Exclusive creation below prevents overwriting inputs.
  if (values.report) {
    const out = resolve(values.report);
    for (const input of positionals) {
      const path = await realpath(input);
      if (out === path || out.startsWith(path + "/")) throw new Error();
    }
  }
  const expand = (p: string) => p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
  const report = await scan(positionals.map(expand), {
    mediaArchive: values["media-archive"] ? expand(values["media-archive"]) : undefined, mapping,
  });
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else if (report.status !== "no-findings") {
    console.error(`autoredact: ${report.findings.length} finding(s), ${report.issues.length} incomplete-scan issue(s).${values.report ? " See report." : ""}`);
    if (!values.report) {
      for (const f of report.findings.slice(0, 20)) {
        const location = f.frame !== undefined ? ` frame ${f.frame}${f.seconds !== undefined ? ` @ ${f.seconds}s` : ""}` : ` ${f.pointer ?? ""}`;
        console.error(`  ${f.severity}: ${f.rule} — ${JSON.stringify(f.source)}${location}`);
      }
      for (const issue of report.issues.slice(0, 20))
        console.error(`  incomplete: ${issue.code} — ${JSON.stringify(issue.source)}`);
      if (report.findings.length > 20 || report.issues.length > 20)
        console.error("  Output limited to 20 findings/issues; use --report FILE for a full report.");
    }
  }
  return report.status === "incomplete" ? 2 : report.status === "findings" ? 1 : 0;
}
if (import.meta.main) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error("autoredact: invalid invocation or scan/report failure (use --help).");
    process.exitCode = 2;
  });
}
