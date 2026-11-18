export type Box = [number, number, number, number];
export interface OCRLine { text: string; box: Box; confidence: number }
export interface OCRResult { lines: OCRLine[]; width: number; height: number }
export interface OCR {
  recognize(path: string, scrutiny?: boolean): Promise<OCRResult>;
  close(): Promise<void>;
}
export interface Anchor {
  asset: string;
  frame?: number;
  seconds?: number;
}
export interface RecordContext {
  id?: string;
  wallTime?: string;
  anchors?: Anchor[];
}
export interface TextItem {
  source: string;
  pointer: string;
  recordPointer: string;
  text: string;
  value?: string;
  context: RecordContext;
}
export interface InputFile {
  path: string;
  sha256: string;
  bytes: number;
  kind: "text" | "media";
}
export interface Issue { source: string; code: string }
export interface Inventory {
  files: InputFile[];
  texts: TextItem[];
  issues: Issue[];
}
export interface Finding {
  id: string;
  rule: string;
  severity: "high" | "review";
  source: string;
  pointer?: string;
  recordId?: string;
  wallTime?: string;
  frame?: number;
  seconds?: number;
  boxes?: Box[];
  pass: "text" | "ocr" | "scrutiny";
}
export interface Correlation {
  textFinding: string;
  media: string;
  frame: number;
  basis: "frame-reference" | "media-time";
  visualFindings: string[];
}
export interface Report {
  schema: "autoredact.scan/v1";
  scanner: string;
  rules: { version: string; sha256: string };
  policy: {
    video: "every-decoded-frame";
    ocr: "apple-vision-accurate";
    scrutiny: "overlapping-tiles";
    scope: "text-and-visual-secrets";
  };
  status: "no-findings" | "findings" | "incomplete";
  inputs: InputFile[];
  coverage: { textItems: number; frames: number; scrutinyFrames: number; emptyOCRFrames: number };
  findings: Finding[];
  correlations: Correlation[];
  issues: Issue[];
  /** Complete decoded-frame inventory; OCR text is represented only by fingerprints. */
  frames?: import("./masks.ts").FrameRecord[];
}
/** JSON Pointers are evaluated on each JSONL record / top-level JSON array element. */
export interface Mapping {
  idPointer?: string;
  wallTimePointer?: string;
  assetPointer?: string;
  framePointer?: string;
  secondsPointer?: string;
}
