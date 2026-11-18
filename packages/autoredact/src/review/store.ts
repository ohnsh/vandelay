import { mkdir, readFile, rename, rm, writeFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hash } from "../rules.ts";
import { emptyReview, groupFindings, parseReport, validateReview, type Decision, type ReviewState } from "./model.ts";
import { planMasks, type Mask } from "../masks.ts";
import { fileHash } from "../inputs.ts";

export const encodeReview = (state: ReviewState) => JSON.stringify(state, null, 2) + "\n";
export class ReviewStore {
  readonly report;
  readonly reportSha256;
  readonly groups;
  state: ReviewState;
  private diskHash?: string;
  private savedBytes?: string;
  private queue = Promise.resolve();
  private constructor(readonly reportPath: string, readonly statePath: string, bytes: Buffer) {
    this.report = parseReport(bytes);
    this.reportSha256 = hash(bytes);
    this.groups = groupFindings(this.report);
    this.state = emptyReview(this.reportSha256);
  }
  static async open(reportPath: string, statePath: string): Promise<ReviewStore> {
    const report = await realpath(reportPath), state = resolve(statePath);
    if (report === state) throw new Error("review-would-overwrite-report");
    const store = new ReviewStore(report, state, await readFile(report));
    try {
      if (await realpath(state) === report) throw new Error("review-would-overwrite-report");
      const bytes = await readFile(state);
      store.state = validateReview(JSON.parse(bytes.toString()), store.reportSha256, store.groups, store.report);
      store.diskHash = hash(bytes);
      store.savedBytes = bytes.toString();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }
  exportBytes(): string { return this.savedBytes ?? encodeReview(this.state); }
  async refresh(): Promise<void> {
    const execute = async () => {
      if (hash(await readFile(this.reportPath)) !== this.reportSha256) throw new Error("report-changed-on-disk");
      try {
        const bytes = await readFile(this.statePath);
        this.state = validateReview(JSON.parse(bytes.toString()), this.reportSha256, this.groups, this.report);
        this.diskHash = hash(bytes);
        this.savedBytes = bytes.toString();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.diskHash) throw error;
      }
    };
    const result = this.queue.then(execute);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  async update(revision: number, id: string, decision: Decision | null, note: string): Promise<ReviewState> {
    return this.mutate(revision, next => {
      if (!this.groups.some(g => g.id === id) || ![null, "publish", "withhold"].includes(decision) ||
          typeof note !== "string" || note.length > 4000) throw new Error("invalid-decision");
      if (decision === null) delete next.decisions[id];
      else next.decisions[id] = { decision, note: note.trim(), updatedAt: new Date().toISOString() };
    });
  }
  async masks(revision: number, id: string, masks: Mask[]): Promise<ReviewState> {
    return this.mutate(revision, async next => {
      const group = this.groups.find(g => g.id === id);
      const input = this.report.inputs.find(i => i.path === group?.source);
      if (!input || await fileHash(input.path) !== input.sha256) throw new Error("source-missing-or-changed");
      const plan = planMasks(this.report, next.maskPlan, id, masks);
      for (const key of new Set([...Object.keys(next.maskPlan?.frames ?? {}), ...Object.keys(plan.frames)])) {
        if (JSON.stringify(next.maskPlan?.frames[key]) !== JSON.stringify(plan.frames[key])) delete next.decisions[key];
      }
      next.maskPlan = plan;
      next.schema = "autoredact.review/v2";
    });
  }
  private async mutate(revision: number, change: (next: ReviewState) => void | Promise<void>): Promise<ReviewState> {
    const execute = async () => {
      if (revision !== this.state.revision) throw new Error("revision-conflict");
      // An exclusive, transient lock also protects against a second review server.
      const lock = this.statePath + ".lock";
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      try { await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
      catch { throw new Error("review-locked"); }
      const temp = this.statePath + `.${crypto.randomUUID()}.tmp`;
      try {
        let disk: string | undefined;
        try { disk = hash(await readFile(this.statePath)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (disk !== this.diskHash) throw new Error("review-changed-on-disk");
        if (hash(await readFile(this.reportPath)) !== this.reportSha256) throw new Error("report-changed-on-disk");
        const next = structuredClone(this.state);
        await change(next);
        validateReview(next, this.reportSha256, this.groups, this.report);
        next.revision++;
        const bytes = encodeReview(next);
        await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
        await rename(temp, this.statePath);
        this.diskHash = hash(bytes);
        this.savedBytes = bytes;
        this.state = next;
        return next;
      } finally { await rm(temp, { force: true }); await rm(lock, { force: true }); }
    };
    const result = this.queue.then(execute);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}
