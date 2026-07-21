/**
 * Shared RTL/mixed Hebrew-Latin text layout helpers for pdf-lib based PDF generation.
 * Used by generate-document-pdf and generate-monthly-summary-pdf.
 */
import { rgb, type PDFDocument, type PDFFont } from "npm:pdf-lib@1.17.1";

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function fmtMoney(n: number): string {
  return `₪${Number(n).toFixed(2)}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export type TextRun = { text: string; font: PDFFont };
type Page = ReturnType<PDFDocument["addPage"]>;

export function fontForChar(ch: string, hebrew: PDFFont, latin: PDFFont): PDFFont {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x0590 && code <= 0x05ff) ||
    (code >= 0xfb1d && code <= 0xfb4f)
  ) {
    return hebrew;
  }
  return latin;
}

export function groupRuns(text: string, hebrew: PDFFont, latin: PDFFont): TextRun[] {
  if (!text) return [];
  const runs: TextRun[] = [];
  let buf = text[0]!;
  let font = fontForChar(text[0]!, hebrew, latin);
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    const nextFont = fontForChar(ch, hebrew, latin);
    if (nextFont === font) {
      buf += ch;
    } else {
      runs.push({ text: buf, font });
      buf = ch;
      font = nextFont;
    }
  }
  runs.push({ text: buf, font });
  return runs;
}

export function measureMixedWidth(text: string, size: number, hebrew: PDFFont, latin: PDFFont): number {
  return groupRuns(text, hebrew, latin).reduce(
    (w, run) => w + run.font.widthOfTextAtSize(run.text, size),
    0,
  );
}

export function isHebrewDominant(text: string): boolean {
  const hebrewChars = (text.match(/[֐-׿]/g) || []).length;
  const latinChars = (text.match(/[A-Za-z0-9@.]/g) || []).length;
  return hebrewChars > latinChars;
}

export function drawMixedTextLeft(
  page: Page,
  text: string,
  x: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  let cx = x;
  for (const run of groupRuns(text, hebrew, latin)) {
    page.drawText(run.text, {
      x: cx,
      y: y - size,
      size,
      font: run.font,
      color: rgb(0, 0, 0),
    });
    cx += run.font.widthOfTextAtSize(run.text, size);
  }
}

/** Right-aligned RTL: logical run order, each segment placed right-to-left from the margin. */
export function drawMixedTextRight(
  page: Page,
  text: string,
  rightX: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  const runs = groupRuns(text, hebrew, latin);
  let x = rightX;
  for (const run of runs) {
    const w = run.font.widthOfTextAtSize(run.text, size);
    x -= w;
    page.drawText(run.text, {
      x,
      y: y - size,
      size,
      font: run.font,
      color: rgb(0, 0, 0),
    });
  }
}

/** Width of an RTL token; trailing Latin punctuation sits after the Hebrew word visually. */
export function measureRtlTokenWidth(
  token: string,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
): number {
  const match = token.match(/^(.+?)([.!?,:;]+)$/);
  if (match && isHebrewDominant(match[1]!)) {
    return measureMixedWidth(match[1]!, size, hebrew, latin) + latin.widthOfTextAtSize(match[2]!, size);
  }
  return measureMixedWidth(token, size, hebrew, latin);
}

/** Draw one RTL token with its right edge at xRight. */
export function drawRtlTokenAt(
  page: Page,
  token: string,
  xRight: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
): number {
  const match = token.match(/^(.+?)([.!?,:;]+)$/);
  if (match && isHebrewDominant(match[1]!)) {
    const word = match[1]!;
    const punct = match[2]!;
    const wordW = measureMixedWidth(word, size, hebrew, latin);
    const punctW = latin.widthOfTextAtSize(punct, size);
    xRight -= wordW;
    drawMixedTextLeft(page, word, xRight, y, size, hebrew, latin);
    xRight -= punctW;
    drawMixedTextLeft(page, punct, xRight, y, size, hebrew, latin);
    return wordW + punctW;
  }
  const w = measureMixedWidth(token, size, hebrew, latin);
  xRight -= w;
  drawMixedTextLeft(page, token, xRight, y, size, hebrew, latin);
  return w;
}

/** Centered line with Hebrew words laid out right-to-left. */
export function drawRtlLineCentered(
  page: Page,
  text: string,
  centerX: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  const parts = text.split(/(\s+)/).filter((p) => p.length > 0);
  const widths = parts.map((p) => measureRtlTokenWidth(p, size, hebrew, latin));
  const totalW = widths.reduce((a, b) => a + b, 0);
  let xRight = centerX + totalW / 2;
  for (let i = 0; i < parts.length; i++) {
    xRight -= drawRtlTokenAt(page, parts[i]!, xRight, y, size, hebrew, latin);
  }
}

/** Horizontally centered text (RTL word order for Hebrew-dominant strings). */
export function drawMixedTextCentered(
  page: Page,
  text: string,
  centerX: number,
  y: number,
  size: number,
  hebrew: PDFFont,
  latin: PDFFont,
) {
  if (isHebrewDominant(text)) {
    drawRtlLineCentered(page, text, centerX, y, size, hebrew, latin);
    return;
  }
  const w = measureMixedWidth(text, size, hebrew, latin);
  drawMixedTextLeft(page, text, centerX - w / 2, y, size, hebrew, latin);
}
