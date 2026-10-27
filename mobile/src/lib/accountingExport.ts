import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { supabase, supabaseUrl, supabaseAnonKey } from "./supabase";

export type AccountingExportFormat = "csv" | "zip";

export interface AccountingExportOptions {
  format: AccountingExportFormat;
  /** ISO date-times. Required unless fullHistory is true. */
  dateStart?: string;
  dateEnd?: string;
  /** Bypasses the date requirement -- still subject to the server's row cap (see
   *  AccountingExportTooLargeError), which exists specifically so a request can never cause
   *  unbounded memory/execution cost in the export-accounting-documents Edge Function. */
  fullHistory?: boolean;
  status?: "ACTIVE" | "CANCELLED";
}

/** The filtered range matched more documents than the server will export in one call. */
export class AccountingExportTooLargeError extends Error {
  rowCap: number;
  matchedCount: number | null;
  constructor(rowCap: number, matchedCount: number | null) {
    super("too_many_rows");
    this.rowCap = rowCap;
    this.matchedCount = matchedCount;
  }
}

async function callExportFunction(opts: AccountingExportOptions): Promise<Blob> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("not_authenticated");

  const res = await fetch(`${supabaseUrl}/functions/v1/export-accounting-documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({
      format: opts.format,
      date_start: opts.dateStart,
      date_end: opts.dateEnd,
      full_history: opts.fullHistory === true,
      status: opts.status,
    }),
  });

  if (!res.ok) {
    let payload: { error?: string; row_cap?: number; matched_count?: number | null } | null = null;
    try {
      payload = await res.json();
    } catch {
      // non-JSON error body -- fall through to the generic error below
    }
    if (payload?.error === "too_many_rows") {
      throw new AccountingExportTooLargeError(payload.row_cap ?? 0, payload.matched_count ?? null);
    }
    throw new Error(payload?.error ?? `export_failed_${res.status}`);
  }

  return await res.blob();
}

/** Downloads (web) or shares (native) the accounting export. Throws AccountingExportTooLargeError
 *  if the filtered range matches more documents than the server allows in one export -- narrow
 *  the date range and retry rather than treating that as a generic failure. */
export async function runAccountingExport(opts: AccountingExportOptions): Promise<void> {
  const blob = await callExportFunction(opts);
  const ext = opts.format === "zip" ? "zip" : "csv";
  const filename = `accounting-export-${new Date().toISOString().slice(0, 10)}.${ext}`;

  if (Platform.OS === "web") {
    if (typeof document === "undefined") return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(new Uint8Array(await blob.arrayBuffer()));

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri);
  }
}
