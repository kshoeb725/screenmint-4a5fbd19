import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function buildCheckoutUrl(rawValue: string, sessionId: string, email: string) {
  const trimmed = rawValue.trim();
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(normalized);

  if (!url.hostname.endsWith(".lemonsqueezy.com") || !url.pathname.includes("/checkout")) {
    throw new Error(
      "LEMON_SQUEEZY_CHECKOUT_URL must be a full Lemon Squeezy checkout link from your product checkout page.",
    );
  }

  url.searchParams.set("checkout[custom][session_id]", sessionId);
  url.searchParams.set("checkout[email]", email);
  return url;
}

export const initPaymentSession = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ email: z.string().email() }).parse(input),
  )
  .handler(async ({ data }) => {
    const sessionId = crypto.randomUUID();

    await supabaseAdmin.from("payments").insert({
      session_id: sessionId,
      status: "pending",
      customer_email: data.email,
    });

    const checkoutUrlRaw = process.env.LEMON_SQUEEZY_CHECKOUT_URL?.trim();
    if (!checkoutUrlRaw) {
      return { sessionId, checkoutUrl: null, demo: true, setupError: null };
    }

    try {
      const url = buildCheckoutUrl(checkoutUrlRaw, sessionId, data.email);
      return { sessionId, checkoutUrl: url.toString(), demo: false, setupError: null };
    } catch (e) {
      console.error("Invalid Lemon Squeezy checkout URL:", e);
      return {
        sessionId,
        checkoutUrl: null,
        demo: false,
        setupError:
          e instanceof Error
            ? e.message
            : "LEMON_SQUEEZY_CHECKOUT_URL is not a valid Lemon Squeezy checkout URL.",
      };
    }
  });

export const getPaymentStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ sessionId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("status, lemon_squeezy_order_id")
      .eq("session_id", data.sessionId)
      .single();

    return { status: (payment?.status as string) ?? "pending" };
  });
