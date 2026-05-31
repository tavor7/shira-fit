import { supabase } from "./supabase";

export type FamilyMemberKind = "app" | "manual";

export type AthleteFamilyMember = {
  kind: FamilyMemberKind;
  id: string;
  name: string | null;
  phone?: string | null;
  payee_is_manual?: boolean;
  expected_ils?: number;
  collected_sessions_ils?: number;
  collected_account_ils?: number;
  collected_total_ils?: number;
  outstanding_ils?: number;
};

export type AthleteFamily = {
  id: string;
  name: string;
  members: AthleteFamilyMember[];
  expected_ils?: number;
  collected_sessions_ils?: number;
  collected_account_ils?: number;
  collected_total_ils?: number;
  outstanding_ils?: number;
};

export type AthleteFamilyListItem = {
  id: string;
  name: string;
  members: Pick<AthleteFamilyMember, "kind" | "id" | "name">[];
};

export function memberPayeeKey(kind: FamilyMemberKind, id: string): string {
  return `${kind}:${id}`;
}

export function resolveFamilyMemberByPayee(
  family: AthleteFamily | null | undefined,
  payeeId: string,
  payeeIsManual: boolean
): AthleteFamilyMember | null {
  if (!family) return null;
  return (
    family.members.find(
      (m) => m.id === payeeId && (m.kind === "manual") === payeeIsManual
    ) ?? null
  );
}

export function parseFamilyMembers(raw: unknown): AthleteFamilyMember[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const row = m as Record<string, unknown>;
      const kind = row.kind === "manual" ? "manual" : row.kind === "app" ? "app" : null;
      const id = typeof row.id === "string" ? row.id : null;
      if (!kind || !id) return null;
      return {
        kind,
        id,
        name: typeof row.name === "string" ? row.name : null,
        phone: typeof row.phone === "string" ? row.phone : row.phone === null ? null : undefined,
        payee_is_manual: row.payee_is_manual === true || kind === "manual",
      } satisfies AthleteFamilyMember;
    })
    .filter(Boolean) as AthleteFamilyMember[];
}

export function parseFamilyRpcResponse(data: unknown): AthleteFamily | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as {
    ok?: boolean;
    family?: { id: string; name: string; members?: unknown[] } | null;
  };
  if (!payload.ok || !payload.family) return null;
  return {
    id: payload.family.id,
    name: payload.family.name,
    members: parseFamilyMembers(payload.family.members),
  };
}

export async function fetchAthleteFamilyForPayee(
  payeeId: string,
  payeeIsManual: boolean
): Promise<AthleteFamily | null> {
  const { data, error } = await supabase.rpc("get_athlete_family", {
    p_payee_id: payeeId,
    p_payee_is_manual: payeeIsManual,
  });
  if (error) return null;
  return parseFamilyRpcResponse(data);
}
