import { getStore } from "@netlify/blobs";

// ===== Settings you can change =====
const DAILY_FOLLOWUPS = 25;          // follow-up questions per person per day
const DAILY_NEW_EXPLANATIONS = 100;  // brand-new verse explanations per person per day (saved ones are free)
const SAME_NETWORK_MULTIPLIER = 6;   // safety cap per internet connection (shared wifi etc.)
// Gemini 3.1 Flash-Lite. If the first name is not found, the second is tried automatically.
const MODELS = ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"];
// ===================================

const BIBLE_URL = "https://raw.githubusercontent.com/midvash/bible-data/main/versions/en/kjv/kjv.json";
const NAMES = ["Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth","1 Samuel","2 Samuel","1 Kings","2 Kings","1 Chronicles","2 Chronicles","Ezra","Nehemiah","Esther","Job","Psalms","Proverbs","Ecclesiastes","Song of Solomon","Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel","Hosea","Joel","Amos","Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah","Haggai","Zechariah","Malachi","Matthew","Mark","Luke","John","Acts","Romans","1 Corinthians","2 Corinthians","Galatians","Ephesians","Philippians","Colossians","1 Thessalonians","2 Thessalonians","1 Timothy","2 Timothy","Titus","Philemon","Hebrews","James","1 Peter","2 Peter","1 John","2 John","3 John","Jude","Revelation"];
const SYS = "You are a kind Bible teacher. Use short, simple words a teenager would understand. Be accurate and never invent facts; if you are not sure, say so. Only talk about the verse below and the Bible; politely steer other topics back to it. Keep every answer under 90 words.";

export const config = { path: "/api/ask" };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const today = () => new Date().toISOString().slice(0, 10);

let bible = null;
async function getBible() {
  if (!bible) { const r = await fetch(BIBLE_URL); if (!r.ok) throw new Error("bible"); bible = await r.json(); }
  return bible;
}

async function useQuota(kind, vid, ip, limit) {
  const store = getStore("usage"), day = today();
  const rules = [[`${kind}-${day}-v-${vid}`, limit], [`${kind}-${day}-ip-${ip}`, limit * SAME_NETWORK_MULTIPLIER]];
  const counts = [];
  for (const [k, max] of rules) {
    const n = parseInt((await store.get(k)) || "0", 10);
    if (n >= max) return { ok: false };
    counts.push([k, n]);
  }
  for (const [k, n] of counts) await store.set(k, String(n + 1));
  return { ok: true, remaining: limit - (counts[0][1] + 1) };
}

async function ai(system, messages) {
  const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  let last = 0;
  for (const model of MODELS) {
    for (const think of [true, false]) {
      const generationConfig = { maxOutputTokens: 400, temperature: 0.5 };
      if (think) generationConfig.thinkingConfig = { thinkingLevel: "minimal" }; // keeps it fast and cheap
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
      });
      if (r.ok) {
        const d = await r.json();
        return (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
      }
      last = r.status;
      if (r.status === 429) throw new Error("busy");
      if (r.status === 404) break;   // try the next model name
    }
  }
  throw new Error("ai " + last);
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ message: "Not allowed" }, 405);
  if (!process.env.GEMINI_API_KEY) return json({ message: "The server is missing its AI key." }, 500);
  let body; try { body = await req.json(); } catch { return json({ message: "Bad request" }, 400); }

  const b = +body.b, c = +body.c, v = +body.v;
  if (![b, c, v].every(Number.isInteger) || b < 0 || b > 65 || c < 0 || c > 149 || v < 1 || v > 176) return json({ message: "Bad verse" }, 400);
  const vid = String(body.vid || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "none";
  const ip = context.ip || "unknown";
  const key = `${b}-${c}-${v}`;
  const saved = getStore("explanations");

  try {
    if (body.action === "explain") {
      const hit = await saved.get(key);
      if (hit) return json({ text: hit });
    } else if (body.action === "ask") {
      const q = String(body.question || "").trim().slice(0, 300);
      if (!q) return json({ message: "Type a question first." }, 400);
    } else return json({ message: "Bad request" }, 400);

    const bib = await getBible();
    const chap = bib.books?.[b]?.chapters?.[c]?.verses;
    const text = chap?.[v - 1]?.text;
    if (!text) return json({ message: "Verse not found" }, 404);
    const ref = `${NAMES[b]} ${c + 1}:${v}`;
    const system = `${SYS}\n\nThe verse being discussed is ${ref}: "${text}"\n` +
      (chap[v - 2] ? `The verse before it: "${chap[v - 2].text}"\n` : "") + (chap[v] ? `The verse after it: "${chap[v].text}"\n` : "");

    if (body.action === "explain") {
      const quota = await useQuota("new", vid, ip, DAILY_NEW_EXPLANATIONS);
      if (!quota.ok) return json({ message: "You've reached today's limit for new verses. Try again tomorrow." }, 429);
      const answer = await ai(system, [{ role: "user", content: "Explain this verse in exactly this format:\n\nMeaning: (1 or 2 short sentences)\n\nExample: (one short everyday example)" }]);
      if (answer) await saved.set(key, answer);
      return json({ text: answer });
    }

    const quota = await useQuota("ask", vid, ip, DAILY_FOLLOWUPS);
    if (!quota.ok) return json({ message: `You've used your ${DAILY_FOLLOWUPS} questions for today. They reset tomorrow.` }, 429);
    let h = (Array.isArray(body.history) ? body.history : []).slice(-6)
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 900) }));
    while (h.length && h[0].role !== "user") h.shift();
    const msgs = [];
    for (const m of h) if (!msgs.length || msgs[msgs.length - 1].role !== m.role) msgs.push(m);
    if (msgs.length && msgs[msgs.length - 1].role === "user") msgs.pop();
    msgs.push({ role: "user", content: String(body.question).trim().slice(0, 300) });
    const answer = await ai(system, msgs);
    return json({ text: answer || "I couldn't come up with an answer. Try asking it another way.", remaining: quota.remaining });
  } catch (e) {
    console.error(e);
    if (e.message === "busy") return json({ message: "Lots of people are asking right now. Try again in a minute." }, 503);
    return json({ message: "Something went wrong. Please try again." }, 500);
  }
};
