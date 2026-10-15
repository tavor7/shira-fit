/**
 * Signup-data synchronisation after sign-in (Performance Phase 1 / step 2).
 *
 * The three server functions are idempotent fallbacks for data captured at signup (profile fields from metadata,
 * electronic-receipts consent, terms/privacy/marketing consents). The consent ones also run server-side when the email
 * is confirmed (trigger on auth.users), so the client call only matters when that path could not complete.
 *
 * Before: all three ran sequentially on EVERY profile load (bootstrap, the INITIAL_SESSION echo, every tab/PWA resume),
 * and the app waited for them before showing any screen. Now: at most once per user per app session, off the critical
 * path. The profile sync runs first because the receipts-consent sync reads `health_declaration_confirmed_at`, which the
 * profile sync may set; the two consent syncs are independent and run in parallel.
 */

export type SignupSyncDeps = {
  syncProfile: () => Promise<boolean>;
  syncReceiptsConsent: () => Promise<boolean>;
  syncLegalConsents: () => Promise<number>;
};

export type SignupSyncResult = {
  /** False when this user was already synced in this app session (nothing was called). */
  ran: boolean;
  /**
   * The profile sync wrote the row. Note: the server reports this whenever signup metadata exists, even when every
   * value was already set (it rewrites the same values), so use `profileHasSignupGaps` to decide whether to re-read.
   */
  profileApplied: boolean;
  /** An electronic-receipts consent was recorded now (also updates the profile's consent version). */
  receiptsConsentRecorded: boolean;
  /** Terms / privacy / marketing consents recorded now. */
  legalConsentsRecorded: number;
};

/**
 * Whether the profile sync could have changed anything: it only fills EMPTY fields (lib migration
 * _apply_signup_profile_from_metadata). It also recomputes `age`, which the client does not use.
 */
export function profileHasSignupGaps(p: {
  full_name?: string | null;
  phone?: string | null;
  address?: string | null;
  zip_code?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  health_declaration_confirmed_at?: string | null;
} | null): boolean {
  if (!p) return true;
  const empty = (v: string | null | undefined) => !v || v.trim() === "";
  return (
    empty(p.full_name) ||
    empty(p.phone) ||
    empty(p.address) ||
    empty(p.zip_code) ||
    (p.gender !== "male" && p.gender !== "female") ||
    !p.date_of_birth ||
    !p.health_declaration_confirmed_at
  );
}

const syncedUserIds = new Set<string>();

/** True once the sync for this user has started in this app session (later calls are no-ops). */
export function hasSignupSyncRun(userId: string): boolean {
  return syncedUserIds.has(userId);
}

export async function runSignupSyncOnce(userId: string, deps: SignupSyncDeps): Promise<SignupSyncResult> {
  const none = { profileApplied: false, receiptsConsentRecorded: false, legalConsentsRecorded: 0 };
  if (syncedUserIds.has(userId)) return { ran: false, ...none };
  syncedUserIds.add(userId);
  try {
    const profileApplied = await deps.syncProfile();
    const [receiptsConsentRecorded, legalConsentsRecorded] = await Promise.all([
      deps.syncReceiptsConsent(),
      deps.syncLegalConsents(),
    ]);
    return { ran: true, profileApplied, receiptsConsentRecorded, legalConsentsRecorded };
  } catch {
    // Non-blocking, as before: the consent gates still prompt for anything that is still missing.
    return { ran: true, ...none };
  }
}

/** Tests only. */
export function resetSignupSyncForTests(): void {
  syncedUserIds.clear();
}
