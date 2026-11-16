import { mkdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { hash } from "./rules.ts";
import type { OCR, OCRResult } from "./types.ts";

export async function visionOCR(): Promise<OCR> {
  if (process.platform !== "darwin") throw new Error("vision-requires-macos");
  const source = fileURLToPath(new URL("./ocr_worker.swift", import.meta.url));
  const cache = join(homedir(), "Library", "Caches", "autoredact");
  await mkdir(cache, { recursive: true });
  const binary = join(cache, `ocr-${hash(await readFile(source)).slice(0, 16)}-${process.arch}`);
  if (!existsSync(binary)) {
    const tmp = binary + `-${process.pid}`;
    const build = Bun.spawn(["swiftc", "-O", source, "-o", tmp], { stdout: "ignore", stderr: "pipe" });
    // Drain diagnostics but don't echo potentially private compiler paths.
    await new Response(build.stderr).text();
    if (await build.exited !== 0) throw new Error("ocr-build-failed");
    await rename(tmp, binary);
  }
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let pending: { resolve: (result: OCRResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const fail = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ocr-worker-failed"));
      pending = undefined;
    }
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  lines.on("line", line => {
    if (!pending) return;
    const p = pending; pending = undefined; clearTimeout(p.timer);
    try {
      const value = JSON.parse(line);
      if (value.error || !Array.isArray(value.lines) || !(value.width > 0) || !(value.height > 0)) throw new Error();
      for (const l of value.lines) {
        if (typeof l.text !== "string" || !Array.isArray(l.box) || l.box.length !== 4 ||
            !l.box.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
          throw new Error();
      }
      p.resolve(value);
    } catch { p.reject(new Error("ocr-invalid-or-failed-response")); }
  });
  return {
    recognize(path, scrutiny = false) {
      if (pending) return Promise.reject(new Error("ocr-concurrent-request"));
      if (child.exitCode !== null || child.killed) return Promise.reject(new Error("ocr-worker-unavailable"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(); child.kill(); }, 60_000);
        pending = { resolve, reject, timer };
        child.stdin.write(JSON.stringify({ path, scrutiny }) + "\n");
      });
    },
    async close() {
      fail(); lines.close(); child.stdin.end(); child.kill();
    },
  };
}
