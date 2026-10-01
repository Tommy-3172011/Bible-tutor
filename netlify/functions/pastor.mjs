import { getStore } from "@netlify/blobs";
import { createRemoteJWKSet, jwtVerify } from "jose";

// ===== Settings you can change =====
const DAILY_MESSAGES = 30;           // pastor messages per subscriber per day
const SAME_NETWORK_MULTIPLIER = 6;   // safety cap per internet connection
const MODELS = ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"];
// ===================================

const SYS = `You are a warm, gentle Christian pastor-style companion inside a Bible app. You are an AI. Never claim to be human or an ordained minister, and if someone asks, say plainly that you are an AI.
Speak calmly and kindly, in short natural paragraphs, as if talking out loud. No lists, no markdown, no emojis. Listen first, reflect back what the person shares, and ask at most one gentle question at a time.
Use Scripture sparingly and accurately. Name the reference and never invent a verse. When the person asks, or when it fits, offer to pray, and then write a short, heartfelt prayer.
Be non-judgmental. Do not push a denomination. Do not claim to speak for God or promise specific outcomes.
You are not a doctor, lawyer or licensed counselor. For medical, legal or mental health matters, give caring general support and encourage seeing a professional or a trusted person.
If someone mentions suicide, self-harm, abuse or being in danger, respond with warmth, take it seriously, and urge them to contact emergency services or a crisis line right now (for example 988 in the US, Lifeline 13 11 14 in Australia, Samaritans 116 123 in the UK and Ireland, or their local emergency number) and to reach out to someone they trust nearby. Always include that guidance.
You may talk about everyday topics too, but stay kind and wise, and decline anything harmful or illegal.
Keep replies under 120 words unless you are praying or the person asks for more.`;

export const config = { path: "/api/pastor" };

const PID = process.env.FIREBASE_PROJECT_ID;
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
async function uidFrom(req) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!t || !PID) return null;
  try { const { payload } = await jwtVerify(t, JWKS, { issuer: `https://securetoken.google.com/${PID}`, audience: PID }); return payload.sub; }
  catch { return null; }
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const today = () => new Date().toISOString().slice(0, 10);

async function useQuota(uid, ip, limit) {
  const store = getStore("usage"), day = today();
  const rules = [[`pastor-${day}-v-${uid}`, limit], [`pastor-${day}-ip-${ip}`, limit * SAME_NETWORK_MULTIPLIER]];
  const counts = [];
  for (const [k, max] of rules) {
    const n = parseInt((await store.get(k)) || "0", 10);
    if (n >= max) return { ok: false };
    counts.push([k, n]);
  }
  for (const [k, n] of counts) await store.set(k, String(n + 1));
  return { ok: true, remaining: limit - (counts[0][1] + 1) };
}

async function ai(messages) {
  const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  let last = 0;
  for (const model of MODELS) {
    for (const think of [true, false]) {
      const generationConfig = { maxOutputTokens: 500, temperature: 0.7 };
      if (think) generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS }] }, contents, generationConfig }),
      });
      if (r.ok) {
        const d = await r.json();
        return (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
      }
      last = r.status;
      if (r.status === 429) throw new Error("busy");
      if (r.status === 404) break;
    }
  }
  throw new Error("ai " + last);
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ message: "Not allowed" }, 405);
  if (!process.env.GEMINI_API_KEY) return json({ message: "The server is missing its AI key." }, 500);
  let body; try { body = await req.json(); } catch { return json({ message: "Bad request" }, 400); }

  const uid = await uidFrom(req);
  if (!uid) return json({ message: "Please log in first." }, 401);
  if (!(await getStore("subs").get(uid))) return json({ message: "Start your free trial to continue.", code: "subscribe" }, 402);

  const message = String(body.message || "").trim().slice(0, 800);
  if (!message) return json({ message: "Type a message first." }, 400);

  try {
    const quota = await useQuota(uid, context.ip || "unknown", DAILY_MESSAGES);
    if (!quota.ok) return json({ message: `You've used your ${DAILY_MESSAGES} pastor messages for today. They reset tomorrow.` }, 429);

    let h = (Array.isArray(body.history) ? body.history : []).slice(-12)
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 1200) }));
    while (h.length && h[0].role !== "user") h.shift();
    const msgs = [];
    for (const m of h) if (!msgs.length || msgs[msgs.length - 1].role !== m.role) msgs.push(m);
    if (msgs.length && msgs[msgs.length - 1].role === "user") msgs.pop();
    msgs.push({ role: "user", content: message });

    const text = await ai(msgs);
    return json({ text: text || "I'm here with you. Could you say that another way?", remaining: quota.remaining });
  } catch (e) {
    console.error(e);
    if (e.message === "busy") return json({ message: "Lots of people are asking right now. Try again in a minute." }, 503);
    return json({ message: "Something went wrong. Please try again." }, 500);
  }
};
