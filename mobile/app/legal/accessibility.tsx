import { useI18n } from "../../src/context/I18nContext";
import { LegalDocumentScreen } from "../../src/components/LegalDocumentScreen";
import { legalContent } from "../../src/lib/legalContent";

export default function AccessibilityStatementScreen() {
  const { language } = useI18n();
  return <LegalDocumentScreen document={legalContent[language].accessibilityStatement} />;
}
