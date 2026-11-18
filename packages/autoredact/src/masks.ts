import { hash } from "./rules.ts";
import type { Box, Report } from "./types.ts";

export interface OCRRegion { id: string; box: Box; textHash: string }
export interface FrameRecord {
  source: string;
  frame: number;
  seconds?: number;
  regions: OCRRegion[];
}
export interface Mask {
  box: Box;
  /** Anchor geometry never changes when the mask is moved or resized. */
  anchor?: OCRRegion;
  /** Inclusive, explicitly selected range in this source object only. */
  scope?: { start: number; end: number };
}
export interface AppliedMask extends Mask { origin: string }
export interface MaskPlan {
  schema: "autoredact.masks/v1";
  frames: Record<string, AppliedMask[]>;
  /** Includes frames whose last mask was removed: deletion also needs review. */
  reviewFrames: string[];
}
export const frameID = (source: string, frame: number) => hash(JSON.stringify([source, ["frame", frame]]));
export const fingerprint = (text: string) => hash(text.normalize("NFC").trim().replace(/\s+/gu, " "));
export const validBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 &&
  b.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
  b[2] > 0 && b[3] > 0 && b[0] + b[2] <= 1.000001 && b[1] + b[3] <= 1.000001;
export function follow(mask: Box, anchor: Box, target: Box): Box | undefined {
  const x = target[0] + (mask[0] - anchor[0]) / anchor[2] * target[2];
  const y = target[1] + (mask[1] - anchor[1]) / anchor[3] * target[3];
  const right = Math.min(1, x + mask[2] / anchor[2] * target[2]);
  const bottom = Math.min(1, y + mask[3] / anchor[3] * target[3]);
  const left = Math.max(0, x), top = Math.max(0, y);
  return right > left && bottom > top ? [left, top, right - left, bottom - top] : undefined;
}
export function validateMask(mask: Mask, origin: FrameRecord, frames: FrameRecord[]) {
  if (!mask || !validBox(mask.box)) throw new Error("invalid-mask");
  if (mask.anchor && !origin.regions.some(r => r.id === mask.anchor!.id &&
      r.textHash === mask.anchor!.textHash && JSON.stringify(r.box) === JSON.stringify(mask.anchor!.box)))
    throw new Error("invalid-mask-anchor");
  if (mask.scope) {
    const { start, end } = mask.scope;
    if (!mask.anchor || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || origin.frame < start || origin.frame > end ||
        frames.filter(f => f.source === origin.source && f.frame >= start && f.frame <= end).length !== end - start + 1)
      throw new Error("invalid-mask-scope");
  }
}
/** Pure planning: source adapters supply a verified frame/OCR inventory. */
export function planMasks(report: Report, previous: MaskPlan | undefined, originID: string, masks: Mask[]): MaskPlan {
  const frames = report.frames ?? [];
  const origin = frames.find(f => frameID(f.source, f.frame) === originID);
  if (!origin || !Array.isArray(masks) || masks.length > 200) throw new Error("invalid-mask-frame");
  const plan: MaskPlan = { schema: "autoredact.masks/v1", frames: {}, reviewFrames: [...(previous?.reviewFrames ?? [])] };
  for (const [id, values] of Object.entries(previous?.frames ?? {})) {
    const keep = values.filter(m => m.origin !== originID);
    if (keep.length) plan.frames[id] = keep;
  }
  const hashes = new Map(report.inputs.map(i => [i.path, i.sha256]));
  const aliases = new Map<string, FrameRecord[]>();
  for (const f of frames) {
    const key = `${hashes.get(f.source)}:${f.frame}`;
    const list = aliases.get(key) ?? [];
    list.push(f); aliases.set(key, list);
  }
  const add = (f: FrameRecord, mask: Mask) => {
    // Identical physical bytes share edits even when records name different paths.
    for (const alias of aliases.get(`${hashes.get(f.source)}:${f.frame}`) ?? []) {
      const id = frameID(alias.source, alias.frame);
      (plan.frames[id] ??= []).push({ ...(id === originID ? mask : { box: mask.box }), origin: originID });
    }
  };
  for (const mask of masks) {
    validateMask(mask, origin, frames);
    add(origin, mask);
    if (!mask.scope || !mask.anchor) continue;
    for (const f of frames) {
      if (f.source !== origin.source || f.frame === origin.frame ||
          f.frame < mask.scope.start || f.frame > mask.scope.end) continue;
      for (const region of f.regions.filter(r => r.textHash === mask.anchor!.textHash)) {
        const box = follow(mask.box, mask.anchor.box, region.box);
        if (box) add(f, { box });
      }
    }
  }
  const touched = new Set(plan.reviewFrames);
  for (const id of new Set([...Object.keys(previous?.frames ?? {}), ...Object.keys(plan.frames)])) {
    if (JSON.stringify(previous?.frames[id]) !== JSON.stringify(plan.frames[id])) touched.add(id);
  }
  plan.reviewFrames = [...touched].sort();
  return plan;
}
/** Validate persisted expansions by rebuilding from their origin masks. */
export function validatePlan(plan: MaskPlan, report: Report): void {
  if (!plan || plan.schema !== "autoredact.masks/v1" || !plan.frames || Array.isArray(plan.frames))
    throw new Error("invalid-mask-plan");
  let rebuilt: MaskPlan | undefined;
  const known = new Set((report.frames ?? []).map(f => frameID(f.source, f.frame)));
  if (!Array.isArray(plan.reviewFrames) || plan.reviewFrames.some(id => !known.has(id)) ||
      new Set(plan.reviewFrames).size !== plan.reviewFrames.length ||
      Object.keys(plan.frames).some(id => !plan.reviewFrames.includes(id))) throw new Error("invalid-mask-plan");
  for (const [id, masks] of Object.entries(plan.frames)) {
    if (!known.has(id) || !Array.isArray(masks) || !masks.length ||
        masks.some(m => !m || !known.has(m.origin) || !validBox(m.box))) throw new Error("invalid-mask-plan");
    const own = masks.filter(m => m.origin === id).map(({ origin, ...m }) => m);
    if (own.length) rebuilt = planMasks(report, rebuilt, id, own);
  }
  const canonical = (p: MaskPlan | undefined) => JSON.stringify(Object.entries(p?.frames ?? {})
    .sort(([a], [b]) => a.localeCompare(b)).map(([id, ms]) => [id, ms.map(m => JSON.stringify([
      m.origin, m.box, m.anchor ?? null, m.scope ?? null,
    ])).sort()]));
  if (canonical(plan) !== canonical(rebuilt)) throw new Error("invalid-mask-plan");
}
/** Rounded outwards: even fractional edge pixels must be covered. Runs before scaling. */
export function maskFilters(masks: { frame?: number; box: Box }[]): string[] {
  return masks.map(({ frame, box: [x, y, w, h] }) =>
    `drawbox=x=floor(iw*${x}):y=floor(ih*${y}):w=ceil(iw*${x + w})-floor(iw*${x}):h=ceil(ih*${y + h})-floor(ih*${y}):color=black:t=fill:replace=1` +
    (frame === undefined ? "" : `:enable='eq(n,${frame})'`));
}
