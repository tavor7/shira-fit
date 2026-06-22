import { escapeIlike } from "./staffAthleteSearch";
import { supabase } from "./supabase";

export type ExistingParticipantMatch =
  | {
      kind: "app";
      id: string;
      fullName: string;
      phone: string;
      username: string;
      matchedBy: "name" | "phone";
    }
  | {
      kind: "manual";
      id: string;
      fullName: string;
      phone: string;
      matchedBy: "name" | "phone";
    };

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function phonesMatch(a: string, b: string): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (da.length >= 3 && db.length >= 3 && da === db) return true;
  return a.trim() === b.trim();
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na.length >= 2 && na === nb;
}

async function findByPhone(phoneRaw: string): Promise<ExistingParticipantMatch | null> {
  const phone = phoneRaw.trim();
  if (phone.length < 3) return null;

  const [{ data: profiles }, { data: manuals }] = await Promise.all([
    supabase
      .from("profiles")
      .select("user_id, full_name, phone, username")
      .eq("role", "athlete")
      .eq("phone", phone)
      .limit(5),
    supabase.from("manual_participants").select("id, full_name, phone").eq("phone", phone).limit(5),
  ]);

  for (const row of (profiles ?? []) as { user_id: string; full_name: string; phone: string; username: string }[]) {
    if (phonesMatch(phone, row.phone ?? "")) {
      return {
        kind: "app",
        id: row.user_id,
        fullName: row.full_name?.trim() || "—",
        phone: row.phone?.trim() || "",
        username: row.username?.trim() || "",
        matchedBy: "phone",
      };
    }
  }

  for (const row of (manuals ?? []) as { id: string; full_name: string; phone: string }[]) {
    if (phonesMatch(phone, row.phone ?? "")) {
      return {
        kind: "manual",
        id: row.id,
        fullName: row.full_name?.trim() || "—",
        phone: row.phone?.trim() || "",
        matchedBy: "phone",
      };
    }
  }

  const digits = normalizePhoneDigits(phone);
  if (digits.length < 7) return null;

  const tail = escapeIlike(digits.slice(-7));
  const [{ data: profilesFuzzy }, { data: manualsFuzzy }] = await Promise.all([
    supabase
      .from("profiles")
      .select("user_id, full_name, phone, username")
      .eq("role", "athlete")
      .ilike("phone", `%${tail}%`)
      .limit(15),
    supabase.from("manual_participants").select("id, full_name, phone").ilike("phone", `%${tail}%`).limit(15),
  ]);

  for (const row of (profilesFuzzy ?? []) as { user_id: string; full_name: string; phone: string; username: string }[]) {
    if (phonesMatch(phone, row.phone ?? "")) {
      return {
        kind: "app",
        id: row.user_id,
        fullName: row.full_name?.trim() || "—",
        phone: row.phone?.trim() || "",
        username: row.username?.trim() || "",
        matchedBy: "phone",
      };
    }
  }

  for (const row of (manualsFuzzy ?? []) as { id: string; full_name: string; phone: string }[]) {
    if (phonesMatch(phone, row.phone ?? "")) {
      return {
        kind: "manual",
        id: row.id,
        fullName: row.full_name?.trim() || "—",
        phone: row.phone?.trim() || "",
        matchedBy: "phone",
      };
    }
  }

  return null;
}

async function findByName(nameRaw: string): Promise<ExistingParticipantMatch | null> {
  const name = nameRaw.trim();
  if (name.length < 2) return null;
  const safe = escapeIlike(name);

  const [{ data: profiles }, { data: manuals }] = await Promise.all([
    supabase
      .from("profiles")
      .select("user_id, full_name, phone, username")
      .eq("role", "athlete")
      .ilike("full_name", safe)
      .limit(10),
    supabase.from("manual_participants").select("id, full_name, phone").ilike("full_name", safe).limit(10),
  ]);

  for (const row of (profiles ?? []) as { user_id: string; full_name: string; phone: string; username: string }[]) {
    if (namesMatch(name, row.full_name ?? "")) {
      return {
        kind: "app",
        id: row.user_id,
        fullName: row.full_name?.trim() || "—",
        phone: row.phone?.trim() || "",
        username: row.username?.trim() || "",
        matchedBy: "name",
      };
    }
  }

  for (const row of (manuals ?? []) as { id: string; full_name: string; phone: string }[]) {
    if (namesMatch(name, row.full_name ?? "")) {
      return {
        kind: "manual",
        id: row.id,
        fullName: row.full_name?.trim() || "—",
        phone: row.phone?.trim() || "",
        matchedBy: "name",
      };
    }
  }

  return null;
}

/** Returns an existing app athlete or manual participant when name or phone already exists. */
export async function findExistingParticipantByNameOrPhone(
  nameRaw: string,
  phoneRaw: string
): Promise<ExistingParticipantMatch | null> {
  const byPhone = await findByPhone(phoneRaw);
  if (byPhone) return byPhone;
  return findByName(nameRaw);
}
