import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Frame { path: string; index: number; seconds?: number }

export async function probe(path: string): Promise<{ image: boolean; times: number[] }> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "format=format_name:frame=best_effort_timestamp_time", "-show_frames",
    "-of", "json", path], { stdout: "pipe", stderr: "ignore" });
  const raw = await new Response(p.stdout).text();
  if (await p.exited !== 0) throw new Error("media-probe-failed");
  const result = JSON.parse(raw);
  if (!Array.isArray(result.frames) || !result.frames.length) throw new Error("no-video-frames");
  const image = /image2|_pipe/.test(result.format?.format_name ?? "");
  const times = result.frames.map((f: any) => Number(f.best_effort_timestamp_time));
  if (!image && times.some((t: number) => !Number.isFinite(t))) throw new Error("missing-frame-timestamps");
  return { image, times };
}

/** Decode every frame, preserving order. Only one lossless PNG is retained on disk.
 * No sampling, lossy JPEG intermediates, or approximate change detection.
 */
export async function* frames(path: string, times: number[]): AsyncGenerator<Frame> {
  const dir = await mkdtemp(join(tmpdir(), "autoredact-"));
  const framePath = join(dir, "frame.png");
  const child = spawn("ffmpeg", ["-v", "error", "-xerror", "-i", path, "-map", "0:v:0",
    "-fps_mode", "passthrough", "-f", "image2pipe", "-c:v", "png", "-"], { stdio: ["ignore", "pipe", "ignore"] });
  const completion = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });
  let buffer = Buffer.alloc(0), offset = 8, index = 0;
  try {
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 200_000_000) throw new Error("frame-size-limit");
      while (buffer.length >= offset + 12) {
        if (!buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("invalid-png-stream");
        const length = buffer.readUInt32BE(offset);
        if (length > 200_000_000) throw new Error("frame-size-limit");
        if (buffer.length < offset + length + 12) break;
        const end = buffer.toString("ascii", offset + 4, offset + 8) === "IEND";
        offset += length + 12;
        if (!end) continue;
        if (index >= times.length) throw new Error("frame-count-mismatch");
        await writeFile(framePath, buffer.subarray(0, offset), { mode: 0o600 });
        yield { path: framePath, index, seconds: times[index] };
        index++;
        buffer = buffer.subarray(offset);
        offset = 8;
      }
    }
    if (await completion !== 0 || buffer.length || index !== times.length) throw new Error("decode-incomplete");
  } finally {
    child.kill();
    await completion;
    await rm(dir, { recursive: true, force: true });
  }
}
