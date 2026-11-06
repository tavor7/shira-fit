import { useLegalConsentGate } from "../hooks/useLegalConsentGate";
import { useReceiptRequirements } from "../hooks/useReceiptRequirements";
import { useSubscriptionTermsGate } from "../hooks/useSubscriptionTermsGate";
import { activeBlockingGate } from "../lib/blockingGates";
import { LegalConsentGateModal } from "./LegalConsentGateModal";
import { ReceiptRequirementsGateModal } from "./ReceiptRequirementsGateModal";
import { SubscriptionTermsGateModal } from "./subscriptions/SubscriptionTermsGateModal";

/**
 * The mandatory overlays of (app)/_layout.tsx, shown one at a time: Terms of Use / Privacy first, then receipt
 * details, then subscription terms. Rendering two at once trapped users on web: each overlay marks its siblings
 * `inert`, including the other overlay, so neither could be tapped.
 */
export function BlockingGates() {
  const legal = useLegalConsentGate();
  const receipt = useReceiptRequirements();
  const subscriptionTerms = useSubscriptionTermsGate();

  const active = activeBlockingGate([
    { id: "legal", loading: legal.loading, blocks: legal.blocksApp },
    { id: "receipt", loading: receipt.loading, blocks: receipt.blocksApp },
    { id: "subscriptionTerms", loading: subscriptionTerms.loading, blocks: !!subscriptionTerms.document },
  ]);

  if (active === "legal") return <LegalConsentGateModal gate={legal} />;
  if (active === "receipt") return <ReceiptRequirementsGateModal gate={receipt} />;
  if (active === "subscriptionTerms") return <SubscriptionTermsGateModal gate={subscriptionTerms} />;
  return null;
}
