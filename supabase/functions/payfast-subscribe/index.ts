/**
 * Supabase Edge Function: payfast-subscribe
 *
 * Generates signed PayFast form payloads for:
 * - Once-off payments (website change requests)
 * - Subscription payments (monthly maintenance retainers)
 *
 * SETUP:
 * 1. Set secrets in Supabase Dashboard > Edge Functions > Secrets:
 *    - PAYFAST_MERCHANT_ID
 *    - PAYFAST_MERCHANT_KEY
 *    - PAYFAST_PASSPHRASE
 *
 * 2. Deploy: supabase functions deploy payfast-subscribe --no-verify-jwt
 *
 * 3. Update URLs in subscribe.html for live vs sandbox.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

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

function pfEncode(val: string): string {
  return encodeURIComponent(val).replace(/%20/g, "+");
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
    const body = await req.json();
    const { type, plan, amount, months, firstName, lastName, email, description } = body;

    if (!type || !plan || !amount || !firstName || !lastName || !email) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const merchantId = Deno.env.get("PAYFAST_MERCHANT_ID");
    const merchantKey = Deno.env.get("PAYFAST_MERCHANT_KEY");
    const passphrase = Deno.env.get("PAYFAST_PASSPHRASE");

    if (!merchantId || !merchantKey || !passphrase) {
      console.error("Missing PayFast environment variables");
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const paymentId = `DALU-${plan.toUpperCase()}-${Date.now()}`;
    const itemName = type === "onceoff"
      ? `Website Change - ${plan}`
      : `Monthly Support - ${plan}`;
    const itemDesc = description
      ? `${itemName}: ${description.substring(0, 200)}`
      : itemName;

    // Build PayFast data in required field order
    const data: Record<string, string> = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: "https://daludigital.co.za/subscribe.html?status=success",
      cancel_url: "https://daludigital.co.za/subscribe.html?status=cancelled",
      notify_url: `https://daludigital.co.za/supabase/functions/v1/payfast-notify`,
      name_first: firstName,
      name_last: lastName,
      email_address: email,
      m_payment_id: paymentId,
      amount: Number(amount).toFixed(2),
      item_name: itemName,
      item_description: itemDesc,
    };

    // Add subscription fields if it's a recurring payment
    if (type === "subscription") {
      data.subscription_type = "1";
      data.recurring_amount = Number(amount).toFixed(2);
      data.frequency = "3"; // monthly
      data.cycles = months === 0 ? "0" : String(months); // 0 = indefinite
    }

    // Remove empty values
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== "" && value !== undefined) {
        filtered[key] = value;
      }
    }

    // Build signature string
    const paramString = Object.entries(filtered)
      .map(([key, val]) => `${key}=${pfEncode(val.trim())}`)
      .join("&");

    const signatureString = `${paramString}&passphrase=${pfEncode(passphrase.trim())}`;
    const signature = await md5(signatureString);

    return new Response(
      JSON.stringify({ ...filtered, signature }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
