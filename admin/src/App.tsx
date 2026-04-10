import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";

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
      <div style={{ maxWidth: 360, margin: "80px auto", padding: 24 }}>
        <h1>Shira Fit Admin</h1>
        <form onSubmit={login}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%", marginBottom: 8, padding: 8 }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%", marginBottom: 8, padding: 8 }} />
          <button type="submit">Sign in</button>
        </form>
        <p style={{ color: "#666", marginTop: 16 }}>Managers & coaches only.</p>
      </div>
    );

  if (profile?.role === "athlete")
    return <div style={{ padding: 24 }}>Athletes use the mobile app.</div>;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
        <strong>Shira Fit</strong>
        <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        {(["sessions", "approve", "history", "cancellations"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} style={{ fontWeight: tab === t ? 700 : 400 }}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "sessions" && <SessionsPanel isManager={profile?.role === "manager"} />}
      {tab === "approve" && profile?.role === "manager" && <ApprovePanel />}
      {tab === "approve" && profile?.role !== "manager" && <p>Managers only.</p>}
      {tab === "history" && <HistoryPanel />}
      {tab === "cancellations" && <CancellationsPanel />}
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
      <h2>Sessions</h2>
      {isManager && (
        <div style={{ marginBottom: 24, padding: 16, background: "#f0fdf4", borderRadius: 8 }}>
          <h3>Create</h3>
          <input placeholder="YYYY-MM-DD" value={date} onChange={(e) => setDate(e.target.value)} />
          <input placeholder="Coach user UUID" value={coachId} onChange={(e) => setCoachId(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ marginTop: 8 }} />
          <input placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)} style={{ width: 60, marginLeft: 8 }} />
          <button type="button" onClick={createSession} style={{ marginLeft: 8 }}>Add</button>
        </div>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {rows.map((r) => (
          <li key={r.id} style={{ padding: 12, borderBottom: "1px solid #eee" }}>
            {r.session_date} {r.start_time} — max {r.max_participants} — {r.is_open_for_registration ? "OPEN" : "closed"}
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
      <h2>Pending athletes</h2>
      {rows.map((r) => (
        <div key={r.user_id} style={{ padding: 12, border: "1px solid #fde68a", marginBottom: 8, borderRadius: 8 }}>
          <div>{r.full_name} ({r.username})</div>
          <button type="button" onClick={() => approve(r.user_id)}>Approve</button>
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
      <h2>Registration history</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>When</th><th>Event</th><th>Session</th><th>User</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td>{r.event_at}</td><td>{r.event_type}</td><td>{r.session_id?.slice(0, 8)}…</td><td>{r.user_id?.slice(0, 8)}…</td></tr>
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
      <h2>Cancellations</h2>
      <table style={{ width: "100%" }}>
        <thead><tr><th>When</th><th>Charged</th><th>Reason</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td>{r.cancelled_at}</td><td>{r.charged_full_price ? "Yes" : "No"}</td><td>{r.reason}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
