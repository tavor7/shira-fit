/**
 * Optional HTTP-triggerable path to the daily subscription billing job (ops convenience /
 * external monitoring). The actual pg_cron schedule calls the SQL function
 * `generate_due_subscription_charges()` directly (see
 * 20260924140000_subscriptions_billing_engine.sql) — this Edge Function is not on that critical
 * path, but exists so the same job can be triggered/observed over HTTP, mirroring
 * open-weekly-registrations' exact CRON_SECRET-authenticated pattern.
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

  const { data, error } = await supabase.rpc("generate_due_subscription_charges");
  if (error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  return new Response(JSON.stringify(data ?? { ok: false }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
