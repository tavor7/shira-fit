import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { athleteSearchSubtitle } from "../lib/displayName";
import { useI18n } from "../context/I18nContext";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { AppSearchField } from "../components/AppSearchField";
import { AppModal } from "../components/AppModal";
import { PrimaryButton } from "../components/PrimaryButton";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../context/ToastContext";
import {
  type AthleteFamilyListItem,
  type AthleteFamilyMember,
  type FamilyMemberKind,
  memberPayeeKey,
  parseFamilyMembers,
} from "../lib/athleteFamilies";

type PickerRow =
  | { kind: "app"; id: string; full_name: string; username?: string; phone?: string }
  | { kind: "manual"; id: string; full_name: string; phone?: string };

function familyRpcError(code: string, t: (k: string) => string, language: string): string {
  switch (code) {
    case "name_required":
      return t("families.errorNameRequired");
    case "member_in_other_family":
      return t("families.errorMemberInOtherFamily");
    case "invalid_athlete":
    case "invalid_manual":
    case "invalid_member":
      return t("families.errorInvalidMember");
    default:
      return code || (language === "he" ? "שגיאה" : "Error");
  }
}

export default function FamilyManagementScreen() {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const [families, setFamilies] = useState<AthleteFamilyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState("");
  const [members, setMembers] = useState<AthleteFamilyMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [memberSearchQ, setMemberSearchQ] = useState("");
  const [candidateRows, setCandidateRows] = useState<PickerRow[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  const loadFamilies = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("list_athlete_families");
    setLoading(false);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      setFamilies([]);
      return;
    }
    const payload = data as { ok?: boolean; families?: unknown[]; error?: string };
    if (!payload?.ok) {
      Alert.alert(t("common.error"), payload?.error ?? t("common.error"));
      setFamilies([]);
      return;
    }
    const list = (payload.families ?? [])
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : null;
        const name = typeof r.name === "string" ? r.name : null;
        if (!id || !name) return null;
        return {
          id,
          name,
          members: parseFamilyMembers(r.members).map(({ kind, id: mid, name: mname }) => ({
            kind,
            id: mid,
            name: mname,
          })),
        } satisfies AthleteFamilyListItem;
      })
      .filter(Boolean) as AthleteFamilyListItem[];
    setFamilies(list);
  }, [t]);

  useEffect(() => {
    void loadFamilies();
  }, [loadFamilies]);

  const loadCandidates = useCallback(async (termRaw: string) => {
    const q = termRaw.trim();
    setCandidatesLoading(true);
    let query = supabase
      .from("profiles")
      .select("user_id, full_name, username, phone")
      .eq("role", "athlete")
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      query = query.or(`full_name.ilike.%${q}%,username.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await query;

    let mQuery = supabase
      .from("manual_participants")
      .select("id, full_name, phone, linked_user_id")
      .is("disabled_at", null)
      .order("full_name", { ascending: true })
      .limit(200);
    if (q.length > 0) {
      mQuery = mQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data: mData, error: mErr } = await mQuery;
    setCandidatesLoading(false);

    if (error) {
      setCandidateRows([]);
      return;
    }

    const appRows: PickerRow[] = ((data as { user_id: string; full_name: string; username?: string; phone?: string }[]) ?? []).map(
      (a) => ({ kind: "app", id: a.user_id, full_name: a.full_name, username: a.username, phone: a.phone })
    );
    const seen = new Set(appRows.map((a) => a.id));
    const manualRows: PickerRow[] = mErr
      ? []
      : ((mData as { id: string; full_name: string; phone?: string; linked_user_id?: string | null }[]) ?? [])
          .filter((m) => !m.linked_user_id || !seen.has(m.linked_user_id))
          .map((m) => ({ kind: "manual", id: m.id, full_name: m.full_name, phone: m.phone }));

    setCandidateRows([...manualRows, ...appRows]);
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    setMemberSearchQ("");
    void loadCandidates("");
  }, [editorOpen, loadCandidates]);

  function openCreate() {
    setEditingId(null);
    setFamilyName("");
    setMembers([]);
    setMemberSearchQ("");
    setEditorOpen(true);
  }

  function openEdit(family: AthleteFamilyListItem) {
    setEditingId(family.id);
    setFamilyName(family.name);
    setMembers(
      family.members.map((m) => ({
        kind: m.kind,
        id: m.id,
        name: m.name,
        payee_is_manual: m.kind === "manual",
      }))
    );
    setMemberSearchQ("");
    setEditorOpen(true);
  }

  function toggleMember(row: PickerRow) {
    const kind: FamilyMemberKind = row.kind === "manual" ? "manual" : "app";
    const key = memberPayeeKey(kind, row.id);
    setMembers((cur) => {
      if (cur.some((m) => memberPayeeKey(m.kind, m.id) === key)) {
        return cur.filter((m) => memberPayeeKey(m.kind, m.id) !== key);
      }
      return [
        ...cur,
        {
          kind,
          id: row.id,
          name: row.full_name,
          payee_is_manual: kind === "manual",
        },
      ];
    });
  }

  async function saveFamily() {
    const name = familyName.trim();
    if (!name) {
      Alert.alert(t("common.error"), t("families.errorNameRequired"));
      return;
    }
    if (members.length === 0) {
      Alert.alert(t("common.error"), t("families.errorMembersRequired"));
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.rpc("upsert_athlete_family", {
      p_family_id: editingId,
      p_name: name,
      p_members: members.map((m) => ({ kind: m.kind, id: m.id })),
    });
    setSaving(false);
    if (error) {
      Alert.alert(t("common.error"), error.message);
      return;
    }
    const payload = data as { ok?: boolean; error?: string };
    if (!payload?.ok) {
      Alert.alert(t("common.error"), familyRpcError(String(payload?.error ?? ""), t, language));
      return;
    }
    showToast({ message: t("families.saved"), variant: "success" });
    setEditorOpen(false);
    void loadFamilies();
  }

  function confirmDelete(family: AthleteFamilyListItem) {
    Alert.alert(t("families.deleteTitle"), t("families.deleteConfirm").replace("{name}", family.name), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => {
          void (async () => {
            const { data, error } = await supabase.rpc("delete_athlete_family", { p_family_id: family.id });
            if (error) {
              Alert.alert(t("common.error"), error.message);
              return;
            }
            const payload = data as { ok?: boolean; error?: string };
            if (!payload?.ok) {
              Alert.alert(t("common.error"), payload?.error ?? t("common.error"));
              return;
            }
            showToast({ message: t("families.deleted"), variant: "success" });
            void loadFamilies();
          })();
        },
      },
    ]);
  }

  const memberKeys = useMemo(() => new Set(members.map((m) => memberPayeeKey(m.kind, m.id))), [members]);

  return (
    <View style={styles.screen}>
      <FlatList
        data={families}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            <ManagerStudioSetupTabs />
            <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.families")}</Text>
            <Text style={[styles.subtitle, isRTL && styles.rtl]}>{t("families.subtitle")}</Text>
            <PrimaryButton label={t("families.create")} onPress={openCreate} />
          </>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Pressable onPress={() => openEdit(item)} style={({ pressed }) => [pressed && { opacity: 0.92 }]}>
              <Text style={[styles.cardTitle, isRTL && styles.rtl]}>{item.name}</Text>
              <Text style={[styles.cardMeta, isRTL && styles.rtl]}>
                {t("families.memberCount").replace("{n}", String(item.members.length))}
              </Text>
              <View style={[styles.chipRow, isRTL && styles.chipRowRtl]}>
                {item.members.map((m) => (
                  <View key={memberPayeeKey(m.kind, m.id)} style={styles.chip}>
                    <Text style={styles.chipTxt} numberOfLines={1}>
                      {m.name?.trim() || "—"}
                    </Text>
                  </View>
                ))}
              </View>
            </Pressable>
            <View style={[styles.cardActions, isRTL && styles.cardActionsRtl]}>
              <Pressable
                onPress={() => confirmDelete(item)}
                accessibilityRole="button"
                accessibilityLabel={t("common.delete")}
                style={({ pressed }) => [styles.deleteBtn, pressed && styles.deleteBtnPressed]}
              >
                <Text style={styles.deleteBtnTxt}>{t("common.delete")}</Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={
          !loading ? <EmptyState title={t("families.empty")} isRTL={isRTL} /> : null
        }
      />

      <AppModal
        visible={editorOpen}
        onClose={() => {
          if (saving) return;
          setEditorOpen(false);
        }}
        variant="dialog"
        maxHeightPct={0.9}
        backdropAccessibilityLabel={language === "he" ? "סגירה" : "Dismiss"}
        cardStyle={styles.editorCard}
      >
        <View style={styles.editorBody}>
          <Text style={[styles.editorTitle, isRTL && styles.rtl]}>
            {editingId ? t("families.editTitle") : t("families.createTitle")}
          </Text>
          <Text style={[styles.label, isRTL && styles.rtl]}>{t("families.nameLabel")}</Text>
          <TextInput
            value={familyName}
            onChangeText={setFamilyName}
            placeholder={t("families.namePlaceholder")}
            placeholderTextColor={theme.colors.placeholderOnLight}
            style={[styles.input, isRTL && styles.inputRtl]}
            editable={!saving}
          />

          <Text style={[styles.label, isRTL && styles.rtl]}>{t("families.membersLabel")}</Text>
          <Text style={[styles.membersHint, isRTL && styles.rtl]}>{t("families.membersPickHint")}</Text>
          {members.length > 0 ? (
            <Text style={[styles.selectedCount, isRTL && styles.rtl]}>
              {t("families.selectedCount").replace("{n}", String(members.length))}
            </Text>
          ) : null}
          <AppSearchField
            value={memberSearchQ}
            onChangeText={setMemberSearchQ}
            onSearch={(term) => void loadCandidates(term)}
            placeholder={t("families.searchMembersPlaceholder")}
            isRTL={isRTL}
            loading={candidatesLoading}
            editable={!saving}
            style={styles.memberSearch}
          />

          <View style={styles.choicesPanel}>
            {candidatesLoading && candidateRows.length === 0 ? (
              <ActivityIndicator color={theme.colors.cta} style={styles.choicesLoader} />
            ) : candidateRows.length === 0 ? (
              <EmptyState title={t("empty.noResults")} isRTL={isRTL} style={styles.choicesEmptyState} />
            ) : (
              <ScrollView
                style={styles.choicesScroll}
                contentContainerStyle={styles.choicesScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                {candidateRows.map((row) => {
                  const kind: FamilyMemberKind = row.kind === "manual" ? "manual" : "app";
                  const key = memberPayeeKey(kind, row.id);
                  const selected = memberKeys.has(key);
                  return (
                    <Pressable
                      key={key}
                      onPress={() => toggleMember(row)}
                      disabled={saving}
                      style={({ pressed }) => [
                        styles.choiceRow,
                        isRTL && styles.choiceRowRtl,
                        selected && styles.choiceRowOn,
                        pressed && !saving && styles.choiceRowPressed,
                      ]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                    >
                      <View style={[styles.choiceCheck, selected && styles.choiceCheckOn]}>
                        {selected ? <Text style={styles.choiceCheckMark}>✓</Text> : null}
                      </View>
                      <View style={styles.choiceText}>
                        <Text style={[styles.choiceName, isRTL && styles.rtl]} numberOfLines={1}>
                          {row.full_name}
                        </Text>
                        <Text style={[styles.choiceSub, isRTL && styles.rtl]} numberOfLines={1}>
                          {row.kind === "manual"
                            ? `${row.phone ?? ""} · ${language === "he" ? "מהיר" : "Quick Add"}`
                            : athleteSearchSubtitle(row.phone)}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <PrimaryButton
            label={t("common.save")}
            onPress={() => void saveFamily()}
            loading={saving}
            loadingLabel={t("common.loading")}
            style={styles.editorSave}
          />
        </View>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  listContent: { padding: theme.spacing.md, paddingBottom: 48, gap: theme.spacing.sm },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  title: { fontSize: 22, fontWeight: "900", color: theme.colors.text, marginTop: theme.spacing.sm },
  subtitle: { fontSize: 13, color: theme.colors.textMuted, marginTop: 4, marginBottom: theme.spacing.md, lineHeight: 18 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  cardTitle: { fontSize: 17, fontWeight: "800", color: theme.colors.text },
  cardMeta: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chipRowRtl: { flexDirection: "row-reverse" },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxWidth: "100%",
  },
  chipTxt: { fontSize: 12, fontWeight: "700", color: theme.colors.text },
  cardActions: {
    marginTop: theme.spacing.xs,
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    flexDirection: "row",
    alignItems: "center",
  },
  cardActionsRtl: { flexDirection: "row-reverse" },
  deleteBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
  },
  deleteBtnPressed: { opacity: 0.88 },
  deleteBtnTxt: { color: theme.colors.error, fontWeight: "800", fontSize: 13 },
  editorCard: { maxWidth: 480, width: "100%" },
  editorBody: { padding: theme.spacing.md, paddingBottom: theme.spacing.lg, gap: 4 },
  editorSave: { marginTop: theme.spacing.md },
  editorTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: theme.spacing.xs },
  label: { fontSize: 13, fontWeight: "800", color: theme.colors.textMuted, marginTop: theme.spacing.sm },
  membersHint: { fontSize: 12, color: theme.colors.textSoft, lineHeight: 17, marginTop: 2 },
  selectedCount: { fontSize: 12, fontWeight: "700", color: theme.colors.cta, marginTop: 4 },
  memberSearch: { marginTop: 8 },
  choicesPanel: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    minHeight: 160,
    maxHeight: 260,
    overflow: "hidden",
  },
  choicesScroll: { flexGrow: 0 },
  choicesScrollContent: { paddingVertical: 4 },
  choicesLoader: { marginVertical: theme.spacing.lg },
  choicesEmptyState: { paddingVertical: theme.spacing.md },
  choiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  choiceRowRtl: { flexDirection: "row-reverse" },
  choiceRowOn: { backgroundColor: theme.colors.surfaceElevated },
  choiceRowPressed: { opacity: 0.9 },
  choiceCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.backgroundAlt,
  },
  choiceCheckOn: {
    borderColor: theme.colors.cta,
    backgroundColor: theme.colors.cta,
  },
  choiceCheckMark: { color: theme.colors.ctaText, fontSize: 14, fontWeight: "900", lineHeight: 16 },
  choiceText: { flex: 1, minWidth: 0 },
  choiceName: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  choiceSub: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    borderRadius: theme.radius.md,
    padding: 12,
    marginTop: 6,
    fontSize: 16,
    backgroundColor: theme.colors.white,
    color: theme.colors.textOnLight,
  },
  inputRtl: { textAlign: "right" },
});
