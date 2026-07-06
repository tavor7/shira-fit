import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "../context/AuthContext";
import type { RequiredConsent } from "../lib/documents";
import {
  fetchReceiptRequirementsSnapshot,
  receiptRequirementsMode,
  type ReceiptRequirementsMode,
} from "../lib/receiptRequirements";

export type { ReceiptRequirementsMode };

export type ReceiptRequirementsState = {
  loading: boolean;
  mode: ReceiptRequirementsMode;
  consent: RequiredConsent | null;
  needsAddress: boolean;
  blocksApp: boolean;
  reload: () => Promise<ReceiptRequirementsMode>;
};

export function useReceiptRequirements(): ReceiptRequirementsState {
  const { session, profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState<RequiredConsent | null>(null);
  const [needsAddress, setNeedsAddress] = useState(false);

  const reload = useCallback(async () => {
    if (!session?.user?.id) {
      setConsent(null);
      setNeedsAddress(false);
      setLoading(false);
      return "none";
    }
    setLoading(true);
    try {
      const snapshot = await fetchReceiptRequirementsSnapshot();
      setConsent(snapshot.consent);
      setNeedsAddress(snapshot.needsAddress);
      return receiptRequirementsMode(snapshot);
    } catch {
      setConsent(null);
      setNeedsAddress(false);
      return "none";
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    void reload();
  }, [
    reload,
    profile?.electronic_receipts_consent_version,
    profile?.address,
    profile?.zip_code,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void reload();
    });
    return () => sub.remove();
  }, [reload]);

  const mode = receiptRequirementsMode({ consent, needsAddress });

  return {
    loading,
    mode,
    consent,
    needsAddress,
    blocksApp: mode !== "none",
    reload,
  };
}
