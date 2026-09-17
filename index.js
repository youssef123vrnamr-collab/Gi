// مثال Cloud Function — بروكسي Streaming لـ Groq بيخفي المفتاح تمامًا عن المتصفح.
// نفس الفكرة تتكرر لـ Gemini / OpenRouter / Vercel Gateway (URL مختلف بس).
//
// نشر: firebase deploy --only functions:groqProxy
// المفتاح بيتحط كـ secret مش في الكود: firebase functions:secrets:set GROQ_API_KEY

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

const GROQ_API_KEY = defineSecret("GROQ_API_KEY");

// ============ SECURITY KILL-SWITCH (الدرع → التعهد الأمني) ============
// قبل أي طلب لـ Groq، بنقرا security/aiPause من الـ Realtime Database. لو
// مستخدم بلّغ عن خرق أمني من صفحة الدرع، الفرونت إند بيحط active:true +
// until (بعد 24 ساعة)، وهنا السيرفر بيرفض أي طلب ذكاء اصطناعي طول ما العلَم
// شغال ولسه في وقته — ده اللي بيضمن إن "التعهد" فعلي على مستوى السيرفر
// مش بس واجهة، حتى لو حد لعب في الفرونت إند وتخطى القفل اللي في script.js.
async function isAiPaused() {
  try {
    const snap = await admin.database().ref("security/aiPause").once("value");
    const val = snap.val();
    if (!val || !val.active) return false;
    if (val.until && val.until <= Date.now()) {
      // انتهت الـ 24 ساعة — نشيل العلَم تلقائيًا عشان الخدمة ترجع لوحدها
      await admin.database().ref("security/aiPause").update({ active: false });
      await admin.database().ref("security/broadcast").update({ active: false });
      return false;
    }
    return true;
  } catch (err) {
    console.error("isAiPaused check failed", err);
    return false; // فشل القراءة نفسه مايوقفش الخدمة عن الكل
  }
}

exports.groqProxy = onRequest(
  { secrets: [GROQ_API_KEY], cors: true, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    if (await isAiPaused()) {
      res.status(503).json({
        error: "ai_paused",
        message: "AI services are temporarily paused for an emergency security review (up to 24h)."
      });
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
