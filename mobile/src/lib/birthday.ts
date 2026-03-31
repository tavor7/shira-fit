export function isBirthdayToday(dateOfBirth: string | null | undefined, today = new Date()): boolean {
  // `dateOfBirth` is stored as YYYY-MM-DD (date). We compare month/day only.
  if (!dateOfBirth || dateOfBirth.length < 10) return false;
  const md = dateOfBirth.slice(5, 10);
  const tmd = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return md === tmd;
}

