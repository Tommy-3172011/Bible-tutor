import { getStore } from "@netlify/blobs";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash } from "node:crypto";

// ===== Settings you can change =====
const DAILY_CLIPS = 40;              // natural-voice clips per subscriber per day (short clips, roughly 8 to 10 minutes of speech)
const SAME_NETWORK_MULTIPLIER = 4;   // safety cap per internet connection
const VOICE = "Algieba";             // other voices to try: Sulafat, Charon, Achird, Gacrux, Orus
const MODELS = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const MAX_CHARS = 900;               // longest piece of text per clip
// ===================================

export const config = { path: "/api/speak" };

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
  const rules = [[`voice-${day}-v-${uid}`, limit], [`voice-${day}-ip-${ip}`, limit * SAME_NETWORK_MULTIPLIER]];
  const counts = [];
  for (const [k, max] of rules) {
    const n = parseInt((await store.get(k)) || "0", 10);
    if (n >= max) return { ok: false };
    counts.push([k, n]);
  }
  for (const [k, n] of counts) await store.set(k, String(n + 1));
  return { ok: true };
}

async function tts(text) {
  const prompt = text;   // plain text only, so the voice never reads instructions aloud
  let last = 0;
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
      }),
    });
    if (r.ok) {
      const d = await r.json();
      const part = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
      if (part) return { audio: part.inlineData.data, mime: part.inlineData.mimeType || "" };
      last = 204; continue;
    }
    last = r.status;
    if (r.status === 429) throw new Error("busy");
  }
  throw new Error("tts " + last);
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ message: "Not allowed" }, 405);
  if (!process.env.GEMINI_API_KEY) return json({ message: "The voice isn't set up. Using your device voice." }, 500);
  let body; try { body = await req.json(); } catch { return json({ message: "Bad request" }, 400); }

  const uid = await uidFrom(req);
  if (!uid) return json({ message: "Please log in first." }, 401);
  if (!(await getStore("subs").get(uid))) return json({ message: "Start your free trial to continue.", code: "subscribe" }, 402);

  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!text) return json({ message: "Nothing to read." }, 400);

  try {
    // Clips we've already made are replayed instantly and don't count against the daily limit.
    const cache = getStore("voice-cache");
    const key = createHash("sha256").update(VOICE + "|" + text).digest("hex");
    const hit = await cache.get(key, { type: "json" });
    if (hit) return json(hit);

    const quota = await useQuota(uid, context.ip || "unknown", DAILY_CLIPS);
    if (!quota.ok) return json({ message: "You've used today's natural voice. Using your device voice instead." }, 429);
    const result = await tts(text);
    if (text.length <= 400) await cache.set(key, JSON.stringify(result));
    return json(result);
  } catch (e) {
    console.error(e);
    return json({ message: "The natural voice isn't available right now. Using your device voice instead." }, e.message === "busy" ? 503 : 500);
  }
};
