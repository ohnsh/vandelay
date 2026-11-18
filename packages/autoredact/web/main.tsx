import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Report } from "../src/types.ts";
import type { Decision, ReviewEntry, ReviewGroup, ReviewState } from "../src/review/model.ts";
import "./style.css";
import { MaskEditor } from "./mask-editor.tsx";
import type { Mask, AppliedMask } from "../src/masks.ts";
const noMasks: AppliedMask[] = [];

interface Session {
  name: string; reportSha256: string; report: Report;
  groups: ReviewGroup[]; review: ReviewState; statePath: string;
}
type Filter = "unreviewed" | "all" | Decision;
const token = document.querySelector<HTMLMetaElement>('meta[name="review-token"]')!.content;
const assetURL = (path: string) => `${path}?token=${encodeURIComponent(token)}`;
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "x-review-token": token, "Content-Type": "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "request-failed");
  return body;
}
const short = (path: string) => {
  const name = path.split("/").pop() ?? path;
  return name.length > 30 ? name.slice(0, 16) + "…" + name.slice(-6) : name;
};
const label = (g: ReviewGroup) => g.wallTime ? new Date(g.wallTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) :
  g.kind === "frame" ? `Frame ${g.frame}` : g.recordId ?? "Text record";
const countLabel = (n: number, singular: string) => `${n.toLocaleString()} ${singular}${n === 1 ? "" : "s"}`;
const decisionLabel = (d?: Decision) => d === "withhold" ? "Withhold" : d === "publish" ? "Publish" : "Unreviewed";
const required = (g: ReviewGroup, state: ReviewState) => g.findings.length > 0 || !!state.maskPlan?.reviewFrames.includes(g.id);

