import React, { useEffect, useRef, useState } from "react";
import type { Box } from "../src/types.ts";
import type { AppliedMask, FrameRecord, Mask } from "../src/masks.ts";

export function MaskEditor({ frame, groupId, applied, maxFrame, imageURL, disabled, onDirty, save }: {
  frame: FrameRecord; groupId: string; applied: AppliedMask[]; maxFrame: number;
  imageURL: string; disabled: boolean; onDirty: (dirty: boolean) => void;
  save: (masks: Mask[]) => Promise<boolean>;
}) {
  const own = () => applied.filter(m => m.origin === groupId).map(({ origin, ...m }) => m);
  const [draft, setDraft] = useState<Mask[]>(own);
  const [selected, setSelected] = useState<number>();
  const [dirty, setDirty] = useState(false);
  const [ocr, setOCR] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; x: number; y: number; box: Box; resize: boolean } | undefined>(undefined);
  useEffect(() => { setDraft(own()); setDirty(false); onDirty(false); }, [applied]);
  const update = (masks: Mask[]) => { setDraft(masks); setDirty(true); onDirty(true); };
  const edit = (patch: Partial<Mask>) => {
    if (selected !== undefined) update(draft.map((m, i) => i === selected ? { ...m, ...patch } : m));
  };
  const mask = selected === undefined ? undefined : draft[selected];
  const style = (box: Box) => ({ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` });
  return <section className="mask-editor">
    <div className="inspector-toolbar"><strong>Mask editor · source-frame overlay</strong>
      <label><input type="checkbox" checked={ocr} onChange={e => setOCR(e.target.checked)} /> OCR anchors</label>
      <button disabled={disabled || !loaded} onClick={() => {
        setSelected(draft.length); update([...draft, { box: [0.25, 0.25, 0.2, 0.1] }]);
      }}>Add free mask</button>
    </div>
    <p>Click an OCR region to anchor a mask. Drag to move; drag its corner to resize. Black boxes are opaque.</p>
    {failed && <p role="alert">Source could not be verified or decoded.</p>}
    <div ref={canvas} className="mask-canvas" onPointerMove={e => {
      const d = drag.current, rect = canvas.current?.getBoundingClientRect();
      if (!d || !rect || disabled) return;
      const dx = (e.clientX - d.x) / rect.width, dy = (e.clientY - d.y) / rect.height;
      const [x, y, w, h] = d.box;
      const box: Box = d.resize
        ? [x, y, Math.max(0.002, Math.min(1 - x, w + dx)), Math.max(0.002, Math.min(1 - y, h + dy))]
        : [Math.max(0, Math.min(1 - w, x + dx)), Math.max(0, Math.min(1 - h, y + dy)), w, h];
      update(draft.map((m, i) => i === d.index ? { ...m, box } : m));
    }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      <img src={imageURL} alt={`Frame ${frame.frame} for mask review`} draggable={false}
        onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(false); }} />
      {loaded && ocr && frame.regions.map((r, i) => <button key={r.id} className="ocr-anchor"
        style={style(r.box)} aria-label={`Anchor OCR region ${i + 1}`} disabled={disabled}
        onClick={() => { setSelected(draft.length); update([...draft, { box: [...r.box], anchor: r }]); }} />)}
      {loaded && applied.filter(m => m.origin !== groupId).map((m, i) =>
        <div key={i} className="applied-mask propagated" style={style(m.box)} title="Following mask; edit on its originating frame" />)}
      {loaded && draft.map((m, i) => <div key={i} role="button" tabIndex={0}
        aria-label={`Mask ${i + 1}`} className={`applied-mask ${selected === i ? "selected" : ""}`}
        style={style(m.box)} onClick={() => setSelected(i)} onKeyDown={e => { if (e.key === "Enter") setSelected(i); }}
        onPointerDown={e => {
          if (disabled) return;
          setSelected(i); e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { index: i, x: e.clientX, y: e.clientY, box: [...m.box],
            resize: (e.target as HTMLElement).classList.contains("mask-handle") };
        }}><span className="mask-handle" /></div>)}
    </div>
    {mask && <div className="mask-properties">
      <strong>Mask {selected! + 1} · {mask.anchor ? "OCR anchored" : "Free rectangle"}</strong>
      {(["x", "y", "width", "height"] as const).map((name, i) => <label key={name}>{name}
        <input aria-label={`Mask ${name}`} type="number" min="0" max="1" step="0.001" disabled={disabled}
          value={Number(mask.box[i].toFixed(4))} onChange={e => {
            const box = [...mask.box] as Box; box[i] = Number(e.target.value);
            edit({ box });
          }} /></label>)}
      {mask.anchor && <>
        <label><input type="checkbox" checked={!!mask.scope} disabled={disabled} onChange={e =>
          edit({ scope: e.target.checked ? { start: frame.frame, end: maxFrame } : undefined })} />
          Follow matching OCR in this source</label>
        {mask.scope && <><label>First frame<input aria-label="First propagation frame" type="number" min="0"
          max={frame.frame} value={mask.scope.start} disabled={disabled} onChange={e => edit({ scope: { ...mask.scope!, start: Number(e.target.value) } })} /></label>
          <label>Last frame<input aria-label="Last propagation frame" type="number" min={frame.frame}
            max={maxFrame} value={mask.scope.end} disabled={disabled} onChange={e => edit({ scope: { ...mask.scope!, end: Number(e.target.value) } })} /></label></>}
      </>}
      <button disabled={disabled} onClick={() => { update(draft.filter((_, i) => i !== selected)); setSelected(undefined); }}>Delete mask</button>
    </div>}
    <div className="inspector-toolbar">
      <span>{draft.length} local masks · {applied.filter(m => m.origin !== groupId).length} following masks</span>
      <button disabled={disabled || !dirty || !loaded} onClick={async () => {
        if (await save(draft)) { setDirty(false); onDirty(false); }
      }}>Save masks</button>
      <button disabled={disabled || !dirty} onClick={() => { setDraft(own()); setDirty(false); onDirty(false); }}>Discard changes</button>
    </div>
    <p>Saving updates the plan and clears approval on affected frames. Review each propagated result before publishing.</p>
  </section>;
}
