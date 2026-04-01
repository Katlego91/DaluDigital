/**
 * Supabase Edge Function: verify-code
 *
 * Verifies a 6-digit code and returns subscription data if valid.
 * This keeps sensitive data behind server-side verification instead of
 * exposing it via anon-key Supabase queries.
 *
 * Deploy: supabase functions deploy verify-code --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { email, code } = await req.json();

    if (!email || !code) {
      return new Response(JSON.stringify({ error: "Email and code are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Find the matching, unused, non-expired code
    const { data: codeRecord, error: codeError } = await supabase
      .from("verification_codes")
      .select("*")
      .eq("email", normalizedEmail)
      .eq("code", code.trim())
      .eq("used", false)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (codeError || !codeRecord) {
      // Check if code exists but expired
      const { data: expiredCode } = await supabase
        .from("verification_codes")
        .select("id")
        .eq("email", normalizedEmail)
        .eq("code", code.trim())
        .eq("used", false)
        .lt("expires_at", new Date().toISOString())
        .limit(1)
        .single();

      if (expiredCode) {
        return new Response(
          JSON.stringify({ error: "Code has expired. Please request a new one." }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      return new Response(
        JSON.stringify({ error: "Invalid code. Please check and try again." }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Mark code as used
    await supabase
      .from("verification_codes")
      .update({ used: true })
      .eq("id", codeRecord.id);

    // Fetch subscriptions for this email
    const { data: subs, error: subError } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("email", normalizedEmail)
      .order("created_at", { ascending: false });

    if (subError || !subs) {
      return new Response(JSON.stringify({ error: "Could not fetch subscriptions" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch payments for these subscriptions
    let payments: any[] = [];
    if (subs.length > 0) {
      const subIds = subs.map((s) => s.id);
      const { data: paymentData } = await supabase
        .from("payments")
        .select("*")
        .in("subscription_id", subIds)
        .order("created_at", { ascending: false });

      payments = paymentData || [];
    }

    // Generate a short-lived session token (valid for 30 minutes)
    // This allows the client to perform actions like cancellation without re-verifying
    const sessionToken = crypto.randomUUID();
    const sessionExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await supabase.from("verification_codes").insert({
      email: normalizedEmail,
      code: sessionToken,
      expires_at: sessionExpires,
      used: false,
    });

    return new Response(
      JSON.stringify({
        success: true,
        sessionToken: sessionToken,
        subscriptions: subs,
        payments: payments,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Verify error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
