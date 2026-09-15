import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "../context/AuthContext";
import { fetchRequiredConsents } from "../lib/consent";
import type { RequiredConsent } from "../lib/documents";

export type LegalConsentGateState = {
  loading: boolean;
  required: RequiredConsent[];
  blocksApp: boolean;
  reload: () => Promise<RequiredConsent[]>;
};

const GATED_TYPES = new Set(["terms_of_service", "privacy_policy"]);

/**
 * Existing-user mandatory re-consent gate for Terms of Use / Privacy Policy.
 * Deliberately separate from useReceiptRequirements (electronic_receipts): different
 * concern, and get_required_consents() already scopes terms_of_service/privacy_policy
 * behind app_settings.legal_consent_gate_enabled, so this only ever returns something
 * once a manager has turned that rollout on.
 */
export function useLegalConsentGate(): LegalConsentGateState {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [required, setRequired] = useState<RequiredConsent[]>([]);

  const reload = useCallback(async () => {
    if (!session?.user?.id) {
      setRequired([]);
      setLoading(false);
      return [];
    }
    setLoading(true);
    try {
      const all = await fetchRequiredConsents();
      const gated = all.filter((c) => GATED_TYPES.has(c.consent_type));
      setRequired(gated);
      return gated;
    } catch {
      setRequired([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void reload();
    });
    return () => sub.remove();
  }, [reload]);

  return { loading, required, blocksApp: required.length > 0, reload };
}
