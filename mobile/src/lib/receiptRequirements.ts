import { fetchAddressCollectionRequired } from "./addressCollection";
import { fetchRequiredConsents } from "./consent";
import type { RequiredConsent } from "./documents";

export type ReceiptRequirementsSnapshot = {
  consent: RequiredConsent | null;
  needsAddress: boolean;
};

export async function fetchReceiptRequirementsSnapshot(): Promise<ReceiptRequirementsSnapshot> {
  const [requiredConsents, needsAddress] = await Promise.all([
    fetchRequiredConsents(),
    fetchAddressCollectionRequired(),
  ]);
  return {
    consent: requiredConsents.find((c) => c.consent_type === "electronic_receipts") ?? null,
    needsAddress,
  };
}

export function receiptRequirementsMode(snapshot: ReceiptRequirementsSnapshot): "none" | "consent_only" | "address_only" | "both" {
  const needsConsent = snapshot.consent != null;
  if (needsConsent && snapshot.needsAddress) return "both";
  if (needsConsent) return "consent_only";
  if (snapshot.needsAddress) return "address_only";
  return "none";
}