function App() {
  const [session, setSession] = useState<Session>();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("unreviewed");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [note, setNote] = useState("");
  const [autoNext, setAutoNext] = useState(true);
  const [undo, setUndo] = useState<{ id: string; previous?: ReviewEntry }>();
  const [dirty, setDirty] = useState(false);
  const busy = useRef(false);
  const load = useCallback(async () => {
    setError("");
    try {
      const data = await api<Session>("/api/session");
      setSession(data);
      setSelected(data.groups.find(g => required(g, data.review) && !data.review.decisions[g.id])?.id ?? null);
    } catch (e) { setError(String((e as Error).message)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const group = session?.groups.find(g => g.id === selected);
  const entry = selected ? session?.review.decisions[selected] : undefined;
  useEffect(() => { setNote(entry?.note ?? ""); }, [selected, entry?.note]);
  const matches = (g: ReviewGroup, state: ReviewState) =>
    (filter === "all" || ((filter !== "unreviewed" || required(g, state)) && (state.decisions[g.id]?.decision ?? "unreviewed") === filter)) &&
    `${g.source} ${g.recordId ?? ""} ${g.frame ?? ""} ${label(g)} ${g.findings.map(f => f.rule).join(" ")}`.toLowerCase().includes(query.toLowerCase());
  const visible = session?.groups.filter(g => matches(g, session.review)) ?? [];
  const requiredGroups = session?.groups.filter(g => required(g, session.review)) ?? [];
  const reviewed = session ? requiredGroups.filter(g => session.review.decisions[g.id]).length : 0;
  const withheld = session ? requiredGroups.filter(g => session.review.decisions[g.id]?.decision === "withhold").length : 0;
  const published = reviewed - withheld;
  const remaining = requiredGroups.length - reviewed;
  const navigate = (direction: number) => {
    if (busy.current || dirty || !visible.length) return;
    const index = visible.findIndex(g => g.id === selected);
    setSelected(visible[Math.max(0, Math.min(visible.length - 1, index + direction))].id);
  };
  const decide = async (decision: Decision | null, id = selected, previousNote = note, isUndo = false) => {
    if (!session || !id || busy.current || dirty) return;
    busy.current = true; setSaving(true); setError("");
    try {
      const previous = session.review.decisions[id];
      const review = await api<ReviewState>("/api/decision", { method: "POST", body: JSON.stringify({
        revision: session.review.revision, groupId: id, decision, note: previousNote,
      }) });
      setSession({ ...session, review });
      setSaved(`Saved · revision ${review.revision}`);
      if (isUndo) { setUndo(undefined); setSelected(id); }
      else {
        setUndo({ id, previous });
        if (autoNext && decision !== null) {
          const index = session.groups.findIndex(g => g.id === id);
          const candidates = [...session.groups.slice(index + 1), ...session.groups.slice(0, index)];
          setSelected(candidates.find(g => !review.decisions[g.id] && matches(g, review))?.id ?? null);
        }
      }
    } catch (e) {
      const code = (e as Error).message;
      setError(code.includes("conflict") || code.includes("changed-on-disk") ?
        "This review changed in another session. Reload before continuing; your last action was not saved." : `Could not save: ${code}`);
    } finally { busy.current = false; setSaving(false); }
  };
  const saveMasks = async (masks: Mask[]) => {
    if (!session || !selected || busy.current) return false;
    busy.current = true; setSaving(true); setError("");
    try {
      const review = await api<ReviewState>("/api/masks", { method: "POST", body: JSON.stringify({
        revision: session.review.revision, groupId: selected, masks,
      }) });
      setSession({ ...session, review }); setUndo(undefined);
      setSaved(`Masks saved · revision ${review.revision}`); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { busy.current = false; setSaving(false); }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.closest("input,textarea,select,[contenteditable]")) return;
      const key = event.key.toLowerCase();
      if (event.repeat && ["c", "f", "u"].includes(key)) return;
      if (["j", "arrowright", "k", "arrowleft", "c", "f", "u"].includes(key)) event.preventDefault();
      if (key === "j" || key === "arrowright") navigate(1);
      if (key === "k" || key === "arrowleft") navigate(-1);
      if (group && key === "c") void decide("withhold");
      if (group && key === "f") void decide("publish");
      if (group && key === "u") void decide(null);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  if (!session) return <div className="loading-page"><div className="brand-mark">a</div>
    <h1>AutoRedact review</h1><p>{error || "Opening your scan…"}</p>{error && <button onClick={load}>Try again</button>}</div>;
  const incomplete = session.report.status === "incomplete" || session.report.issues.length > 0;
  const progress = requiredGroups.length ? reviewed / requiredGroups.length * 100 : 100;
  const related = group ? session.report.correlations.flatMap(c => {
    const ids = new Set(group.findings.map(f => f.id));
    if (!ids.has(c.textFinding) && !c.visualFindings.some(id => ids.has(id))) return [];
    return session.groups.filter(g => g.id !== group.id &&
      g.findings.some(f => f.id === c.textFinding || c.visualFindings.includes(f.id))).map(g => g.id);
  }) : [];
  return <div className="app">
    <header className="header">
      <div className="brand"><span className="brand-mark">a</span><span>autoredact <span className="muted">/</span> <strong>review</strong></span><span className="local-pill">LOCAL</span></div>
      <div className="header-actions">
        <span className="save-status" role="status" title={session.statePath}>{saving ? "Saving…" : saved || "Decisions save automatically"}</span>
        <a className="button quiet" href={assetURL("/api/review")} download>Review file ↓</a>
        <a className="button primary" href={assetURL("/api/publication")} download>Export manifest <span>↗</span></a>
      </div>
    </header>
    <section className="overview">
      <div><div className="eyebrow">PRE-PUBLICATION CHECK</div><h1>Keep the work. Catch the secrets.</h1>
        <p className="report-name">{session.name} <span className="dot">·</span> {countLabel(session.report.coverage.frames, "frame")} scanned <span className="dot">·</span> {countLabel(session.report.findings.length, "finding")}</p></div>
      <div className="progress-block">
        <div className="progress-caption"><strong>{reviewed}<span> / {requiredGroups.length} required reviews</span></strong><span>{Math.round(progress)}%</span></div>
        <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
        <div className="progress-legend"><span><i className="dot-publish" /> {published} publish</span><span><i className="dot-withhold" /> {withheld} withhold</span><span>{remaining} remaining</span></div>
      </div>
    </section>
    {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={load} disabled={saving}>Reload review</button></div>}
    {incomplete && <div className="banner warning"><span><strong>Scan incomplete.</strong> Decisions can be saved, but the publication manifest stays incomplete. {session.report.issues.length} scan issue(s).</span>
      <details><summary>Show issues</summary>{session.report.issues.map((issue, i) => <p key={i}>{issue.code} · {short(issue.source)}</p>)}</details></div>}
    <main className="workspace">
      <aside className="queue">
        <div className="queue-heading"><h2>Review queue</h2><span className="count">{session.groups.length}</span></div>
        <p className="queue-explanation">Pending shows findings and edited frames.<br />All includes every inventoried frame for manual masking.</p>
        <input className="search" aria-label="Search findings" placeholder="Search rules, files, frames…" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="filters" aria-label="Filter review items">
          {(["unreviewed", "all", "withhold", "publish"] as Filter[]).map(f => <button key={f} className={filter === f ? "active" : ""}
            disabled={saving || dirty} onClick={() => { setFilter(f); const next = session.groups.find(g => f === "all" || ((f !== "unreviewed" || required(g, session.review)) && (session.review.decisions[g.id]?.decision ?? "unreviewed") === f)); setSelected(next?.id ?? null); }}>
            {f === "unreviewed" ? "Pending" : f === "all" ? "All" : decisionLabel(f)}{f === "unreviewed" && <span>{remaining}</span>}
          </button>)}
        </div>
        <div className="queue-list">
          {visible.map(g => {
            const decision = session.review.decisions[g.id]?.decision;
            return <button key={g.id} className={`queue-item ${selected === g.id ? "selected" : ""}`} onClick={() => setSelected(g.id)} disabled={saving || dirty}>
              <div className={`queue-icon ${decision ?? ""}`}>{decision === "publish" ? "✓" : decision === "withhold" ? "−" : g.kind === "frame" ? "▣" : "≡"}</div>
              <div className="queue-item-body"><div className="queue-title">{label(g)}<span className={`tiny-status ${decision ?? ""}`}>{decisionLabel(decision)}</span></div>
                <div className="queue-source">{short(g.source)}</div>
                <div className="queue-rule">{session.review.maskPlan?.frames[g.id]?.length ? "Masked · " : ""}{[...new Set(g.findings.map(f => f.rule))].join(" · ") || "No automatic findings"}</div>
                <div className="queue-meta">{g.kind === "frame" ? `${g.boxes.length} regions · ${g.findings.length} detections` : countLabel(g.findings.length, "detection")}</div>
              </div>
            </button>;
          })}
          {!visible.length && <div className="empty-queue">No items in this view.</div>}
        </div>
        <div className="queue-footer"><span className="lock-dot" /> Report is read-only <span title={session.reportSha256}>{session.reportSha256.slice(0, 8)}</span></div>
      </aside>
      <section className="review-area">
        {group ? <>
          <div className="item-header">
            <div><div className="eyebrow">{group.kind === "frame" ? "FRAME INSPECTION" : "TEXT INSPECTION"}</div>
              <h2>{label(group)} <span className={`status-badge ${entry?.decision ?? ""}`}>{decisionLabel(entry?.decision)}</span></h2>
              <p>{group.wallTime ? new Date(group.wallTime).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) + " · " : ""}
                {group.kind === "frame" ? `Frame ${group.frame}${group.seconds !== undefined ? ` · ${group.seconds.toFixed(3)}s in source` : ""}` : group.pointer}
                {group.recordId && ` · ${group.recordId}`}</p>
            </div>
            <div className="navigation"><button aria-label="Previous item" title="Previous (K)" onClick={() => navigate(-1)} disabled={saving || visible.findIndex(g => g.id === selected) <= 0}>←</button>
              <span>{Math.max(0, visible.findIndex(g => g.id === selected) + 1)} / {visible.length}</span>
              <button aria-label="Next item" title="Next (J)" onClick={() => navigate(1)} disabled={saving || visible.findIndex(g => g.id === selected) >= visible.length - 1}>→</button></div>
          </div>
          {session.report.frames?.find(f => f.source === group.source && f.frame === group.frame) ? <><MaskEditor
            key={group.id} groupId={group.id} frame={session.report.frames.find(f => f.source === group.source && f.frame === group.frame)!}
            maxFrame={Math.max(...session.report.frames.filter(f => f.source === group.source).map(f => f.frame))}
            applied={session.review.maskPlan?.frames[group.id] ?? noMasks}
            imageURL={assetURL(`/api/frame/${group.id}`)} disabled={saving} onDirty={setDirty} save={saveMasks} />
            <details className="provenance"><summary>Source & original detections · {group.findings.length} findings</summary>
              <div className="source-path">{group.source}</div>
              {group.findings.map(f => <div key={f.id}><strong>{f.rule}</strong> · {f.severity} · {f.pass}
                <pre>{JSON.stringify({ id: f.id, boxes: f.boxes }, null, 2)}</pre></div>)}
            </details></> :
            <Inspector key={group.id} group={group} />}
          {[...new Set((session.review.maskPlan?.frames[group.id] ?? []).map(m => m.origin))].filter(id => id !== group.id)
            .map(id => <button key={id} disabled={saving || dirty} onClick={() => { setFilter("all"); setSelected(id); }}>
              Edit following-mask origin · {label(session.groups.find(g => g.id === id)!)}
            </button>)}
          {!!related.length && <div className="related">Linked evidence: {[...new Set(related)].map(id => <button key={id} disabled={dirty || saving} onClick={() => setSelected(id)}>{label(session.groups.find(g => g.id === id)!)}</button>)}</div>}
          <div className="decision-panel">
            <div className="decision-heading"><div><h3>Your decision</h3><p>Applies to all {group.findings.length} detections on this {group.kind === "frame" ? "frame" : "text item"}.</p></div>
              {entry && <button className="text-button" onClick={() => decide(null)} disabled={saving}>Reset to unreviewed <kbd>U</kbd></button>}</div>
            <label className="note-label" htmlFor="note">Review note <span>optional · saved with your decision</span></label>
            <textarea id="note" value={note} maxLength={4000} rows={2} placeholder="Why should this be withheld or published?" onChange={e => setNote(e.target.value)} disabled={saving} />
            <div className="decision-actions">
              <button className={`decision withhold ${entry?.decision === "withhold" ? "chosen" : ""}`} onClick={() => decide("withhold")} disabled={saving || dirty}>
                <span className="decision-symbol">−</span><span><strong>Confirmed · withhold</strong><small>Keep this item out of publication</small></span><kbd>C</kbd>
              </button>
              <button className={`decision publish ${entry?.decision === "publish" ? "chosen" : ""}`} onClick={() => decide("publish")} disabled={saving || dirty}>
                <span className="decision-symbol">✓</span><span><strong>{session.review.maskPlan?.frames[group.id]?.length ? "Approve masked frame" : "False positive · publish"}</strong><small>Approve the saved rendition for publication</small></span><kbd>F</kbd>
              </button>
            </div>
            <div className="decision-bottom"><label><input type="checkbox" checked={autoNext} onChange={e => setAutoNext(e.target.checked)} /> Advance to next unreviewed item</label>
              {undo && <button className="text-button" disabled={saving} onClick={() => decide(undo.previous?.decision ?? null, undo.id, undo.previous?.note ?? "", true)}>Undo last decision</button>}</div>
          </div>
        </> : <div className="completion">
          <div className="completion-icon">{remaining === 0 ? "✓" : "▣"}</div>
          <div className="eyebrow">{remaining === 0 ? "QUEUE COMPLETE" : "REVIEW WORKSPACE"}</div>
          <h2>{remaining === 0 ? "Every flagged item has a decision." : "Select an item to inspect."}</h2>
          <p>{remaining === 0 ? `${published} marked for publication. ${withheld} marked to withhold.` : `${remaining} items still need review. You can filter the queue on the left.`}</p>
          <p className="completion-detail">{incomplete ? "The scan has unresolved coverage issues; the manifest will reflect them." : "Your decisions are saved separately. The original scan report stays untouched."}</p>
          <a className="button primary" href={assetURL("/api/publication")} download>Export publication manifest ↗</a>
          {undo && <button className="text-button" disabled={saving} onClick={() => decide(undo.previous?.decision ?? null, undo.id, undo.previous?.note ?? "", true)}>Undo last decision</button>}
        </div>}
      </section>
    </main>
    <footer className="footer"><span>Local files · no uploads · independent review state</span><span><kbd>J</kbd><kbd>K</kbd> navigate <span className="dot">·</span> <kbd>C</kbd> withhold <span className="dot">·</span> <kbd>F</kbd> publish</span></footer>
  </div>;
}

function Inspector({ group }: { group: ReviewGroup }) {
  const [zoom, setZoom] = useState(100);
  const [boxes, setBoxes] = useState(true);
  const [raw, setRaw] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState("");
  const [text, setText] = useState<{ text: string; truncated: boolean }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (group.kind !== "text") return;
    const controller = new AbortController();
    api<{ text: string; truncated: boolean }>(`/api/text/${group.id}`, { signal: controller.signal }).then(setText)
      .catch(e => { if (!controller.signal.aborted) setFailure(e.message); });
    return () => controller.abort();
  }, [group.id, attempt]);
  const regions = raw ? group.findings.flatMap(f => (f.boxes ?? []).map(box => ({ box, findingIds: [f.id], rules: [f.rule] }))) : group.boxes;
  return <div className="inspector">
    <div className="inspector-toolbar"><span>{group.kind === "frame" ? "SOURCE FRAME" : "SOURCE TEXT"} <span className="verified-label">hash-verified on load</span></span>
      {group.kind === "frame" && <div className="view-controls">
        <label><input type="checkbox" checked={boxes} onChange={e => setBoxes(e.target.checked)} /> Boxes</label>
        <label><input type="checkbox" checked={raw} onChange={e => { setRaw(e.target.checked); setHighlight(null); }} /> Raw detections</label>
        <button onClick={() => setZoom(Math.max(100, zoom - 25))} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(100)} title="Fit to width">{zoom === 100 ? "Fit" : `${zoom}%`}</button>
        <button onClick={() => setZoom(Math.min(300, zoom + 25))} aria-label="Zoom in">+</button>
      </div>}
    </div>
    {failure ? <div className="preview-error"><strong>Source could not be loaded</strong><p>The file may be unavailable or different from the scanned input. No substitute frame is shown.</p><code>{failure}</code>
      <button onClick={() => { setFailure(""); setLoaded(false); setAttempt(a => a + 1); }}>Retry</button></div> :
      group.kind === "frame" ? <div className="viewport">
        {!loaded && <div className="preview-loading"><span className="spinner" /> Verifying source and decoding exact frame…</div>}
        <div className="image-canvas" style={{ width: `${zoom}%`, display: loaded ? "block" : "none" }}>
          <img key={attempt} src={assetURL(`/api/frame/${group.id}`) + `&attempt=${attempt}`} alt={`Source frame ${group.frame}, with ${group.boxes.length} detected regions`}
            draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailure("frame-load-failed")} />
          {boxes && regions.map((region, index) => <button key={index} className={`region ${highlight === index ? "highlight" : ""}`}
            style={{ left: `${region.box[0] * 100}%`, top: `${region.box[1] * 100}%`, width: `${region.box[2] * 100}%`, height: `${region.box[3] * 100}%` }}
            aria-label={`Region ${index + 1}: ${region.rules.join(", ")}`} title={`${index + 1}. ${region.rules.join(", ")}`}
            onClick={() => setHighlight(highlight === index ? null : index)}><span>{index + 1}</span></button>)}
        </div>
      </div> : <div className="text-preview">{text ? <><pre>{text.text}</pre>{text.truncated && <p>Preview limited to 24,000 characters. Inspect the source for the remainder.</p>}</> :
        <div className="preview-loading"><span className="spinner" /> Verifying and reading source text…</div>}</div>}
    <div className="region-list">
      {regions.map((region, i) => <button key={i} onMouseEnter={() => setHighlight(i)} onMouseLeave={() => setHighlight(null)}
        onFocus={() => setHighlight(i)} onBlur={() => setHighlight(null)} onClick={() => setHighlight(i)} className={highlight === i ? "active" : ""}>
        <span className="region-number">{i + 1}</span>{region.rules.join(", ")}<span className="region-hits">{region.findingIds.length} {region.findingIds.length === 1 ? "hit" : "hits"}</span></button>)}
      {!regions.length && group.findings.map(f => <span className="rule-chip" key={f.id}>{f.rule}<small>{f.pass}</small></span>)}
    </div>
    <details className="provenance"><summary>Source & original detections <span>{group.findings.length} preserved findings</span></summary>
      <div className="source-path">{group.source}</div>
      <table><thead><tr><th>Rule</th><th>Pass</th><th>Severity</th><th>Finding ID</th></tr></thead><tbody>
        {group.findings.map(f => <tr key={f.id}><td>{f.rule}</td><td>{f.pass}</td><td>{f.severity}</td><td title={f.id}><code>{f.id.slice(0, 12)}</code></td></tr>)}
      </tbody></table>
    </details>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
