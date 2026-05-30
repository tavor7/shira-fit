/** When recurring generation created a duplicate empty session, prefer the row that has sign-ups. */
export function dedupeSessionsBySignupCount<
  T extends { id: string; session_date: string; start_time: string; coach_id: string },
>(sessions: T[], signupBySession: Record<string, number>): T[] {
  const bestBySlot = new Map<string, T>();
  for (const s of sessions) {
    const key = `${s.session_date}\t${s.start_time}\t${s.coach_id}`;
    const prev = bestBySlot.get(key);
    if (!prev) {
      bestBySlot.set(key, s);
      continue;
    }
    const prevCount = signupBySession[prev.id] ?? 0;
    const count = signupBySession[s.id] ?? 0;
    if (count > prevCount) {
      bestBySlot.set(key, s);
    }
  }
  return sessions.filter((s) => {
    const key = `${s.session_date}\t${s.start_time}\t${s.coach_id}`;
    return bestBySlot.get(key)?.id === s.id;
  });
}
