export function normalizeParticipantName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function participantPhonesMatch(a: string, b: string): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (da.length >= 7 && db.length >= 7 && da === db) return true;
  return a.trim() === b.trim();
}

export function participantNamesMatch(a: string, b: string): boolean {
  const na = normalizeParticipantName(a);
  const nb = normalizeParticipantName(b);
  return na.length >= 2 && na === nb;
}

export type ManualParticipantIdentity = {
  id: string;
  full_name: string;
  phone: string;
};

export type ManualDuplicateIndexes = {
  nameCounts: Record<string, number>;
  phoneCounts: Record<string, number>;
};

export function buildManualDuplicateIndexes(rows: ManualParticipantIdentity[]): ManualDuplicateIndexes {
  const nameCounts: Record<string, number> = {};
  const phoneCounts: Record<string, number> = {};

  for (const row of rows) {
    const nameKey = normalizeParticipantName(row.full_name ?? "");
    if (nameKey) nameCounts[nameKey] = (nameCounts[nameKey] ?? 0) + 1;

    const phoneKey = normalizePhoneDigits(row.phone ?? "");
    if (phoneKey.length >= 7) phoneCounts[phoneKey] = (phoneCounts[phoneKey] ?? 0) + 1;
  }

  return { nameCounts, phoneCounts };
}

export function manualHasDuplicateName(row: ManualParticipantIdentity, indexes: ManualDuplicateIndexes): boolean {
  const key = normalizeParticipantName(row.full_name ?? "");
  return key.length > 0 && (indexes.nameCounts[key] ?? 0) > 1;
}

export function manualHasDuplicatePhone(row: ManualParticipantIdentity, indexes: ManualDuplicateIndexes): boolean {
  const key = normalizePhoneDigits(row.phone ?? "");
  return key.length >= 7 && (indexes.phoneCounts[key] ?? 0) > 1;
}
