// مثال Cloud Function — بروكسي Streaming لـ Groq بيخفي المفتاح تمامًا عن المتصفح.
// نفس الفكرة تتكرر لـ Gemini / OpenRouter / Vercel Gateway (URL مختلف بس).
//
// نشر: firebase deploy --only functions:groqProxy
// المفتاح بيتحط كـ secret مش في الكود: firebase functions:secrets:set GROQ_API_KEY

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const GROQ_API_KEY = defineSecret("GROQ_API_KEY");

exports.groqProxy = onRequest(
  { secrets: [GROQ_API_KEY], cors: true, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    try {
      const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + GROQ_API_KEY.value(), // ← المفتاح بيتحط هنا بس، في السيرفر
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
      });

      // بنمرّر نفس حالة الاستجابة والـ Content-Type (بما فيها البث Streaming)
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");

      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      console.error("groqProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);
