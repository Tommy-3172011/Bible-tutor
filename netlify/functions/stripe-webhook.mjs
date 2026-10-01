import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/stripe-webhook" };

function verify(raw, header, secret) {
  let t = "";
  const sigs = [];
  for (const p of (header || "").split(",")) {
    const [k, v] = p.split("=");
    if (k === "t") t = v;
    if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some(s => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export default async (req) => {
  if (req.method !== "POST") return new Response("no", { status: 405 });
  const raw = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !verify(raw, req.headers.get("stripe-signature"), secret)) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(raw);
  const obj = event.data.object;
  const subs = getStore("subs"), customers = getStore("customers");

  if (event.type === "checkout.session.completed") {
    const uid = obj.client_reference_id;
    if (uid && obj.mode === "subscription") {
      await subs.set(uid, "active");
      if (obj.customer) await customers.set(obj.customer, uid);
    }
  } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const uid = await customers.get(obj.customer);
    if (uid) {
      const ok = event.type !== "customer.subscription.deleted" && ["trialing", "active"].includes(obj.status);
      if (ok) await subs.set(uid, obj.status); else await subs.delete(uid);
    }
  }
  return new Response("ok");
};
