/**
 * Static, versioned legal document content (Terms of Use, Privacy Policy, Accessibility
 * Statement) in Hebrew and English. Kept separate from src/i18n/translations.ts because
 * these are long-form documents, not short UI strings.
 *
 * Versions here MUST stay in sync with the `legal_documents.version` rows seeded in
 * supabase/migrations/20260915120000_legal_documents_seed.sql — bumping a version means
 * updating both the SQL seed (new row, is_current = true) and the section content below
 * in the same change, so what a user is asked to (re-)accept matches what they're shown.
 *
 * A few tokens are substituted at render time from `get_public_business_info()` (see
 * legalBusinessInfo.ts) rather than hardcoded, because they can change independently of
 * the document text: {{BUSINESS_NAME}}, {{BUSINESS_ADDRESS}}, {{BUSINESS_PHONE}},
 * {{BUSINESS_EMAIL}}, {{BUSINESS_ID}}, {{BUSINESS_ID_CLAUSE}}, {{DEALER_STATUS}}.
 * {{BUSINESS_ID_CLAUSE}} is the preferred one to embed inline (e.g. right after
 * {{DEALER_STATUS}}) — it renders as "" when business_id is unset, so the sentence reads
 * cleanly either way; {{BUSINESS_ID}} is the bare value, for spots that need it standalone.
 */

export type LegalSection = { heading: string; body: string };
export type LegalDocument = {
  title: string;
  lastUpdated: string;
  intro?: string;
  sections: LegalSection[];
};

export const LEGAL_VERSIONS = {
  termsOfService: 1,
  privacyPolicy: 1,
  accessibilityStatement: 1,
  marketingCommunications: 1,
} as const;

const LAST_UPDATED = "2026-09-15";

export const legalContent: Record<
  "en" | "he",
  { termsOfService: LegalDocument; privacyPolicy: LegalDocument; accessibilityStatement: LegalDocument }
