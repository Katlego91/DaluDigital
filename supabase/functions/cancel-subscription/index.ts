/**
 * Supabase Edge Function: cancel-subscription
 *
 * Cancels a subscription, updates the database, optionally cancels on PayFast,
 * and sends a confirmation email via Resend.
 *
 * Deploy: supabase functions deploy cancel-subscription --no-verify-jwt
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

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    const { subscriptionId, email, reason, sessionToken } = await req.json();

    if (!subscriptionId || !email) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Verify the session token (proves the user verified their email)
    if (sessionToken) {
      const { data: tokenRecord } = await supabase
        .from("verification_codes")
        .select("*")
        .eq("email", email.toLowerCase().trim())
        .eq("code", sessionToken)
        .eq("used", false)
        .gte("expires_at", new Date().toISOString())
        .limit(1)
        .single();

      if (!tokenRecord) {
        return new Response(JSON.stringify({ error: "Session expired. Please verify your email again." }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Mark session token as used
      await supabase
        .from("verification_codes")
        .update({ used: true })
        .eq("id", tokenRecord.id);
    }

    // Find the subscription and verify email matches
    const { data: sub, error: findError } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("id", subscriptionId)
      .eq("email", email.toLowerCase().trim())
      .eq("status", "active")
      .single();

    if (findError || !sub) {
      return new Response(JSON.stringify({ error: "Subscription not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cancel on PayFast if there's a subscription token AND PayFast is configured
    const PAYFAST_MERCHANT_ID = Deno.env.get("PAYFAST_MERCHANT_ID");
    const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE");

    if (sub.payfast_token && sub.payment_type === "subscription" && PAYFAST_MERCHANT_ID && PAYFAST_PASSPHRASE) {
      try {
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "+02:00");
        const apiUrl = `https://api.payfast.co.za/subscriptions/${sub.payfast_token}/cancel`;

        const headerParams = `merchant-id=${PAYFAST_MERCHANT_ID}&passphrase=${PAYFAST_PASSPHRASE}&timestamp=${timestamp}&version=v1`;
        const signature = await md5(headerParams);

        const pfResponse = await fetch(apiUrl, {
          method: "PUT",
          headers: {
            "merchant-id": PAYFAST_MERCHANT_ID,
            version: "v1",
            timestamp: timestamp,
            signature: signature,
            "Content-Type": "application/json",
          },
        });

        if (!pfResponse.ok) {
          console.error("PayFast cancel failed:", await pfResponse.text());
        } else {
          console.log("PayFast subscription cancelled:", sub.payfast_token);
        }
      } catch (pfErr) {
        console.error("PayFast API error:", pfErr);
      }
    } else {
      console.log("No PayFast token or PayFast not configured — skipping PayFast API call");
    }

    // Update our database
    const cancelledAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("subscriptions")
      .update({
        status: "cancelled",
        cancelled_at: cancelledAt,
        cancel_reason: reason || null,
        next_payment_at: null,
      })
      .eq("id", subscriptionId);

    if (updateError) {
      console.error("DB update error:", updateError);
      return new Response(JSON.stringify({ error: "Failed to update subscription" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send cancellation confirmation email via Resend
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (resendApiKey) {
      const resend = new Resend(resendApiKey);
      const cancelDate = new Date(cancelledAt).toLocaleDateString("en-ZA", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });

      try {
        // Email to client
        await resend.emails.send({
          from: "Dalu Digital <onboarding@resend.dev>",
          to: [sub.email],
          replyTo: "mabunda.katlego@gmail.com",
          subject: "Your Dalu Digital Subscription Has Been Cancelled",
          html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px;">
              <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="color: #18132A; font-size: 22px; margin: 0;">Dalu Digital</h1>
              </div>

              <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                Hi ${sub.first_name},
              </p>
              <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                Your <strong style="color: #18132A;">${sub.plan_name}</strong> subscription has been successfully cancelled.
              </p>

              <div style="background: #FAF6F3; border: 1px solid #EBE5E0; border-radius: 12px; padding: 24px; margin: 24px 0;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #9B95A8;">Plan</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #18132A; font-weight: 600; text-align: right;">${sub.plan_name}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #9B95A8;">Amount</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #18132A; font-weight: 600; text-align: right;">R${sub.amount}/mo</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #9B95A8;">Cancelled on</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #18132A; font-weight: 600; text-align: right;">${cancelDate}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #9B95A8;">Payments made</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #18132A; font-weight: 600; text-align: right;">${sub.payments_made || 0}</td>
                  </tr>
                  ${reason ? `<tr><td style="padding: 6px 0; font-size: 13px; color: #9B95A8;">Reason</td><td style="padding: 6px 0; font-size: 14px; color: #18132A; text-align: right;">${reason}</td></tr>` : ""}
                </table>
              </div>

              <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                No further payments will be deducted from your account. If you ever need website changes in the future, you're always welcome to come back.
              </p>

              <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                If this was a mistake or you have any questions, simply reply to this email or WhatsApp us.
              </p>

              <hr style="border: none; border-top: 1px solid #EBE5E0; margin: 32px 0 16px;" />
              <p style="color: #9B95A8; font-size: 12px; text-align: center;">
                &copy; ${new Date().getFullYear()} Dalu Digital &middot; daludigital.co.za
              </p>
            </div>
          `,
        });
        console.log("Cancellation email sent to client:", sub.email);
      } catch (emailErr) {
        console.error("Failed to send client cancellation email:", emailErr);
      }

      try {
        // Notification to Dalu Digital owner
        await resend.emails.send({
          from: "Dalu Digital <onboarding@resend.dev>",
          to: ["mabunda.katlego@gmail.com"],
          subject: `Subscription Cancelled — ${sub.first_name} ${sub.last_name} (${sub.plan_name})`,
          html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px;">
              <h2 style="color: #DC2626; font-size: 18px; margin: 0 0 16px;">Subscription Cancelled</h2>
              <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                <strong>${sub.first_name} ${sub.last_name}</strong> (${sub.email}) has cancelled their <strong>${sub.plan_name}</strong> subscription (R${sub.amount}/mo).
              </p>
              <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                <strong>Reason:</strong> ${reason || "No reason provided"}<br>
                <strong>Payments made:</strong> ${sub.payments_made || 0}<br>
                <strong>Cancelled:</strong> ${cancelDate}
              </p>
            </div>
          `,
        });
        console.log("Cancellation notification sent to owner");
      } catch (emailErr) {
        console.error("Failed to send owner cancellation email:", emailErr);
      }
    }

    return new Response(
      JSON.stringify({ success: true, message: "Subscription cancelled successfully" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Cancel error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
