import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, scanText, scanOCR } from "../src/index.ts";
import { hash } from "../src/rules.ts";

async function temporary(run: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "autoredact-test-"));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}
describe("critical secret scenarios", () => {
  test("recognizes env, headers, private keys and credentials without matching benign notes", () => {
    for (const text of [
      "CLOUDFLARE_API_TOKEN=synthetic-cf-value",
      "VERCEL_TOKEN=synthetic-vercel-value",
      "DATABASE_URL=postgres://demo:synthetic-password@localhost/db",
      "Authorization: Bearer synthetic-access-token",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "github_pat_0123456789abcdef0123456789",
      "https://example.test/?token=synthetic-value",
      "API Token\nsynthetic_dashboard_0123456789",
    ]) expect(scanText(text).length).toBeGreaterThan(0);
    for (const text of ["API token documentation", "Create a new token", ".env", "npm run test", "Project notes"])
      expect(scanText(text)).toEqual([]);
  });
  test("separate dashboard label/value needs spatial proximity", () => {
    const label = { text: "API Token", box: [0.1, 0.4, 0.2, 0.04] as [number, number, number, number], confidence: 1 };
    const value = { text: "0123456789abcdef0123456789abcdef", box: [0.1, 0.46, 0.4, 0.04] as [number, number, number, number], confidence: 1 };
    expect(scanOCR([label, value]).map(m => m.rule)).toContain("credential-field");
    expect(scanOCR([{ ...label, text: "АРI Token" }, value]).map(m => m.rule)).toContain("credential-field");
    expect(scanOCR([label, { ...value, box: [0.7, 0.8, 0.2, 0.04] }])).toEqual([]);
  });
  test("JSON structured credentials, numeric codes, locators, and no plaintext in report", async () => temporary(async dir => {
    const secret = "synthetic-secret-0123456789";
    const path = join(dir, "records.jsonl");
    await writeFile(path, JSON.stringify({ id: "r1", config: { API_KEY: secret }, recovery_code: 123456 }));
    const report = await scan([path], { mapping: { idPointer: "/id" } });
    expect(report.status).toBe("findings");
    expect(report.findings.some(f => f.pointer === "line:1#/config/API_KEY" && f.recordId === "r1")).toBe(true);
    expect(report.findings.some(f => f.pointer === "line:1#/recovery_code")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.inputs[0].sha256).toHaveLength(64);
  }));
  test("malformed, missing, unsupported and unavailable sources are incomplete", async () => temporary(async dir => {
    await writeFile(join(dir, "broken.json"), '{"password": "do-not-echo"');
    await writeFile(join(dir, "unknown.dat"), "unexamined");
    await writeFile(join(dir, "records.json"), JSON.stringify({ media: { availability: "missing" } }));
    const report = await scan([dir, join(dir, "absent.json")]);
    expect(report.status).toBe("incomplete");
    expect(report.issues.length).toBe(4);
    expect(JSON.stringify(report)).not.toContain("do-not-echo");
  }));
  test("vandelay archive references are verified, including extensionless objects", async () => temporary(async dir => {
    const archive = join(dir, "archive"); await mkdir(archive);
    const bytes = Buffer.from("not really a movie");
    const digest = hash(bytes);
    await writeFile(join(archive, digest), bytes);
    const path = join(dir, "records.jsonl");
    await writeFile(path, JSON.stringify({
      schema: "vandelay.record/v1", id: "capture/1", kind: "capture",
      media: [{ sha256: "0".repeat(64), bytes: bytes.length, location: { kind: "archive-relative", path: digest } }],
    }));
    const report = await scan([path], { mediaArchive: archive });
    expect(report.status).toBe("incomplete");
    expect(report.issues.some(i => i.code === "missing-or-invalid-archive-object")).toBe(true);
    expect(report.inputs).toHaveLength(1);
  }));
  test("quiet happy path and distinct CLI exit statuses", async () => temporary(async dir => {
    const path = join(dir, "notes.txt");
    await writeFile(path, "Release notes and project documentation.");
    const invoke = async () => {
      const p = Bun.spawn(["bun", new URL("../src/cli.ts", import.meta.url).pathname, "scan", path], { stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
    };
    expect(await invoke()).toEqual({ code: 0, stdout: "", stderr: "" });
    await writeFile(path, "API_KEY=synthetic-value");
    const result = await invoke();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("synthetic-value");
    await rm(path);
    expect((await invoke()).code).toBe(2);
  }));
});
