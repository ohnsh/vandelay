import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hash } from "../rules.ts";
import { groupFindings, parseReport, publication, validateReview } from "./model.ts";
import { startReview } from "./server.ts";

export const reviewHelp = `
autoredact review REPORT.json [--state REVIEW.json] [--port 4317]
  Open a local React review app. Default state: REPORT.review.json.
  Report stays immutable; decisions are saved separately after each action.

autoredact apply-review REPORT.json --review REVIEW.json --out PUBLICATION.json
  Apply hash-bound decisions to produce a new publication manifest.
  Exit 0: review complete. Exit 1: unreviewed items. Exit 2: incomplete scan/error.
  Withheld items remain withheld; no source files are altered or published.
`;
export async function reviewCLI(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      help: { type: "boolean", short: "h" }, state: { type: "string" },
      port: { type: "string" }, review: { type: "string" }, out: { type: "string" },
    },
  });
  if (values.help) { console.log(reviewHelp); return 0; }
  const [command, report] = positionals;
  if (!report || positionals.length !== 2) throw new Error("review-arguments-required");
  if (command === "review") {
    if (values.review || values.out) throw new Error("invalid-review-option");
    const port = values.port === undefined ? 4317 : Number(values.port);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("invalid-port");
    const state = values.state ?? report.replace(/\.json$/i, "") + ".review.json";
    const { url } = await startReview(report, state, port);
    console.log(`AutoRedact review: ${url}\nDecisions: ${resolve(state)}\nCtrl+C to stop.`);
    return 0;
  }
  if (command !== "apply-review" || !values.review || !values.out || values.state || values.port)
    throw new Error("invalid-apply-review-options");
  const reportBytes = await readFile(report), reviewBytes = await readFile(values.review);
  const parsed = parseReport(reportBytes), reportHash = hash(reportBytes);
  const state = validateReview(JSON.parse(reviewBytes.toString()), reportHash, groupFindings(parsed));
  const manifest = publication(parsed, reportHash, state, hash(reviewBytes));
  await writeFile(values.out, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest.status === "complete" ? 0 : manifest.status === "pending-review" ? 1 : 2;
}