> = {
  en: {
    termsOfService: {
      title: "Terms of Use",
      lastUpdated: LAST_UPDATED,
      intro:
        "These Terms of Use govern your use of the Shira Fit application and studio services, operated by {{BUSINESS_NAME}} ({{DEALER_STATUS}}){{BUSINESS_ID_CLAUSE}}, {{BUSINESS_ADDRESS}}. By creating an account or using the app, you agree to these Terms.",
      sections: [
        {
          heading: "1. Eligibility and account registration",
          body:
            "You must provide accurate, current, and complete information when creating an account, including your full name, phone number, date of birth, address, and zip code, and keep it up to date. Athlete accounts require manager approval before full access is granted; until approved, some features are unavailable.",
        },
        {
          heading: "2. Health declaration",
          body:
            "Before registering for sessions, athletes must complete a health declaration required under applicable gym/fitness regulations. This declaration is completed on an independent third-party form (not part of the Shira Fit app) — see the Privacy Policy, section \"Health declaration (Tepez)\", for details on that hand-off and what happens to the resulting document.",
        },
        {
          heading: "3. Session registration, capacity, and waitlist",
          body:
            "Sessions have a maximum capacity enforced by the system. When a session is full, you may join a waitlist; spots are offered in first-in-first-out (FIFO) order as they open, and you will be notified if a spot becomes available for you.",
        },
        {
          heading: "4. Cancellations and late cancellations",
          body:
            "You may cancel a registration through the app. Cancelling less than 24 hours before a session's start time is treated as a late cancellation and may result in a charge, as reflected in your account and receipts. This 24-hour rule is enforced by the system for all athletes.",
        },
        {
          heading: "5. No-shows",
          body:
            "Failing to attend a session you registered for, without cancelling in advance, may result in a charge at the studio's discretion, recorded when your coach or the manager marks attendance. Unlike the late-cancellation rule above, a no-show charge is not automatic — it depends on the circumstances and is applied by staff on a case-by-case basis.",
        },
        {
          heading: "6. Pricing and payments",
          body:
            "Session and package pricing is set by the studio and may vary by capacity tier or arrangement. Payments may be made by the methods the studio accepts (including cash, bank transfer, and other methods shown in the app). You are responsible for keeping your payment obligations current.",
        },
        {
          heading: "7. Digital receipts",
          body:
            "Where digital receipts are enabled, the studio issues you an electronic receipt or invoice for payments, sent to your email and/or made available in the app, consistent with Israeli record-keeping requirements. {{BUSINESS_NAME}} currently operates as {{DEALER_STATUS}}.",
        },
        {
          heading: "8. Communications and notifications",
          body:
            "The studio sends you operational messages needed to run the service — session reminders, registration and waitlist updates, schedule changes, and billing/receipt notices — through the app, push notifications, and, if you opt in, WhatsApp. Separately, and only if you explicitly opt in, the studio may send marketing or promotional messages; this consent is optional, never required to use the service, and can be withdrawn at any time. See the Privacy Policy for details.",
        },
        {
          heading: "9. Acceptable use",
          body:
            "You agree to use the app only for its intended purpose, not to misuse, disrupt, or attempt to gain unauthorized access to the service or other users' accounts, and not to submit false information (including false attendance, payment, or registration actions).",
        },
        {
          heading: "10. Intellectual property",
          body:
            "The app, its design, and its content are the property of {{BUSINESS_NAME}} or its licensors. You may not copy, modify, or redistribute them without permission.",
        },
        {
          heading: "11. Service availability and changes",
          body:
            "The studio may modify, suspend, or discontinue features of the app, and may change session schedules, pricing, or policies, with notice provided through the app where practical. We aim for reliable service but do not guarantee uninterrupted availability.",
        },
        {
          heading: "12. Limitation of liability",
          body:
            "Physical training carries inherent risk. You participate in studio sessions at your own risk and are responsible for disclosing relevant health information via the required health declaration. To the maximum extent permitted by law, {{BUSINESS_NAME}} is not liable for indirect, incidental, or consequential damages arising from use of the app or participation in sessions, except where liability cannot be excluded under Israeli law. This clause does not limit rights that cannot be limited by law.",
        },
        {
          heading: "13. Privacy",
          body:
            "Our Privacy Policy, incorporated into these Terms by reference, describes what personal information we collect, why, and your rights regarding it.",
        },
        {
          heading: "14. Changes to these Terms",
          body:
            "We may update these Terms from time to time. Material changes will be published as a new version, and you will be asked to review and accept the updated Terms before continuing to use the app, exactly as with any legal-document update in the app.",
        },
        {
          heading: "15. Governing law",
          body: "These Terms are governed by the laws of the State of Israel.",
        },
        {
          heading: "16. Contact",
          body: "Questions about these Terms can be sent to {{BUSINESS_EMAIL}} or {{BUSINESS_PHONE}}.",
        },
      ],
    },
    privacyPolicy: {
      title: "Privacy Policy",
      lastUpdated: LAST_UPDATED,
      intro:
        "This Privacy Policy explains what personal information Shira Fit collects through the app, why, and your rights. The service is operated by {{BUSINESS_NAME}} ({{DEALER_STATUS}}){{BUSINESS_ID_CLAUSE}}, {{BUSINESS_ADDRESS}} — the controller of the personal information described here. Reading and acknowledging this policy (tracked with your account for evidentiary purposes) confirms you were shown this notice; it is not, by itself, consent to every processing activity described below — where the law requires your separate consent (such as marketing communications), we ask for it separately and you may decline it without affecting your ability to use the app.",
      sections: [
        {
          heading: "Information we collect",
          body:
            "Account & identity: email, password, full name, username, phone number, date of birth, age, gender.\nAddress: home address and zip code, collected for digital-receipt compliance.\nHealth declaration status: only whether you confirmed completing the required health declaration, and when — the medical questionnaire itself is completed on an independent third-party form, not inside this app (see \"Health declaration (Tepez)\" below).\nDevice & notifications: a push-notification token if you enable push notifications, and a WhatsApp phone number if you opt into WhatsApp notifications.\nBilling & receipts: payment records, receipt/invoice documents, and related billing history.\nConsent records: which version of which legal document you accepted or declined, and when.\nUsage: session registrations, attendance, cancellations, and waitlist activity needed to operate the service.",
        },
        {
          heading: "Why we collect it",
          body:
            "To create and manage your account and role-based access; to run session registration, waitlists, attendance, and cancellations; to bill you and issue legally compliant digital receipts; to send you operational communications about your sessions and account; to send you marketing communications only if you separately opt in; and to meet our legal and tax record-keeping obligations.",
        },
        {
          heading: "What's required vs. optional",
          body:
            "Email, password, full name, phone, date of birth, address, and zip code are required to create an account and use the service — without them we cannot register you for sessions or issue compliant receipts. Push notifications, WhatsApp notifications, and marketing communications are all optional; declining them does not affect your ability to use the app, though you may miss convenience notifications you've opted out of.",
        },
        {
          heading: "Who can access your information internally",
          body:
            "Managers have full access to user records for studio operations, billing, and receipts. Coaches can view athlete profile information relevant to running sessions, including contact details, date of birth, and address, so they can manage rosters, attendance, and studio communication. We are reviewing whether this level of access can be narrowed in a future update; for now, this reflects the studio's current operational needs.",
        },
        {
          heading: "Third-party services we use",
          body:
            "Supabase (database, authentication, storage, and backend functions). Resend (delivering receipt/document emails). Meta's WhatsApp Business API (delivering WhatsApp notifications you've opted into). Expo (delivering push notifications). Our web hosting provider (serving the web/PWA version of the app). We do not use advertising or analytics-tracking services, and we do not sell your personal information.",
        },
        {
          heading: "Health declaration (Tepez) — an independent third-party service",
          body:
            "Before your first session, you're asked to complete a health declaration required under applicable gym/fitness regulations. This is done on an external form operated by Tepez, an independent service not affiliated with Shira Fit or the Israeli Ministry of Health. Tepez has its own Terms of Use and Privacy Policy, which you should review before submitting that form — Shira Fit does not control, and is not responsible for, how Tepez processes the information you give it there, including Tepez's own separate, optional request to use your information for advertising or commercial purposes (that consent, if given, is between you and Tepez, not Shira Fit). Once you complete the declaration, Tepez sends the resulting document to the studio's own email address, and from that point it is held and processed by Shira Fit. We currently retain these declarations for as long as they remain valid for participation (Tepez states a 2-year validity period) plus a reasonable period after, and we are reviewing whether email is an adequate long-term storage method for this sensitive information — see \"Data security\" below.",
        },
        {
          heading: "Communications and marketing",
          body:
            "We send operational messages (session reminders, registration/waitlist updates, schedule changes, billing notices) as needed to run the service; these don't require separate consent. We only send marketing or promotional messages (offers, promotions, general advertising) if you've separately and explicitly opted in via marketing consent in notification settings — this is never required to use the app, and you can withdraw it at any time.",
        },
        {
          heading: "Cookies and local storage",
          body:
            "The web version uses browser local storage to keep you signed in and remember app preferences (such as language and accessibility settings). We do not use tracking cookies or third-party advertising/analytics scripts.",
        },
        {
          heading: "Data security",
          body:
            "Your information is stored in Supabase's managed infrastructure with database-level access controls (Row Level Security) limiting who can read what. Receipt/document files are stored in a private, non-public storage location. Health declarations received by email are currently held in the studio's email inbox rather than the app's own secured storage — we recognize this is a less controlled environment for sensitive health information than the rest of the app, and we are evaluating stronger safeguards for a future update.",
        },
        {
          heading: "Data retention",
          body:
            "Financial records (receipts, invoices, payment records) are retained for 7 years, consistent with Israeli bookkeeping/record-keeping requirements. For other categories — account information, registration/attendance history, consent records, and health declarations — we have not yet finalized fixed retention periods; we keep this information for as long as needed to operate your account and meet legal obligations, and we are working to define and publish specific retention periods for these categories, informed by professional accounting/legal guidance.",
        },
        {
          heading: "Your rights",
          body:
            "You can review and update most of your account information directly in the app (Profile). You may request access to, or correction of, your personal information by contacting us at {{BUSINESS_EMAIL}}. The app does not currently offer a self-service account-deletion or full data-export feature; if you'd like your account closed or your data addressed, contact us and we will assist you manually while we work on adding self-service tools for this.",
        },
        {
          heading: "Changes to this policy",
          body:
            "We may update this Privacy Policy from time to time. Material changes will be published as a new version, and where legally required, you will be asked to review and re-acknowledge it.",
        },
        {
          heading: "Contact",
          body:
            "For privacy questions or requests, contact us at {{BUSINESS_EMAIL}} or {{BUSINESS_PHONE}}.",
        },
      ],
    },
    accessibilityStatement: {
      title: "Accessibility Statement",
      lastUpdated: LAST_UPDATED,
      intro:
        "{{BUSINESS_NAME}} is committed to making the Shira Fit app usable by people with disabilities. This statement describes what we've done so far and what's still in progress — it is not a claim of certified or complete compliance.",
      sections: [
        {
          heading: "Standards we're working toward",
          body:
            "We're targeting the Web Content Accessibility Guidelines (WCAG) 2.1 Level AA and Israeli Standard 5568, which is based on WCAG. This is our first internal accessibility review; the app has not yet been audited or certified by an external accessibility professional.",
        },
        {
          heading: "What we've implemented",
          body:
            "Accessible labels and roles on key interactive elements (forms, buttons, dialogs) across signup, login, and the legal-consent screens. Live-region announcements for error and success messages. Keyboard and screen-reader support for the legal-consent gate and other modals, including a visible way to log out while a required action is pending. A full right-to-left (RTL) Hebrew interface alongside left-to-right English. An accessibility menu on the web version offering text size, high-contrast, enhanced focus visibility, reduced motion, and underlined-links controls, saved across visits on that device.",
        },
        {
          heading: "Known limitations",
          body:
            "Accessibility improvements so far have focused on the newest screens (legal consent, signup, accessibility controls) and have not yet been applied consistently across the entire app. Some older screens may have incomplete labels, inconsistent focus order, or contrast issues we haven't caught yet. We have not performed formal assistive-technology testing (e.g., with a screen-reader user) across the full app, so we do not claim WCAG AA conformance for the app as a whole.",
        },
        {
          heading: "Feedback",
          body:
            "If you encounter an accessibility barrier using the app, please contact us at {{BUSINESS_EMAIL}} or {{BUSINESS_PHONE}} — we want to know about it and will do our best to address it.",
        },
        {
          heading: "Date of last update",
          body: LAST_UPDATED,
        },
      ],
    },
  },
  he: {
    termsOfService: {
      title: "תקנון ותנאי שימוש",
      lastUpdated: LAST_UPDATED,
      intro:
        "תקנון זה מסדיר את השימוש שלך באפליקציית Shira Fit ובשירותי הסטודיו, המופעלים על ידי {{BUSINESS_NAME}} ({{DEALER_STATUS}}){{BUSINESS_ID_CLAUSE}}, {{BUSINESS_ADDRESS}}. יצירת חשבון או שימוש באפליקציה מהווים הסכמה לתנאים אלה.",
      sections: [
        {
          heading: "1. זכאות ורישום חשבון",
          body:
            "עליך למסור מידע מדויק, עדכני ומלא בעת יצירת חשבון — לרבות שם מלא, מספר טלפון, תאריך לידה, כתובת ומיקוד — ולעדכנו בעת הצורך. חשבונות מתאמנים טעונים אישור מנהל לפני קבלת גישה מלאה; עד לאישור, חלק מהתכונות אינן זמינות.",
        },
        {
          heading: "2. הצהרת בריאות",
          body:
            "לפני הרשמה לאימונים, על המתאמן/ת למלא הצהרת בריאות הנדרשת לפי הרגולציה החלה על חדרי כושר/סטודיו לאימונים. ההצהרה מתמלאת בטופס חיצוני עצמאי (שאינו חלק מאפליקציית Shira Fit) — לפרטים ראו מדיניות הפרטיות, סעיף \"הצהרת בריאות (Tepez)\".",
        },
        {
          heading: "3. הרשמה לאימונים, תפוסה ורשימת המתנה",
          body:
            "לכל אימון תפוסה מרבית הנאכפת על ידי המערכת. כאשר אימון מלא, ניתן להצטרף לרשימת המתנה; מקומות מוצעים לפי סדר הגעה (FIFO) ככל שהם מתפנים, ותקבל/י הודעה אם התפנה עבורך מקום.",
        },
        {
          heading: "4. ביטולים וביטול מאוחר",
          body:
            "ניתן לבטל הרשמה דרך האפליקציה. ביטול בתוך פחות מ-24 שעות לפני מועד תחילת האימון נחשב לביטול מאוחר ועשוי לגרור חיוב, כפי שישתקף בחשבונך ובקבלות. כלל 24 השעות נאכף על ידי המערכת עבור כלל המתאמנים.",
        },
        {
          heading: "5. אי-הגעה",
          body:
            "אי-הגעה לאימון שנרשמת אליו, ללא ביטול מראש, עשויה לגרור חיוב לפי שיקול דעת הסטודיו, הנרשם כאשר המאמן/ת או המנהל/ת מסמנים נוכחות. בשונה מכלל הביטול המאוחר לעיל, חיוב בגין אי-הגעה אינו אוטומטי — הוא תלוי בנסיבות ומופעל על ידי הצוות לפי כל מקרה לגופו.",
        },
        {
          heading: "6. תמחור ותשלומים",
          body:
            "מחירי האימונים והחבילות נקבעים על ידי הסטודיו ועשויים להשתנות בהתאם לרמת תפוסה או להסדר ספציפי. ניתן לשלם באמצעים המקובלים על הסטודיו (לרבות מזומן, העברה בנקאית ואמצעים נוספים המוצגים באפליקציה). האחריות לעמידה בהתחייבויות התשלום חלה עליך.",
        },
        {
          heading: "7. קבלות דיגיטליות",
          body:
            "כאשר קבלות דיגיטליות מופעלות, הסטודיו מנפיק עבורך קבלה או חשבונית אלקטרונית בגין תשלומים, הנשלחת לדוא\"ל שלך ו/או זמינה באפליקציה, בהתאם לדרישות ניהול הרישומים הישראליות. {{BUSINESS_NAME}} פועל כיום כ{{DEALER_STATUS}}.",
        },
        {
          heading: "8. תקשורת והתראות",
          body:
            "הסטודיו שולח הודעות תפעוליות הנדרשות להפעלת השירות — תזכורות אימונים, עדכוני הרשמה ורשימת המתנה, שינויי לו\"ז והודעות חיוב/קבלה — דרך האפליקציה, התראות פוש, ובכפוף להסכמתך, וואטסאפ. בנפרד, ורק אם הסכמת לכך במפורש, הסטודיו רשאי לשלוח הודעות שיווקיות או פרסומיות; הסכמה זו היא רשות בלבד, אינה נדרשת לשימוש בשירות, וניתן לבטלה בכל עת. לפרטים ראו מדיניות הפרטיות.",
        },
        {
          heading: "9. שימוש הולם",
          body:
            "הנך מתחייב/ת להשתמש באפליקציה למטרתה בלבד, שלא לפגוע, לשבש או לנסות לקבל גישה בלתי מורשית לשירות או לחשבונות משתמשים אחרים, ושלא למסור מידע כוזב (לרבות נוכחות, תשלום או פעולות הרשמה כוזבות).",
        },
        {
          heading: "10. קניין רוחני",
          body: "האפליקציה, עיצובה ותוכנה הם קניינם של {{BUSINESS_NAME}} או מעניקי הרישיון שלה. אין להעתיק, לשנות או להפיץ אותם ללא רשות.",
        },
        {
          heading: "11. זמינות השירות ושינויים",
          body:
            "הסטודיו רשאי לשנות, להשעות או להפסיק תכונות באפליקציה, ולשנות לוחות זמנים, תמחור או מדיניות, עם מתן הודעה דרך האפליקציה במידת האפשר. אנו שואפים לשירות אמין אך איננו מתחייבים לזמינות רציפה ללא הפרעות.",
        },
        {
          heading: "12. הגבלת אחריות",
          body:
            "לאימון גופני יש סיכון מובנה. השתתפותך באימוני הסטודיו הינה על אחריותך, ועליך לגלות מידע רפואי רלוונטי במסגרת הצהרת הבריאות הנדרשת. במידה המרבית המותרת בחוק, {{BUSINESS_NAME}} לא תישא באחריות לנזקים עקיפים, תוצאתיים או נלווים הנובעים משימוש באפליקציה או מהשתתפות באימונים, למעט במקרים בהם לא ניתן להגביל אחריות לפי הדין הישראלי. סעיף זה אינו גורע מזכויות שלא ניתן להגבילן על פי חוק.",
        },
        {
          heading: "13. פרטיות",
          body: "מדיניות הפרטיות שלנו, המהווה חלק בלתי נפרד מתקנון זה, מפרטת אילו נתונים אישיים אנו אוספים, לשם מה, ומהן זכויותיך לגביהם.",
        },
        {
          heading: "14. שינויים בתקנון",
          body:
            "אנו רשאים לעדכן תקנון זה מעת לעת. שינויים מהותיים יפורסמו כגרסה חדשה, ותתבקש/י לעיין ולאשר את התקנון המעודכן לפני המשך השימוש באפליקציה, כפי שנעשה בכל עדכון מסמך משפטי באפליקציה.",
        },
        {
          heading: "15. דין חל",
          body: "תקנון זה כפוף לדיני מדינת ישראל.",
        },
        {
          heading: "16. יצירת קשר",
          body: "לשאלות בנוגע לתקנון זה ניתן לפנות אל {{BUSINESS_EMAIL}} או {{BUSINESS_PHONE}}.",
        },
      ],
    },
    privacyPolicy: {
      title: "מדיניות פרטיות",
      lastUpdated: LAST_UPDATED,
      intro:
        "מדיניות פרטיות זו מפרטת אילו נתונים אישיים Shira Fit אוספת דרך האפליקציה, לשם מה, ומהן זכויותיך. השירות מופעל על ידי {{BUSINESS_NAME}} ({{DEALER_STATUS}}){{BUSINESS_ID_CLAUSE}}, {{BUSINESS_ADDRESS}} — הגורם האחראי (controller) על הנתונים האישיים המתוארים כאן. קריאה ואישור מדיניות זו (הנרשמים בחשבונך לצורכי תיעוד) מאשרים שהמדיניות הוצגה בפניך; אין בכך, כשלעצמו, הסכמה לכל פעילות עיבוד המתוארת להלן — במקומות בהם החוק דורש הסכמה נפרדת (כגון הודעות שיווקיות), אנו מבקשים אותה בנפרד, וניתן לסרב לה מבלי שהדבר ישפיע על יכולתך להשתמש באפליקציה.",
      sections: [
        {
          heading: "מידע שאנו אוספים",
          body:
            "חשבון וזהות: דוא\"ל, סיסמה, שם מלא, שם משתמש, מספר טלפון, תאריך לידה, גיל, מגדר.\nכתובת: כתובת מגורים ומיקוד, הנאספים לצורך עמידה בדרישות קבלות דיגיטליות.\nסטטוס הצהרת בריאות: רק האם אישרת השלמת הצהרת הבריאות הנדרשת, ומתי — השאלון הרפואי עצמו מתמלא בטופס חיצוני עצמאי, ולא בתוך האפליקציה (ראו \"הצהרת בריאות (Tepez)\" להלן).\nמכשיר והתראות: אסימון התראות פוש אם הפעלת התראות פוש, ומספר טלפון לוואטסאפ אם בחרת בהתראות וואטסאפ.\nחיוב וקבלות: רישומי תשלום, מסמכי קבלה/חשבונית, והיסטוריית חיוב קשורה.\nרישומי הסכמה: אילו גרסאות של אילו מסמכים משפטיים אישרת או דחית, ומתי.\nשימוש: הרשמות לאימונים, נוכחות, ביטולים ופעילות רשימת המתנה הנדרשים להפעלת השירות.",
        },
        {
          heading: "לשם מה אנו אוספים זאת",
          body:
            "כדי ליצור ולנהל את חשבונך וגישה מבוססת-תפקיד; כדי להפעיל הרשמה לאימונים, רשימות המתנה, נוכחות וביטולים; כדי לחייב אותך ולהנפיק קבלות דיגיטליות תואמות דין; כדי לשלוח לך תקשורת תפעולית בנוגע לאימונים ולחשבונך; כדי לשלוח לך תקשורת שיווקית רק אם הסכמת לכך בנפרד; וכדי לעמוד בחובות ניהול רישומים משפטיות ומיסויות.",
        },
        {
          heading: "מה נדרש ומה רשות",
          body:
            "דוא\"ל, סיסמה, שם מלא, טלפון, תאריך לידה, כתובת ומיקוד נדרשים ליצירת חשבון ולשימוש בשירות — בלעדיהם לא נוכל לרשום אותך לאימונים או להנפיק קבלות תואמות דין. התראות פוש, התראות וואטסאפ, ותקשורת שיווקית — כולן רשות; סירוב להן אינו פוגע ביכולתך להשתמש באפליקציה, אם כי ייתכן שתחמיץ התראות נוחות שבחרת לסרב להן.",
        },
        {
          heading: "מי יכול לגשת למידע שלך בפנים הארגון",
          body:
            "למנהלים גישה מלאה לרישומי משתמשים לצורכי תפעול הסטודיו, חיוב וקבלות. מאמנים יכולים לצפות במידע פרופיל של מתאמנים הרלוונטי לניהול אימונים, לרבות פרטי קשר, תאריך לידה וכתובת, כדי שיוכלו לנהל רשימות, נוכחות ותקשורת סטודיו. אנו בוחנים אפשרות לצמצם רמת גישה זו בעדכון עתידי; נכון להיום, היא משקפת את הצרכים התפעוליים הנוכחיים של הסטודיו.",
        },
        {
          heading: "שירותי צד שלישי בהם אנו משתמשים",
          body:
            "Supabase (מסד נתונים, אימות, אחסון ופונקציות שרת). Resend (משלוח דוא\"ל קבלות/מסמכים). WhatsApp Business API של Meta (משלוח התראות וואטסאפ בהן בחרת). Expo (משלוח התראות פוש). ספק אחסון האתר שלנו (הגשת גרסת ה-web/PWA של האפליקציה). איננו משתמשים בשירותי פרסום או מעקב אנליטי, ואיננו מוכרים את המידע האישי שלך.",
        },
        {
          heading: "הצהרת בריאות (Tepez) — שירות צד שלישי עצמאי",
          body:
            "לפני האימון הראשון, תתבקש/י למלא הצהרת בריאות הנדרשת לפי הרגולציה החלה על חדרי כושר/סטודיו. הדבר נעשה בטופס חיצוני המופעל על ידי Tepez, שירות עצמאי שאינו קשור ל-Shira Fit או למשרד הבריאות. ל-Tepez תנאי שימוש ומדיניות פרטיות משלהם, שכדאי לעיין בהם לפני שליחת הטופס — Shira Fit אינה שולטת ואינה אחראית לאופן שבו Tepez מעבדת את המידע שאתה מוסר שם, לרבות בקשתה הנפרדת והרשותית של Tepez להשתמש במידע שלך למטרות פרסום או מסחר (הסכמה זו, אם ניתנה, היא ביניכם לבין Tepez, לא Shira Fit). לאחר מילוי ההצהרה, Tepez שולחת את המסמך שנוצר לכתובת הדוא\"ל של הסטודיו, ומאותו רגע הוא מוחזק ומעובד על ידי Shira Fit. אנו שומרים כיום הצהרות אלה למשך תוקפן להשתתפות (Tepez מציינת תוקף של שנתיים) בתוספת פרק זמן סביר לאחר מכן, ואנו בוחנים האם דוא\"ל הוא אמצעי אחסון הולם לטווח ארוך למידע רגיש זה — ראו \"אבטחת מידע\" להלן.",
        },
        {
          heading: "תקשורת ושיווק",
          body:
            "אנו שולחים הודעות תפעוליות (תזכורות אימונים, עדכוני הרשמה/רשימת המתנה, שינויי לו\"ז, הודעות חיוב) הנדרשות להפעלת השירות; אלה אינן דורשות הסכמה נפרדת. אנו שולחים הודעות שיווקיות או פרסומיות (מבצעים, הטבות, פרסום כללי) רק אם הסכמת לכך במפורש ובנפרד באמצעות הסכמת שיווק בהגדרות ההתראות — הדבר אינו נדרש אף פעם לשימוש באפליקציה, וניתן לבטלו בכל עת.",
        },
        {
          heading: "עוגיות ואחסון מקומי",
          body:
            "גרסת ה-web משתמשת באחסון מקומי בדפדפן כדי לשמור אותך מחובר/ת ולזכור העדפות אפליקציה (כגון שפה והגדרות נגישות). איננו משתמשים בעוגיות מעקב או בסקריפטים פרסומיים/אנליטיים של צד שלישי.",
        },
        {
          heading: "אבטחת מידע",
          body:
            "המידע שלך מאוחסן בתשתית המנוהלת של Supabase עם בקרות גישה ברמת מסד הנתונים (Row Level Security) המגבילות מי יכול לקרוא מה. קובצי קבלות/מסמכים מאוחסנים במיקום אחסון פרטי ולא-ציבורי. הצהרות בריאות המתקבלות בדוא\"ל מוחזקות כיום בתיבת הדוא\"ל של הסטודיו ולא באחסון המאובטח של האפליקציה עצמה — אנו מכירים בכך שמדובר בסביבה פחות מבוקרת עבור מידע רפואי רגיש מיתר האפליקציה, ואנו בוחנים אמצעי הגנה משופרים לעדכון עתידי.",
        },
        {
          heading: "שמירת מידע",
          body:
            "רישומים פיננסיים (קבלות, חשבוניות, רישומי תשלום) נשמרים למשך 7 שנים, בהתאם לדרישות ניהול פנקסים בישראל. עבור קטגוריות אחרות — מידע חשבון, היסטוריית הרשמה/נוכחות, רישומי הסכמה והצהרות בריאות — טרם קבענו תקופות שמירה סופיות; אנו שומרים מידע זה כל עוד נדרש להפעלת חשבונך ולעמידה בחובות משפטיות, ואנו פועלים להגדיר ולפרסם תקופות שמירה ספציפיות לקטגוריות אלה, בהתבסס על ייעוץ מקצועי חשבונאי/משפטי.",
        },
        {
          heading: "הזכויות שלך",
          body:
            "ניתן לעיין ולעדכן את רוב פרטי חשבונך ישירות באפליקציה (פרופיל). ניתן לבקש גישה למידע האישי שלך או תיקונו בפנייה אלינו ל-{{BUSINESS_EMAIL}}. האפליקציה אינה מציעה כיום תכונת מחיקת חשבון עצמאית או ייצוא מלא של נתונים; אם ברצונך שהחשבון ייסגר או שנטפל במידע שלך, פנה/י אלינו ונסייע באופן ידני בזמן שאנו עובדים על הוספת כלים עצמאיים לכך.",
        },
        {
          heading: "שינויים במדיניות זו",
          body:
            "אנו עשויים לעדכן מדיניות פרטיות זו מעת לעת. שינויים מהותיים יפורסמו כגרסה חדשה, ובמקומות בהם נדרש על פי דין, תתבקש/י לעיין ולאשר מחדש.",
        },
        {
          heading: "יצירת קשר",
          body: "לשאלות או בקשות בנושא פרטיות, ניתן לפנות אלינו ל-{{BUSINESS_EMAIL}} או {{BUSINESS_PHONE}}.",
        },
      ],
    },
    accessibilityStatement: {
      title: "הצהרת נגישות",
      lastUpdated: LAST_UPDATED,
      intro:
        "{{BUSINESS_NAME}} מחויבת להנגיש את אפליקציית Shira Fit לאנשים עם מוגבלות. הצהרה זו מתארת מה נעשה עד כה ומה עדיין בתהליך — אין בה הצהרה על עמידה מלאה או מוסמכת בתקן.",
      sections: [
        {
          heading: "תקנים שאנו שואפים אליהם",
          body:
            "אנו שואפים לעמוד בהנחיות Web Content Accessibility Guidelines (WCAG) 2.1 ברמה AA ובתקן ישראלי 5568, המבוסס על WCAG. זוהי סקירת הנגישות הפנימית הראשונה שלנו; האפליקציה טרם נבדקה או אושרה על ידי איש מקצוע חיצוני בתחום הנגישות.",
        },
        {
          heading: "מה יישמנו",
          body:
            "תוויות ותפקידי נגישות (accessibility roles/labels) על אלמנטים אינטראקטיביים מרכזיים (טפסים, כפתורים, דיאלוגים) במסכי ההרשמה, ההתחברות ואישור המסמכים המשפטיים. הכרזות אזור-חי (live region) עבור הודעות שגיאה והצלחה. תמיכה במקלדת ובקוראי מסך עבור מסך אישור המסמכים המשפטיים וחלונות קופצים נוספים, כולל אפשרות ברורה להתנתק בזמן שפעולה נדרשת ממתינה. ממשק עברי מלא מימין-לשמאל (RTL) לצד אנגלית משמאל-לימין. תפריט נגישות בגרסת ה-web המציע גודל טקסט, ניגודיות גבוהה, הדגשת מיקוד משופרת, הפחתת אנימציה והדגשת קישורים, הנשמרים בין ביקורים במכשיר זה.",
        },
        {
          heading: "מגבלות ידועות",
          body:
            "שיפורי הנגישות עד כה התמקדו במסכים החדשים ביותר (אישור מסמכים משפטיים, הרשמה, בקרות נגישות) וטרם יושמו באופן עקבי בכל חלקי האפליקציה. ייתכן שבמסכים ותיקים יותר יימצאו תוויות חסרות, סדר מיקוד לא עקבי או בעיות ניגודיות שטרם אותרו. לא בוצעה בדיקה פורמלית עם טכנולוגיה מסייעת (למשל עם משתמש/ת קורא מסך) על פני האפליקציה כולה, ולכן איננו טוענים לעמידה בתקן WCAG AA עבור האפליקציה כמכלול.",
        },
        {
          heading: "משוב",
          body: "אם נתקלת בחסם נגישות בשימוש באפליקציה, אנא פנה/י אלינו ל-{{BUSINESS_EMAIL}} או {{BUSINESS_PHONE}} — נשמח לדעת ונעשה מאמץ לטפל בכך.",
        },
        {
          heading: "תאריך עדכון אחרון",
          body: LAST_UPDATED,
        },
      ],
    },
  },
};
