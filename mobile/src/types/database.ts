export type UserRole = "athlete" | "coach" | "manager";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Profile {
  user_id: string;
  username: string;
  full_name: string;
  phone: string;
  age: number | null;
  gender: "male" | "female";
  date_of_birth?: string | null;
  health_declaration_confirmed_at?: string | null;
  approval_status: ApprovalStatus;
  role: UserRole;
  expo_push_token: string | null;
  created_at: string;
  /** #RRGGBB; managers set for coaches/managers for calendar chips */
  calendar_color?: string | null;
}

export type ManualParticipant = {
  id: string;
  full_name: string;
  phone: string;
  gender?: string | null;
  date_of_birth?: string | null;
  notes?: string | null;
  linked_user_id?: string | null;
};

export interface TrainingSession {
  id: string;
  session_date: string;
  start_time: string;
  coach_id: string;
  duration_minutes: number;
  max_participants: number;
  is_open_for_registration: boolean;
  /** Staff-only listing; athletes browse only non-hidden open sessions (RLS). */
  is_hidden?: boolean;
}

/** Row from `training_sessions` with embedded coach profile (see `trainer:profiles!coach_id`). */
export type TrainingSessionWithTrainer = TrainingSession & {
  trainer: { full_name: string; calendar_color?: string | null } | null;
};

export interface SessionRegistration {
  id: string;
  session_id: string;
  user_id: string;
  registered_at: string;
  status: "active" | "cancelled";
  /** null = not recorded; true = arrived; false = absent */
  attended?: boolean | null;
}

/** Row from RPC `participant_registration_history`. */
export type ParticipantHistoryRow = {
  registration_id: string;
  athlete_user_id: string;
  athlete_name: string;
  athlete_phone: string;
  session_id: string;
  session_date: string;
  start_time: string;
  duration_minutes: number;
  /** Session capacity (max participants); relevant for per-session pricing tiers. */
  max_participants?: number;
  reg_status: "active" | "cancelled";
  registered_at: string;
  /** null = not recorded; true = arrived; false = absent */
  attended?: boolean | null;
  /** Payment method when marked arrived (staff workflow). */
  payment_method?: string | null;
  /** Optional amount recorded with payment (same workflow). */
  amount_paid?: number | string | null;
  /** From `cancellations.reason` when the athlete self-cancelled. */
  cancellation_reason?: string | null;
  /** True when cancellation was within 24h of session start (charge policy / `charged_full_price`). */
  cancellation_within_24h?: boolean | null;
  /** True when cancellation was within 12h of session start (UI / report filter). */
  cancellation_within_12h?: boolean | null;
  cancelled_at?: string | null;
};

/** Row from RPC `manager_coach_sessions_report`. */
export type ManagerCoachSessionReportRow = {
  session_id: string;
  session_date: string;
  start_time: string;
  duration_minutes: number;
  registered_count: number;
  arrived_count: number;
  /** Self-cancels recorded with full charge (within 24h of session start). */
  late_cancellations_within_24h?: number;
};
