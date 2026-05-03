import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";

/** Aligns with mobile app naming (English-only admin surface). */
const TAB_LABELS = {
  sessions: "Sessions",
  approve: "Approve athletes",
  history: "Registration history",
  cancellations: "Cancellations",
} as const;

const chrome = {
  bg: "#0a0a0b",
  surface: "#121214",
  border: "#25252c",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  cta: "#f4f4f5",
  ctaText: "#0a0a0b",
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [profile, setProfile] = useState<{ role: string; approval_status: string } | null>(null);
  const [tab, setTab] = useState<"sessions" | "approve" | "history" | "cancellations">("sessions");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user)
        supabase
          .from("profiles")
          .select("role, approval_status")
          .eq("user_id", data.session.user.id)
          .single()
          .then(({ data: p }) => setProfile(p as any));
    });
    supabase.auth.onAuthStateChange((_e, s) => setSession(s));
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    await supabase.auth.signInWithPassword({ email, password });
    const { data: u } = await supabase.auth.getUser();
    if (u.user) {
      const { data: p } = await supabase.from("profiles").select("role").eq("user_id", u.user.id).single();
      setProfile(p as any);
    }
  }

  if (!session)
    return (
      <div
        style={{
          minHeight: "100vh",
          background: chrome.bg,
          color: chrome.text,
          fontFamily: "system-ui, sans-serif",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 400, margin: "64px auto" }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 8px", letterSpacing: 0.2 }}>Shira Fit</h1>
          <p style={{ color: chrome.muted, margin: "0 0 24px", fontSize: 14 }}>Staff web console</p>
          <form
            onSubmit={login}
            style={{
              background: chrome.surface,
              border: `1px solid ${chrome.border}`,
              borderRadius: 14,
              padding: 20,
            }}
          >
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: chrome.muted, marginBottom: 6 }}>Email</label>
            <input
              type="email"
              placeholder="you@studio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                width: "100%",
                marginBottom: 14,
                padding: "12px 14px",
                borderRadius: 10,
                border: `1px solid ${chrome.border}`,
                background: chrome.bg,
                color: chrome.text,
                boxSizing: "border-box",
              }}
            />
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: chrome.muted, marginBottom: 6 }}>Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%",
                marginBottom: 18,
                padding: "12px 14px",
                borderRadius: 10,
                border: `1px solid ${chrome.border}`,
                background: chrome.bg,
                color: chrome.text,
                boxSizing: "border-box",
              }}
            />
            <button
              type="submit"
              style={{
                width: "100%",
                padding: "14px 16px",
                borderRadius: 10,
                border: "none",
                background: chrome.cta,
                color: chrome.ctaText,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Sign in
            </button>
          </form>
          <p style={{ color: chrome.muted, marginTop: 20, fontSize: 13, lineHeight: 1.5 }}>Managers and coaches only. Athletes use the mobile app.</p>
        </div>
      </div>
    );

  if (profile?.role === "athlete")
    return (
      <div style={{ minHeight: "100vh", background: chrome.bg, color: chrome.text, padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p style={{ maxWidth: 480, lineHeight: 1.5 }}>Athletes use the Shira Fit mobile app.</p>
      </div>
    );

  return (
    <div style={{ minHeight: "100vh", background: chrome.bg, color: chrome.text, fontFamily: "system-ui, sans-serif" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 24px",
          borderBottom: `1px solid ${chrome.border}`,
          background: chrome.surface,
        }}
      >
        <strong style={{ fontSize: 16, letterSpacing: 0.2 }}>Shira Fit</strong>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: `1px solid ${chrome.border}`,
            background: "transparent",
            color: chrome.muted,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </header>
      <nav
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          padding: "12px 24px",
          borderBottom: `1px solid ${chrome.border}`,
          background: chrome.bg,
        }}
        aria-label="Main"
      >
        {(["sessions", "approve", "history", "cancellations"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              fontWeight: tab === t ? 800 : 600,
              color: tab === t ? chrome.text : chrome.muted,
              background: tab === t ? chrome.surface : "transparent",
              border: `1px solid ${tab === t ? chrome.border : "transparent"}`,
              borderRadius: 999,
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        {tab === "sessions" && <SessionsPanel isManager={profile?.role === "manager"} />}
        {tab === "approve" && profile?.role === "manager" && <ApprovePanel />}
        {tab === "approve" && profile?.role !== "manager" && <p style={{ color: chrome.muted }}>This area is for managers only.</p>}
        {tab === "history" && <HistoryPanel />}
        {tab === "cancellations" && <CancellationsPanel />}
      </main>
    </div>
  );
}

function SessionsPanel({ isManager }: { isManager: boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("18:00");
  const [coachId, setCoachId] = useState("");
  const [max, setMax] = useState("12");

  async function load() {
    const { data } = await supabase.from("training_sessions").select("*").order("session_date");
    setRows(data ?? []);
  }
  useEffect(() => { load(); }, []);

  async function createSession() {
    if (!isManager) return;
    await supabase.from("training_sessions").insert({
      session_date: date,
      start_time: time,
      coach_id: coachId,
      max_participants: parseInt(max, 10) || 1,
      is_open_for_registration: false,
    });
    load();
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, marginTop: 0 }}>Sessions</h2>
      {isManager && (
        <div
          style={{
            marginBottom: 24,
            padding: 16,
            background: chrome.surface,
            border: `1px solid ${chrome.border}`,
            borderRadius: 12,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 800, color: chrome.muted, marginTop: 0 }}>Create session</h3>
          <input
            placeholder="YYYY-MM-DD"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              padding: 10,
              borderRadius: 8,
              border: `1px solid ${chrome.border}`,
              background: chrome.bg,
              color: chrome.text,
            }}
          />
          <input
            placeholder="Coach user UUID"
            value={coachId}
            onChange={(e) => setCoachId(e.target.value)}
            style={{ width: "100%", marginTop: 8, padding: 10, borderRadius: 8, border: `1px solid ${chrome.border}`, background: chrome.bg, color: chrome.text, boxSizing: "border-box" }}
          />
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            style={{ marginTop: 8, padding: 10, borderRadius: 8, border: `1px solid ${chrome.border}`, background: chrome.bg, color: chrome.text }}
          />
          <input
            placeholder="Max"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            style={{ width: 80, marginLeft: 8, padding: 10, borderRadius: 8, border: `1px solid ${chrome.border}`, background: chrome.bg, color: chrome.text }}
          />
          <button
            type="button"
            onClick={createSession}
            style={{
              marginLeft: 8,
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              background: chrome.cta,
              color: chrome.ctaText,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </div>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {rows.map((r) => (
          <li
            key={r.id}
            style={{
              padding: 12,
              borderBottom: `1px solid ${chrome.border}`,
              color: chrome.muted,
            }}
          >
            {r.session_date} {r.start_time} — max {r.max_participants} — {r.is_open_for_registration ? "Open" : "Closed"}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovePanel() {
  const [rows, setRows] = useState<any[]>([]);
  async function load() {
    const { data } = await supabase.from("profiles").select("*").eq("role", "athlete").eq("approval_status", "pending");
    setRows(data ?? []);
  }
  useEffect(() => { load(); }, []);

  async function approve(uid: string) {
    await supabase.rpc("set_athlete_approval", { p_user_id: uid, p_status: "approved" });
    load();
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, marginTop: 0 }}>Pending athletes</h2>
      {rows.map((r) => (
        <div
          key={r.user_id}
          style={{
            padding: 12,
            border: `1px solid ${chrome.border}`,
            marginBottom: 8,
            borderRadius: 10,
            background: chrome.surface,
          }}
        >
          <div style={{ marginBottom: 8 }}>
            {r.full_name} ({r.username})
          </div>
          <button
            type="button"
            onClick={() => approve(r.user_id)}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: chrome.cta,
              color: chrome.ctaText,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Approve
          </button>
        </div>
      ))}
    </div>
  );
}

function HistoryPanel() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    supabase.from("registration_history").select("*").order("event_at", { ascending: false }).limit(100).then(({ data }) => setRows(data ?? []));
  }, []);
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, marginTop: 0 }}>Registration history</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, color: chrome.muted }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${chrome.border}` }}>
            <th style={{ padding: "8px 4px" }}>When</th>
            <th style={{ padding: "8px 4px" }}>Event</th>
            <th style={{ padding: "8px 4px" }}>Session</th>
            <th style={{ padding: "8px 4px" }}>User</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: `1px solid ${chrome.border}` }}>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.event_at}</td>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.event_type}</td>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.session_id?.slice(0, 8)}…</td>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.user_id?.slice(0, 8)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CancellationsPanel() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    supabase.from("cancellations").select("*").order("cancelled_at", { ascending: false }).limit(100).then(({ data }) => setRows(data ?? []));
  }, []);
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, marginTop: 0 }}>Cancellations</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, color: chrome.muted }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${chrome.border}` }}>
            <th style={{ padding: "8px 4px" }}>When</th>
            <th style={{ padding: "8px 4px" }}>Charged</th>
            <th style={{ padding: "8px 4px" }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: `1px solid ${chrome.border}` }}>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.cancelled_at}</td>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.charged_full_price ? "Yes" : "No"}</td>
              <td style={{ padding: "8px 4px", verticalAlign: "top" }}>{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
