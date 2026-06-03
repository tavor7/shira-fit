export function parseHHMM(v: string): { hh: number; mm: number } | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = Math.max(0, Math.min(23, parseInt(m[1] ?? "", 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2] ?? "", 10)));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return { hh, mm };
}

export function formatHHMM(hh: number, mm: number): string {
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function dateToHHMM(d: Date): string {
  return formatHHMM(d.getHours(), d.getMinutes());
}

export function toPickerDate(v: string): Date {
  const now = new Date();
  const p = parseHHMM(v);
  if (!p) return now;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(p.hh, p.mm, 0, 0);
  return d;
}
