import type { ReactNode } from "react";
import { ScrollView, Text, View, StyleSheet, Pressable, Platform } from "react-native";
import { useRouter } from "expo-router";
import { theme } from "../src/theme";
import { useI18n } from "../src/context/I18nContext";

/**
 * Public privacy policy for App Store / Play Console (linked from footer & configurable URL).
 * Served at /privacy-policy when the Expo web build is deployed (e.g. Render static site).
 */
export default function PrivacyPolicyScreen() {
  const router = useRouter();
  const { language, isRTL } = useI18n();

  const back =
    language === "he"
      ? Platform.OS === "web"
        ? "חזרה לאפליקציה"
        : "חזרה"
      : Platform.OS === "web"
        ? "Back to app"
        : "Back";

  return (
    <View style={styles.wrap}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[styles.h1, isRTL && styles.rtl]}>{language === "he" ? "מדיניות פרטיות" : "Privacy Policy"}</Text>
        <Text style={[styles.updated, isRTL && styles.rtl]}>
          {language === "he" ? "עודכן: מאי 2026" : "Last updated: May 2026"}
        </Text>

        <Section title={language === "he" ? "מבוא" : "Introduction"} isRTL={isRTL}>
          {language === "he"
            ? 'שירה פיט ("אנחנו", "הסטודיו") מפעילה את אפליקציית Shira Fit לאימון וניהול הרשמה לאימונים. מסמך זה מסביר איזה מידע נאסף, כיצד משתמשים בו, והזכויות שלך — כולל מחיקת חשבון.'
            : 'Shira Fit (“we”, “the studio”) operates the Shira Fit mobile and web app for fitness scheduling and registration. This policy explains what we collect, how we use it, and your rights — including deleting your account.'}
        </Section>

        <Section title={language === "he" ? "בקר ועיבוד מידע" : "Controller & processing"} isRTL={isRTL}>
          {language === "he"
            ? "הסטודיו הוא אחראי למידע שאת/ה מוסר/ת במסגרת השירות. תשתית האימות והמסד Database של האפליקציה מסופקים על ידי Supabase (ספק ענן). הנתונים נשמרים במצב מוצפן בזמן העברה (HTTPS)."
            : "The studio is responsible for information you provide through the service. Authentication and database infrastructure are provided by Supabase (cloud provider). Data is encrypted in transit (HTTPS)."}
        </Section>

        <Section title={language === "he" ? "מידע שאנחנו אוספים" : "Data we collect"} isRTL={isRTL}>
          <Bullet isRTL={isRTL}>
            {language === "he"
              ? "חשבון משתמש: אימייל וסיסמה (דרך Supabase Auth)."
              : "Account: email and password (via Supabase Auth)."}
          </Bullet>
          <Bullet isRTL={isRTL}>
            {language === "he"
              ? "פרופיל: שם מלא, טלפון, גיל, מגדר, תפקיד (מתאמן/מאמן/מנהל), סטטוס אישור, ופרטים שהוזנו בטפסים במערכת."
              : "Profile: full name, phone, age, gender, role (athlete/coach/manager), approval status, and information entered in in-app forms."}
          </Bullet>
          <Bullet isRTL={isRTL}>
            {language === "he"
              ? "פעילות באפליקציה: הרשמה לאימונים, רשימת המתנה, ביטולים, נוכחות ונתונים תפעוליים הקשורים לאימונים."
              : "App activity: session sign-ups, waitlist, cancellations, attendance, and operational training data."}
          </Bullet>
          <Bullet isRTL={isRTL}>
            {language === "he"
              ? "התראות: אם תפעיל/י תזכורות או התראות רשימת המתנה, נשתמש בהרשאות התראות במכשיר ונשמור נטול זיהוי אישי לפי הצורך (אסימון התראות של Expo) כדי לשלוח התראות רלוונטיות."
              : "Notifications: if you enable reminders or waitlist alerts, we use your device notification permission and may store an Expo push token on your profile for relevant alerts."}
          </Bullet>
          <Bullet isRTL={isRTL}>
            {language === "he"
              ? "יומן פעילות (לצוות): אירועי מערכת כפי שהוגדרו במוצר (למשל שינויים תפעוליים) — לצורך תמיכה וביקורת."
              : "Activity events (staff-facing): system events as configured in the product — for support and audit."}
          </Bullet>
        </Section>

        <Section title={language === "he" ? "שימוש במידע" : "How we use data"} isRTL={isRTL}>
          {language === "he"
            ? "להפעלת השירות: זיהוי, תיאום אימונים, ניהול הרשאות לפי תפקיד, תקשורת עם משתמשים לגבי החשבון והאימונים, ושיפור יציבות המערכת."
            : "To operate the service: identity, scheduling, role-based access, communications about your account and sessions, and reliability of the system."}
        </Section>

        <Section title={language === "he" ? "שיתוף צד שלישי" : "Sharing"} isRTL={isRTL}>
          {language === "he"
            ? "אנו משתמשים ב-Supabase לאחסון ואימות. איננו מוכרים את המידע שלך. שיתוף נוסף יתבצע רק ככל שנדרש על פי חוק או כדי להגן על זכויות המשתמשים והסטודיו."
            : "We use Supabase for hosting and authentication. We do not sell your personal information. Further disclosure occurs only where required by law or to protect users and the studio."}
        </Section>

        <Section title={language === "he" ? "שמירה" : "Retention"} isRTL={isRTL}>
          {language === "he"
            ? "נשמרים הנתונים כל עוד החשבון פעיל וככל שנדרש לצורך הפעלת הסטודיו והתחייבויות משפטיות. הגדרות יומן פעילות עשויות למחוק אירועים ישנים לפי המדיניות במערכת."
            : "We retain data while your account is active and as needed to operate the studio and meet legal obligations. Activity log retention settings may delete older events per system configuration."}
        </Section>

        <Section title={language === "he" ? "הזכויות שלך" : "Your rights"} isRTL={isRTL}>
          {language === "he"
            ? "כוללות גישה ותיקון פרטים בפרופיל, בקשות נוספות לפי דין החל, ומחיקת חשבון דרך האפליקציה (פרופיל → חשבון) כאשר רלוונטי. חשבונות מאמן עם אימונים פעילים או מנהלים עשויים לדרוש טיפול דרך הסטודיו בשל מגבלות תפעוליות."
            : "Including access and correction in your profile, further requests under applicable law, and account deletion in the app (Profile → Account) where applicable. Coaches assigned to sessions or managers may need studio assistance due to operational constraints."}
        </Section>

        <Section title={language === "he" ? "יצירת קשר" : "Contact"} isRTL={isRTL}>
          <Text style={[styles.p, isRTL && styles.rtl]}>
            {language === "he" ? "טלפון: " : "Phone: "}
            <Text style={styles.link}>052-959-3297</Text>
          </Text>
          <Text style={[styles.p, isRTL && styles.rtl]}>
            {language === "he" ? "אתר: " : "Website: "}
            <Text style={styles.link}>get-marketing.co.il/shira-fit</Text>
          </Text>
        </Section>

        <Pressable
          onPress={() => (Platform.OS === "web" ? router.replace("/") : router.back())}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.backBtnTxt}>{back}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Section({
  title,
  children,
  isRTL,
}: {
  title: string;
  children: ReactNode;
  isRTL: boolean;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.h2, isRTL && styles.rtl]}>{title}</Text>
      {typeof children === "string" ? <Text style={[styles.p, isRTL && styles.rtl]}>{children}</Text> : children}
    </View>
  );
}

function Bullet({ children, isRTL }: { children: string; isRTL: boolean }) {
  return (
    <Text style={[styles.bullet, isRTL && styles.rtl]}>
      {"\u2022 "}
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { padding: theme.spacing.lg, paddingBottom: 48, maxWidth: 720, alignSelf: "center", width: "100%" },
  h1: { fontSize: 26, fontWeight: "900", color: theme.colors.text, marginBottom: 8 },
  updated: { fontSize: 13, color: theme.colors.textMuted, marginBottom: 24 },
  h2: { fontSize: 17, fontWeight: "800", color: theme.colors.text, marginTop: 20, marginBottom: 10 },
  p: { fontSize: 15, lineHeight: 24, color: theme.colors.textMuted, fontWeight: "500" },
  bullet: { fontSize: 15, lineHeight: 24, color: theme.colors.textMuted, fontWeight: "500", marginBottom: 8 },
  section: { marginBottom: 4 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  link: { color: theme.colors.cta, fontWeight: "700" },
  backBtn: {
    marginTop: 28,
    alignSelf: "flex-start",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  backBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", fontSize: 15 },
});
