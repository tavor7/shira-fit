/**
 * The client's copy of the SERVER allowlist (Phase 3E.2 migration 20261015100000_system_monitoring_client_allowlist.sql, 58 exact rules).
 * The server is the security boundary: it accepts a client report only when an enabled authorizing rule matches the exact
 * (operation, error_class, error_code) tuple. The client sends nothing outside this table, which keeps it from spending quota on
 * reports the server would reject. Drift is guarded by remoteReporting.test.ts (the migration's seed must equal this table).
 *
 * Contract:
 *   rpc/<rpc name>   RpcOutcome       registry code (HTTP 2xx ok:false, or the RAISE token of a 4xx P0001)
 *   rpc/<rpc name>   RpcReason        reviewed reason code (manager_activity_revert_info)
 *   rpc/postgrest    PostgrestError   exact SQLSTATE / PGRST code (the RPC name travels in context.rpc)
 *   transport/infra  HttpError        http_502 | http_503 | http_504
 *   transport/server HttpError        http_500
 */
export type AllowlistTuple = readonly [operation: string, errorClass: string, errorCode: string];

export const SERVER_ALLOWLIST: readonly AllowlistTuple[] = [
  // RpcOutcome
  ["rpc/edit_subscription_version", "RpcOutcome", "no_current_version"],
  ["rpc/freeze_subscription", "RpcOutcome", "no_current_version"],
  ["rpc/get_current_legal_document", "RpcOutcome", "not_found"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "missing_attendance_context"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "missing_cancellation_context"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "missing_note_context"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "missing_registration_context"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "missing_role_context"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "missing_status_context"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "remove_failed"],
  ["rpc/manager_revert_activity_event", "RpcOutcome", "restore_failed"],
  ["rpc/manager_set_cancellation_charge", "RpcOutcome", "session_not_found"],
  ["rpc/reactivate_subscription", "RpcOutcome", "source_has_no_version"],
  ["rpc/register_for_session", "RpcOutcome", "no_profile"],
  ["rpc/stop_subscription", "RpcOutcome", "no_current_version"],
  ["rpc/update_session_note", "RpcOutcome", "session_not_found"],
  // RpcReason
  ["rpc/manager_activity_revert_info", "RpcReason", "missing_attendance_context"],
  ["rpc/manager_activity_revert_info", "RpcReason", "missing_cancellation_context"],
  ["rpc/manager_activity_revert_info", "RpcReason", "missing_note_context"],
  ["rpc/manager_activity_revert_info", "RpcReason", "missing_registration_context"],
  ["rpc/manager_activity_revert_info", "RpcReason", "missing_role_context"],
  ["rpc/manager_activity_revert_info", "RpcReason", "missing_status_context"],
  // PostgrestError
  ["rpc/postgrest", "PostgrestError", "21000"],
  ["rpc/postgrest", "PostgrestError", "40001"],
  ["rpc/postgrest", "PostgrestError", "40P01"],
  ["rpc/postgrest", "PostgrestError", "42601"],
  ["rpc/postgrest", "PostgrestError", "42702"],
  ["rpc/postgrest", "PostgrestError", "42703"],
  ["rpc/postgrest", "PostgrestError", "42725"],
  ["rpc/postgrest", "PostgrestError", "42804"],
  ["rpc/postgrest", "PostgrestError", "42846"],
  ["rpc/postgrest", "PostgrestError", "42883"],
  ["rpc/postgrest", "PostgrestError", "42P01"],
  ["rpc/postgrest", "PostgrestError", "42P02"],
  ["rpc/postgrest", "PostgrestError", "42P18"],
  ["rpc/postgrest", "PostgrestError", "53200"],
  ["rpc/postgrest", "PostgrestError", "53300"],
  ["rpc/postgrest", "PostgrestError", "54000"],
  ["rpc/postgrest", "PostgrestError", "55P03"],
  ["rpc/postgrest", "PostgrestError", "57014"],
  ["rpc/postgrest", "PostgrestError", "P0003"],
  ["rpc/postgrest", "PostgrestError", "P0004"],
  ["rpc/postgrest", "PostgrestError", "PGRST100"],
  ["rpc/postgrest", "PostgrestError", "PGRST102"],
  ["rpc/postgrest", "PostgrestError", "PGRST103"],
  ["rpc/postgrest", "PostgrestError", "PGRST106"],
  ["rpc/postgrest", "PostgrestError", "PGRST107"],
  ["rpc/postgrest", "PostgrestError", "PGRST111"],
  ["rpc/postgrest", "PostgrestError", "PGRST200"],
  ["rpc/postgrest", "PostgrestError", "PGRST201"],
  ["rpc/postgrest", "PostgrestError", "PGRST202"],
  ["rpc/postgrest", "PostgrestError", "PGRST203"],
  ["rpc/postgrest", "PostgrestError", "PGRST204"],
  ["rpc/postgrest", "PostgrestError", "XX000"],
  // HttpError
  ["transport/infra", "HttpError", "http_502"],
  ["transport/infra", "HttpError", "http_503"],
  ["transport/infra", "HttpError", "http_504"],
  ["transport/server", "HttpError", "http_500"],];

const KEYS = new Set(SERVER_ALLOWLIST.map((t) => `${t[0]}|${t[1]}|${t[2]}`));

export function isAllowlisted(operation: string, errorClass: string, errorCode: string): boolean {
  return KEYS.has(`${operation}|${errorClass}|${errorCode}`);
}
