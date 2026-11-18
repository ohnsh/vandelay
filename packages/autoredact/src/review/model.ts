import { hash } from "../rules.ts";
import type { Box, Finding, Report } from "../types.ts";
import { frameID, validBox, validatePlan, type MaskPlan } from "../masks.ts";

export type Decision = "publish" | "withhold";
export interface ReviewEntry { decision: Decision; note: string; updatedAt: string }
export interface ReviewState {
  schema: "autoredact.review/v1" | "autoredact.review/v2";
  reportSha256: string;
  revision: number;
  decisions: Record<string, ReviewEntry>;
  maskPlan?: MaskPlan;
}
export interface DisplayBox { box: Box; findingIds: string[]; rules: string[] }
export interface ReviewGroup {
  id: string;
  source: string;
  kind: "frame" | "text";
  frame?: number;
  seconds?: number;
  pointer?: string;
  wallTime?: string;
  recordId?: string;
  findings: Finding[];
  boxes: DisplayBox[];
}
export interface PublicationManifest {
  schema: "autoredact.publication/v1" | "autoredact.publication/v2";
  reportSha256: string;
  reviewSha256: string;
  reviewRevision: number;
  status: "complete" | "pending-review" | "incomplete-scan";
  scope: Report["policy"]["scope"];
  issues: Report["issues"];
  groups: {
    id: string; source: string; frame?: number; seconds?: number; pointer?: string;
    findingIds: string[]; decision: Decision | "unreviewed"; note?: string;
  }[];
  inputs: (Report["inputs"][number] & { decision: Decision | "unreviewed"; groupIds: string[] })[];
  maskPlan?: MaskPlan;
}
export function parseReport(bytes: Uint8Array): Report {
  const r = JSON.parse(new TextDecoder().decode(bytes)) as Report;
  if (r.schema !== "autoredact.scan/v1" || !Array.isArray(r.findings) ||
      !Array.isArray(r.inputs) || !Array.isArray(r.issues) || !Array.isArray(r.correlations) ||
      !r.policy || r.policy.scope !== "text-and-visual-secrets" ||
      !["no-findings", "findings", "incomplete"].includes(r.status)) throw new Error("invalid-report");
  const sources = new Map(r.inputs.map(i => [i.path, i]));
  if (sources.size !== r.inputs.length) throw new Error("duplicate-input");
  for (const i of r.inputs) {
    if (typeof i.path !== "string" || !/^[a-f0-9]{64}$/.test(i.sha256) ||
        !Number.isSafeInteger(i.bytes) || i.bytes < 0 || !["text", "media"].includes(i.kind))
      throw new Error("invalid-input");
  }
  const ids = new Set<string>();
  if (r.frames !== undefined) {
    if (!Array.isArray(r.frames)) throw new Error("invalid-frame-inventory");
    const seen = new Set<string>();
    for (const f of r.frames) {
      const key = frameID(f.source, f.frame);
      if (sources.get(f.source)?.kind !== "media" || !Number.isSafeInteger(f.frame) || f.frame < 0 ||
          seen.has(key) || (f.seconds !== undefined && !Number.isFinite(f.seconds)) || !Array.isArray(f.regions) ||
          f.regions.some(region => !region || !/^[a-f0-9]{64}$/.test(region.id) ||
            !/^[a-f0-9]{64}$/.test(region.textHash) || !validBox(region.box)) ||
          new Set(f.regions.map(r => r.id)).size !== f.regions.length) throw new Error("invalid-frame-inventory");
      seen.add(key);
    }
  }
  for (const f of r.findings) {
    if (typeof f.id !== "string" || !/^[a-f0-9]{64}$/.test(f.id) || ids.has(f.id) ||
        !sources.has(f.source) || typeof f.rule !== "string" ||
        !["ocr", "text", "scrutiny"].includes(f.pass) || !["high", "review"].includes(f.severity))
      throw new Error("invalid-finding");
    ids.add(f.id);
    if (f.frame !== undefined && (!Number.isSafeInteger(f.frame) || f.frame < 0 || sources.get(f.source)!.kind !== "media"))
      throw new Error("invalid-frame");
    if (f.seconds !== undefined && (!Number.isFinite(f.seconds) || f.seconds < 0)) throw new Error("invalid-time");
    if (f.pointer !== undefined && typeof f.pointer !== "string") throw new Error("invalid-pointer");
    if (f.boxes !== undefined && (!Array.isArray(f.boxes) || f.boxes.some(b =>
      !Array.isArray(b) || b.length !== 4 || b.some(n => !Number.isFinite(n) || n < 0 || n > 1.00001) ||
      b[2] <= 0 || b[3] <= 0 || b[0] + b[2] > 1.00001 || b[1] + b[3] > 1.00001))) throw new Error("invalid-box");
  }
  return r;
}

