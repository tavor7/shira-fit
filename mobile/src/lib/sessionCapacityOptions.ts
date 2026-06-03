export const SESSION_DURATION_MIN = 30;
export const SESSION_DURATION_MAX = 120;
export const SESSION_MAX_PARTICIPANTS_MIN = 0;
export const SESSION_MAX_PARTICIPANTS_MAX = 15;

export const SESSION_DURATION_OPTIONS = Array.from(
  { length: SESSION_DURATION_MAX - SESSION_DURATION_MIN + 1 },
  (_, i) => SESSION_DURATION_MIN + i
);

export const SESSION_MAX_SIZE_OPTIONS = Array.from(
  { length: SESSION_MAX_PARTICIPANTS_MAX - SESSION_MAX_PARTICIPANTS_MIN + 1 },
  (_, i) => SESSION_MAX_PARTICIPANTS_MIN + i
);

export function clampSessionDuration(n: number): number {
  if (!Number.isFinite(n)) return 55;
  return Math.min(SESSION_DURATION_MAX, Math.max(SESSION_DURATION_MIN, Math.round(n)));
}

export function clampSessionMaxParticipants(n: number): number {
  if (!Number.isFinite(n)) return 12;
  return Math.min(SESSION_MAX_PARTICIPANTS_MAX, Math.max(SESSION_MAX_PARTICIPANTS_MIN, Math.round(n)));
}

export function normalizeSessionDurationString(v: string): string {
  return String(clampSessionDuration(parseInt(String(v ?? "").trim(), 10)));
}

export function normalizeSessionMaxString(v: string): string {
  return String(clampSessionMaxParticipants(parseInt(String(v ?? "").trim(), 10)));
}

export function isValidSessionDuration(n: number): boolean {
  return Number.isFinite(n) && n >= SESSION_DURATION_MIN && n <= SESSION_DURATION_MAX;
}

export function isValidSessionMaxParticipants(n: number): boolean {
  return Number.isFinite(n) && n >= SESSION_MAX_PARTICIPANTS_MIN && n <= SESSION_MAX_PARTICIPANTS_MAX;
}
