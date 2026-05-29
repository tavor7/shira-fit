/**
 * Run on a frequent schedule (e.g. every 15 minutes) via Supabase Cron.
 *
 * Delegates to SQL `open_next_week_sessions_if_due_core` (Asia/Jerusalem studio timezone).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!secret)
    return new Response(JSON.stringify({ error: "missing_cron_secret" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  if (auth !== secret)
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, key);

  const { data, error } = await supabase.rpc("open_next_week_sessions_if_due_core");
  if (error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  return new Response(JSON.stringify(data ?? { ok: false }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