/** Display-only clustering. Original finding IDs and boxes always remain intact. */
export function displayBoxes(findings: Finding[]): DisplayBox[] {
  const boxes: DisplayBox[] = [];
  for (const f of findings) for (const box of f.boxes ?? []) {
    const existing = boxes.find(b => {
      const [x, y, w, h] = b.box, [xx, yy, ww, hh] = box;
      const intersection = Math.max(0, Math.min(x + w, xx + ww) - Math.max(x, xx)) *
        Math.max(0, Math.min(y + h, yy + hh) - Math.max(y, yy));
      return b.rules.includes(f.rule) && intersection / Math.min(w * h, ww * hh) > 0.65;
    });
    if (existing) {
      const [x, y, w, h] = existing.box, [xx, yy, ww, hh] = box;
      existing.box = [Math.min(x, xx), Math.min(y, yy), Math.max(x + w, xx + ww) - Math.min(x, xx), Math.max(y + h, yy + hh) - Math.min(y, yy)];
      if (!existing.findingIds.includes(f.id)) existing.findingIds.push(f.id);
    } else boxes.push({ box: [...box], findingIds: [f.id], rules: [f.rule] });
  }
  return boxes.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}
export function groupFindings(report: Report): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const f of report.findings) {
    const key = JSON.stringify([f.source, f.frame !== undefined ? ["frame", f.frame] : ["text", f.pointer ?? "#"]]);
    const id = hash(key);
    let group = groups.get(id);
    if (!group) {
      group = { id, source: f.source, kind: f.frame !== undefined ? "frame" : "text",
        frame: f.frame, seconds: f.seconds, pointer: f.pointer, wallTime: f.wallTime, recordId: f.recordId, findings: [], boxes: [] };
      groups.set(id, group);
    }
    group.findings.push(f);
  }
  for (const group of groups.values()) group.boxes = displayBoxes(group.findings);
  for (const f of report.frames ?? []) {
    const id = frameID(f.source, f.frame);
    if (!groups.has(id)) groups.set(id, { id, source: f.source, frame: f.frame,
      seconds: f.seconds, kind: "frame", findings: [], boxes: [] });
  }
  return [...groups.values()];
}
export function emptyReview(reportSha256: string): ReviewState {
  return { schema: "autoredact.review/v1", reportSha256, revision: 0, decisions: {} };
}
export function validateReview(value: unknown, reportSha256: string, groups: ReviewGroup[], report?: Report): ReviewState {
  const state = value as ReviewState;
  if (!state || !["autoredact.review/v1", "autoredact.review/v2"].includes(state.schema) || state.reportSha256 !== reportSha256 ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || !state.decisions ||
      typeof state.decisions !== "object" || Array.isArray(state.decisions)) throw new Error("invalid-or-mismatched-review");
  const known = new Set(groups.map(g => g.id));
  for (const [id, entry] of Object.entries(state.decisions)) {
    if (!known.has(id) || !entry || !["publish", "withhold"].includes(entry.decision) ||
        typeof entry.note !== "string" || entry.note.length > 4000 ||
        typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error("invalid-review-entry");
  }
  if ((state.schema === "autoredact.review/v2") !== (state.maskPlan !== undefined)) throw new Error("invalid-review-schema");
  if (state.maskPlan) {
    if (!report) throw new Error("mask-plan-requires-report");
    validatePlan(state.maskPlan, report);
  }
  return state;
}
export function publication(report: Report, reportSha256: string, state: ReviewState, reviewSha256 = hash(JSON.stringify(state))): PublicationManifest {
  const groups = groupFindings(report);
  validateReview(state, reportSha256, groups, report);
  const incomplete = report.status === "incomplete" || report.issues.length > 0;
  const required = (g: ReviewGroup) => g.findings.length > 0 || !!state.maskPlan?.reviewFrames.includes(g.id);
  const pending = groups.some(g => required(g) && !state.decisions[g.id]);
  return {
    schema: state.maskPlan ? "autoredact.publication/v2" : "autoredact.publication/v1", reportSha256, reviewSha256, reviewRevision: state.revision,
    status: incomplete ? "incomplete-scan" : pending ? "pending-review" : "complete",
    scope: report.policy.scope, issues: report.issues,
    ...(state.maskPlan ? { maskPlan: state.maskPlan } : {}),
    groups: groups.map(g => ({
      id: g.id, source: g.source, frame: g.frame, seconds: g.seconds, pointer: g.pointer,
      findingIds: g.findings.map(f => f.id), decision: state.decisions[g.id]?.decision ?? "unreviewed", note: state.decisions[g.id]?.note,
    })),
    inputs: report.inputs.map(input => {
      const relevant = groups.filter(g => g.source === input.path);
      // Whole files are the unit of publication in this first manifest. One
      // withheld frame means the original video cannot be published unchanged.
      const decision = relevant.some(g => state.decisions[g.id]?.decision === "withhold" || state.maskPlan?.frames[g.id]?.length) ? "withhold" :
        incomplete || relevant.some(g => required(g) && !state.decisions[g.id]) ? "unreviewed" : "publish";
      return { ...input, decision, groupIds: relevant.map(g => g.id) };
    }),
  };
}
