import { createHash } from "node:crypto";
import specification from "../rules/secrets.v1.json";
import type { Box, OCRLine } from "./types.ts";

export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const rulesIdentity = { version: specification.version, sha256: hash(JSON.stringify(specification)) };
const rules = specification.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, rule.flags) }));
export interface Match {
  rule: string;
  severity: "high" | "review";
  boxes?: Box[];
}

// Report rule identities and locations, never matched credential values.
export function scanText(text: string): Match[] {
  return rules.filter(rule => rule.regex.test(text)).map(rule => ({
    rule: rule.id, severity: rule.severity as Match["severity"],
  }));
}

export function scanOCR(lines: OCRLine[]): Match[] {
  // Vision sometimes recognizes Latin UI labels as Cyrillic lookalikes (e.g.
  // "АРI Token"). Normalize only the transient OCR matching view, not source data.
  const lookalikes: Record<string, string> = {
    А: "A", В: "B", С: "C", Е: "E", Н: "H", І: "I", К: "K", М: "M",
    О: "O", Р: "P", Т: "T", Х: "X", а: "a", е: "e", о: "o", р: "p", с: "c", х: "x",
  };
  lines = lines.map(line => ({ ...line, text: line.text.normalize("NFKC")
    .replace(/[АВСЕНІКМОРТХаеорсх]/g, char => lookalikes[char]) }));
  const results: Match[] = [];
  for (const line of lines) {
    results.push(...scanText(line.text).map(match => ({ ...match, boxes: [line.box] })));
  }
  // Dashboard labels and their revealed values are often separate OCR observations.
  // Require spatial proximity; mere presence of "API token" elsewhere is insufficient.
  const label = /^(?:(?:global|account|access|secret)\s+)?(?:api\s*key|api\s*token|access\s*token|secret(?:\s*key)?|password|token)\s*[:=]?$/i;
  for (const line of lines) {
    if (!label.test(line.text.trim())) continue;
    for (const candidate of lines) {
      if (candidate === line || !/^[A-Za-z0-9_+/=.-]{16,}$/.test(candidate.text.trim())) continue;
      const [x, y, w, h] = line.box;
      const [cx, cy, cw, ch] = candidate.box;
      const right = cx >= x + w - 0.01 && cx - x - w < 0.25 && Math.abs(cy - y) < Math.max(h, ch);
      const below = cy >= y && cy - y - h < 0.08 && cx < x + w + 0.1 && cx + cw > x;
      if (right || below) results.push({
        rule: "credential-field", severity: "review", boxes: [line.box, candidate.box],
      });
    }
  }
  return results;
}
