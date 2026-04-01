/**
 * Supabase Edge Function: send-verification-code
 *
 * Sends a 6-digit verification code to a client's email so they can
 * securely view their subscription details.
 *
 * Flow:
 * 1. Client enters email on subscribe.html
 * 2. This function checks if any subscription exists for that email
 * 3. If yes, generates a 6-digit code, stores it in verification_codes table, and emails it
 * 4. Client enters the code → frontend verifies via Supabase REST → shows subscription
 *
 * Deploy: supabase functions deploy send-verification-code --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function generateCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

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
    const { email } = await req.json();

    if (!email) {
      return new Response(JSON.stringify({ error: "Email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Check if any subscription exists for this email
    const { data: subs, error: subError } = await supabase
      .from("subscriptions")
      .select("id, first_name")
      .eq("email", normalizedEmail)
      .limit(1);

    if (subError || !subs || subs.length === 0) {
      // Don't reveal whether the email exists or not (security)
      // But return success so attackers can't enumerate emails
      return new Response(
        JSON.stringify({
          success: true,
          message: "If an account exists for this email, a verification code has been sent.",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const clientName = subs[0].first_name || "there";

    // 2. Rate limiting: check for recent codes (max 3 per hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentCodes } = await supabase
      .from("verification_codes")
      .select("id")
      .eq("email", normalizedEmail)
      .gte("created_at", oneHourAgo);

    if (recentCodes && recentCodes.length >= 3) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 3. Invalidate any existing unused codes for this email
    await supabase
      .from("verification_codes")
      .update({ used: true })
      .eq("email", normalizedEmail)
      .eq("used", false);

    // 4. Generate and store new code (expires in 10 minutes)
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from("verification_codes")
      .insert({
        email: normalizedEmail,
        code: code,
        expires_at: expiresAt,
        used: false,
      });

    if (insertError) {
      console.error("Error storing code:", insertError);
      return new Response(JSON.stringify({ error: "Server error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Send email with the code via Resend
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    console.log("Resend API key present:", !!resendApiKey);

    if (resendApiKey) {
      const resend = new Resend(resendApiKey);
      try {
        await resend.emails.send({
          from: "Dalu Digital <onboarding@resend.dev>",
          to: [normalizedEmail],
          replyTo: "mabunda.katlego@gmail.com",
          subject: "Your Dalu Digital Verification Code",
          html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
              <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="color: #18132A; font-size: 22px; margin: 0;">Dalu Digital</h1>
              </div>
              <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                Hi ${clientName},
              </p>
              <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                Here's your verification code to access your subscription details:
              </p>
              <div style="background: #FAF6F3; border: 2px solid #EBE5E0; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
                <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #7A1D3E;">${code}</span>
              </div>
              <p style="color: #9B95A8; font-size: 13px; line-height: 1.5;">
                This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.
              </p>
              <hr style="border: none; border-top: 1px solid #EBE5E0; margin: 32px 0 16px;" />
              <p style="color: #9B95A8; font-size: 12px; text-align: center;">
                &copy; ${new Date().getFullYear()} Dalu Digital &middot; daludigital.co.za
              </p>
            </div>
          `,
        });
        console.log("Verification code email sent to:", normalizedEmail);
      } catch (emailErr) {
        console.error("Failed to send verification email:", emailErr);
        // Don't fail the whole request — code is still in the DB
      }
    } else {
      // No email service configured — log the code for development/testing
      console.log(`VERIFICATION CODE for ${normalizedEmail}: ${code}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "If an account exists for this email, a verification code has been sent.",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Verification error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
