import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

    const checkoutUrl = process.env.LEMON_SQUEEZY_CHECKOUT_URL;
    if (!checkoutUrl) {
      return { sessionId, checkoutUrl: null, demo: true };
    }

    const url = new URL(checkoutUrl);
    url.searchParams.set("checkout[custom][session_id]", sessionId);
    url.searchParams.set("checkout[email]", data.email);
    url.searchParams.set("embed", "1");

    return { sessionId, checkoutUrl: url.toString(), demo: false };
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
