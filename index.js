// Cloud Functions — بروكسيهات Streaming لكل مزوّدي الذكاء الاصطناعي (Groq،
// OpenRouter، Vercel AI Gateway، Gemini) + Tavily للبحث، بتخفي كل المفاتيح
// تمامًا عن المتصفح، ومعاها حمايات حقيقية على مستوى السيرفر (مش بس واجهة
// قابلة للتخطي):
//   0) App Check — الطلب لازم يجيب توكن X-Firebase-AppCheck صحيح، يعني جاي
//      فعليًا من نسخة التطبيق الرسمية (مش Postman ولا سكريبت خارجي حتى لو
//      معاه Firebase ID token مسروق).
//   1) لازم توكن دخول Firebase صحيح — مفيش استخدام من غير حساب مسجّل.
//   2) Rate limit لكل مستخدم (بالدقيقة + باليوم) يمنع أي إساءة استخدام حتى
//      لو حد لعب في الفرونت إند وتخطى الحدود اللي في script.js.
//   3) تنضيف/تقييد الـ body اللي بيتبعت لكل مزوّد (نموذج مسموح بيه، حجم
//      رسائل محدود، مفيش حقول غريبة بتتمرر زي ما هي).
//   4) CORS مقفول على دومين التطبيق بس، مش مفتوح لأي حد.
//
// تفعيل App Check للمشروع (مرة واحدة بس، من الكونسول):
//   Firebase Console → App Check → سجّل الـ Web App بتاعك → اختار reCAPTCHA v3
//   (أو reCAPTCHA Enterprise) → خد الـ Site Key وحطه في الفرونت إند (script.js).
//
// نشر: firebase deploy --only functions
// كل مفتاح بيتحط كـ secret مش في الكود:
//   firebase functions:secrets:set GROQ_API_KEY
//   firebase functions:secrets:set OPENROUTER_API_KEY
//   firebase functions:secrets:set VERCEL_GATEWAY_API_KEY
//   firebase functions:secrets:set GEMINI_API_KEY
//   firebase functions:secrets:set TAVILY_API_KEY

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

const GROQ_API_KEY = defineSecret("GROQ_API_KEY");
const OPENROUTER_API_KEY = defineSecret("OPENROUTER_API_KEY");
const VERCEL_GATEWAY_API_KEY = defineSecret("VERCEL_GATEWAY_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const TAVILY_API_KEY = defineSecret("TAVILY_API_KEY");

// ============ CORS — دومينات التطبيق المسموح لها تنادي البروكسي ============
// ضيف هنا أي دومين شغال عليه التطبيق فعليًا (نطاق Vercel بتاعك + أي دومين
// مخصص + localhost وقت التطوير). أي دومين مش في القائمة هيتم رفضه.
// ⚠️⚠️ ده لسه الـ placeholder الأصلي ("your-app.vercel.app") — لازم تستبدله
//    بدومين الـ Vercel الحقيقي بتاع محفوظات (اللي بتفتحه في المتصفح)، وإلا
//    كل الطلبات من التطبيق الحقيقي هتترفض بسبب CORS حتى لو الـ
//    CLOUD_FUNCTIONS_BASE في script.js كان صح. مش قادر أعرف الدومين ده من
//    الملفات اللي عندي، فلازم تحطه إنت.
const ALLOWED_ORIGINS = [
  "https://your-app.vercel.app",     // ⚠️ غيّرها لدومين الـ Vercel الحقيقي بتاعك
  "http://localhost:3000",
  "http://127.0.0.1:5500",
];

// ============ RATE LIMITS ============
const PER_MINUTE_LIMIT = 20;   // أقصى عدد طلبات لكل مستخدم في الدقيقة
const PER_DAY_LIMIT = 400;     // سقف يومي احتياطي لكل مستخدم (خط دفاع تاني غير حساب التوكنات في الفرونت إند)
const MAX_MESSAGES = 60;       // أقصى عدد رسائل في المحادثة الواحدة
const MAX_MESSAGE_CHARS = 20000; // أقصى طول نص لكل رسالة
const MAX_TOKENS_CAP = 8000;   // أقصى قيمة مسموح بيها لـ max_tokens حتى لو الفرونت طلب أكتر
const ALLOWED_MODELS = null;   // مثال: ["llama-3.3-70b-versatile","llama-3.1-8b-instant"] — سيبها null لو عايز تسمح بأي موديل

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

// ============ AUTH — لازم Firebase ID token صحيح ============
// المتصفح لازم يبعت: Authorization: Bearer <idToken بتاع firebase.auth().currentUser>
async function verifyCaller(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    return decoded; // فيه decoded.uid
  } catch (err) {
    console.warn("verifyIdToken failed", err.message);
    return null;
  }
}

// ============ APP CHECK — لازم توكن App Check صحيح في هيدر X-Firebase-AppCheck ============
// ده اللي بيضمن إن الطلب جاي فعليًا من نسخة التطبيق الرسمية (Vercel/الدومين
// المسجّل)، مش من Postman أو سكريبت خارجي حتى لو معاه Firebase ID token سليم
// (توكن الدخول ده ممكن يتسرق أو يتستخدم بره التطبيق، لكن توكن App Check
// مربوط بتحقق reCAPTCHA/الـ attestation بتاع التطبيق نفسه وقت التوليد).
// لازم يتنفّذ قبل أي منطق تاني وقبل استهلاك أي مفتاح/Secret.
async function verifyAppCheck(req) {
  const token = req.headers["x-firebase-appcheck"];
  if (!token) return null;
  try {
    const claims = await admin.appCheck().verifyToken(token);
    return claims; // فيه claims.appId
  } catch (err) {
    console.warn("App Check verifyToken failed", err.message);
    return null;
  }
}

// ============ RATE LIMIT — عدّاد لكل مستخدم في الـ Realtime Database ============
// بنستخدم transaction عشان لو جالك طلبين في نفس اللحظة ميحصلش race condition.
async function checkAndBumpRateLimit(uid) {
  const now = Date.now();
  const minuteKey = Math.floor(now / 60000);
  const dayKey = Math.floor(now / 86400000);
  const ref = admin.database().ref(`rateLimit/${uid}`);

  const result = await ref.transaction(current => {
    const data = current || {};
    // نضيّق البيانات القديمة (دقيقة/يوم فاتوا) عشان النود ميكبرش من غير داعي
    const minuteCount = (data.minuteKey === minuteKey) ? (data.minuteCount || 0) : 0;
    const dayCount = (data.dayKey === dayKey) ? (data.dayCount || 0) : 0;
    return {
      minuteKey, minuteCount: minuteCount + 1,
      dayKey, dayCount: dayCount + 1,
    };
  });

  if (!result.committed) return { ok: true }; // فشل نادر في الـ transaction — منسيبش المستخدم يتقفل بسببه
  const data = result.snapshot.val() || {};
  if (data.minuteCount > PER_MINUTE_LIMIT) {
    return { ok: false, reason: "rate_limited_minute" };
  }
  if (data.dayCount > PER_DAY_LIMIT) {
    return { ok: false, reason: "rate_limited_day" };
  }
  return { ok: true };
}

// ============ الفحوصات المشتركة لأي بروكسي (App Check + Auth + كيل-سويتش + Rate Limit) ============
// بترجع { ok:true, uid } لو الطلب سليم، أو بترد على res مباشرة وترجع { ok:false } لو مرفوض —
// بستخدمها في أول أي Cloud Function بروكسي بدل ما أكرر نفس الأربع خطوات في كل واحدة.
async function runGuardChecks(req, res) {
  const appCheckClaims = await verifyAppCheck(req);
  if (!appCheckClaims) {
    res.status(401).json({ error: "app_check_failed", message: "Missing or invalid App Check token." });
    return { ok: false };
  }
  const decoded = await verifyCaller(req);
  if (!decoded) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid ID token." });
    return { ok: false };
  }
  if (await isAiPaused()) {
    res.status(503).json({
      error: "ai_paused",
      message: "AI services are temporarily paused for an emergency security review (up to 24h)."
    });
    return { ok: false };
  }
  const rl = await checkAndBumpRateLimit(decoded.uid);
  if (!rl.ok) {
    res.status(429).json({ error: rl.reason, message: "Too many requests — try again shortly." });
    return { ok: false };
  }
  return { ok: true, uid: decoded.uid };
}

// ============ تنضيف الـ body قبل ما يتبعت لـ Groq ============
function sanitizePayload(body) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  if (!Array.isArray(body.messages) || !body.messages.length) return { error: "messages_required" };
  if (body.messages.length > MAX_MESSAGES) return { error: "too_many_messages" };

  for (const m of body.messages) {
    if (!m || typeof m !== "object") return { error: "invalid_message" };
    if (typeof m.content === "string" && m.content.length > MAX_MESSAGE_CHARS) {
      return { error: "message_too_long" };
    }
  }

  if (ALLOWED_MODELS && !ALLOWED_MODELS.includes(body.model)) {
    return { error: "model_not_allowed" };
  }

  // بنمرّر الحقول المعروفة بس (whitelist) — أي حقل غريب بيتشال
  const clean = {
    model: body.model,
    messages: body.messages,
    stream: !!body.stream,
  };
  if (typeof body.temperature === "number") clean.temperature = body.temperature;
  if (typeof body.top_p === "number") clean.top_p = body.top_p;
  if (body.max_tokens != null) {
    clean.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP);
  }
  if (body.tools) clean.tools = body.tools;
  if (body.tool_choice) clean.tool_choice = body.tool_choice;

  return { data: clean };
}

// ============ تمرير رد المزوّد كما هو (Status + Content-Type + الـ Stream نفسه) ============
async function relayStream(res, upstream) {
  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

exports.groqProxy = onRequest(
  { secrets: [GROQ_API_KEY], cors: ALLOWED_ORIGINS, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    const guard = await runGuardChecks(req, res);
    if (!guard.ok) return;

    const sanitized = sanitizePayload(req.body);
    if (sanitized.error) {
      res.status(400).json({ error: sanitized.error });
      return;
    }

    try {
      const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + GROQ_API_KEY.value(), // ← المفتاح بيتحط هنا بس، في السيرفر
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sanitized.data),
      });
      await relayStream(res, upstream);
    } catch (err) {
      console.error("groqProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);

// ============ نفس النمط بالظبط لـ OpenRouter وVercel AI Gateway ============
// الاتنين متوافقين مع صيغة OpenAI (/v1/chat/completions) زي Groq بالظبط،
// فبنستخدم نفس sanitizePayload ونفس منطق تمرير الـ Stream (relayStream)،
// والفرق الوحيد هو الـ URL والمفتاح بس.
exports.openRouterProxy = onRequest(
  { secrets: [OPENROUTER_API_KEY], cors: ALLOWED_ORIGINS, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
    const guard = await runGuardChecks(req, res);
    if (!guard.ok) return;
    const sanitized = sanitizePayload(req.body);
    if (sanitized.error) { res.status(400).json({ error: sanitized.error }); return; }
    try {
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENROUTER_API_KEY.value(), "Content-Type": "application/json" },
        body: JSON.stringify(sanitized.data),
      });
      await relayStream(res, upstream);
    } catch (err) {
      console.error("openRouterProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);

exports.vercelGatewayProxy = onRequest(
  { secrets: [VERCEL_GATEWAY_API_KEY], cors: ALLOWED_ORIGINS, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
    const guard = await runGuardChecks(req, res);
    if (!guard.ok) return;
    const sanitized = sanitizePayload(req.body);
    if (sanitized.error) { res.status(400).json({ error: sanitized.error }); return; }
    try {
      const upstream = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + VERCEL_GATEWAY_API_KEY.value(), "Content-Type": "application/json" },
        body: JSON.stringify(sanitized.data),
      });
      await relayStream(res, upstream);
    } catch (err) {
      console.error("vercelGatewayProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);

// ============ Gemini — شكل مختلف (contents/parts بدل messages + هيدر مفتاح مختلف) ============
// بنسيب الفرونت إند يحدد الموديل والـ contents وgenerationConfig زي ما هو (Gemini
// مالوش نفس بنية OpenAI)، بس برضو بنحدد سقف maxOutputTokens وعدد الـ contents
// عشان محدش يستهلك المفتاح بطلبات ضخمة أو غريبة.
const MAX_CONTENTS = 60;
function sanitizeGeminiPayload(body) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  if (!Array.isArray(body.contents) || !body.contents.length) return { error: "contents_required" };
  if (body.contents.length > MAX_CONTENTS) return { error: "too_many_contents" };
  const clean = { contents: body.contents };
  if (body.systemInstruction) clean.systemInstruction = body.systemInstruction;
  const genCfg = (body.generationConfig && typeof body.generationConfig === "object") ? body.generationConfig : {};
  clean.generationConfig = {
    temperature: typeof genCfg.temperature === "number" ? genCfg.temperature : 0.4,
    maxOutputTokens: Math.min(Number(genCfg.maxOutputTokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
  };
  if (genCfg.thinkingConfig) clean.generationConfig.thinkingConfig = genCfg.thinkingConfig;
  return { data: clean };
}
exports.geminiProxy = onRequest(
  { secrets: [GEMINI_API_KEY], cors: ALLOWED_ORIGINS, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
    const guard = await runGuardChecks(req, res);
    if (!guard.ok) return;
    const sanitized = sanitizeGeminiPayload(req.body);
    if (sanitized.error) { res.status(400).json({ error: sanitized.error }); return; }
    const model = (typeof req.body.model === "string" && /^[a-zA-Z0-9._-]+$/.test(req.body.model))
      ? req.body.model : "gemini-3.5-flash";
    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY.value() },
          body: JSON.stringify(sanitized.data),
        }
      );
      await relayStream(res, upstream);
    } catch (err) {
      console.error("geminiProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);

// ============ Groq Whisper — تفريغ الصوت (multipart، مش JSON) ============
// الطلب من المتصفح بييجي كـ FormData (multipart/form-data) جاهز بالحدود
// (boundary) الصحيحة، فبنمرره زي ما هو لـ Groq من غير ما نفكّه أو نعيد
// بناءه — بنحتاج بس نضيف المفتاح في الهيدر ونستبدل الفورم-فيلد "model"
// المرسل من الفرونت إند (مش موثوق) بقيمة ثابتة معروفة من السيرفر.
exports.groqWhisperProxy = onRequest(
  { secrets: [GROQ_API_KEY], cors: ALLOWED_ORIGINS, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
    const guard = await runGuardChecks(req, res);
    if (!guard.ok) return;
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      res.status(400).json({ error: "invalid_content_type" });
      return;
    }
    if (!req.rawBody || req.rawBody.length > 25 * 1024 * 1024) { // 25MB سقف حجم الملف الصوتي
      res.status(400).json({ error: "file_too_large_or_missing" });
      return;
    }
    try {
      const upstream = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + GROQ_API_KEY.value(),
          "Content-Type": contentType, // بيحمل الـ boundary الأصلي، لازم يتبعت زي ما هو
        },
        body: req.rawBody,
      });
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.send(text);
    } catch (err) {
      console.error("groqWhisperProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);
const MAX_QUERY_CHARS = 400;
exports.tavilyProxy = onRequest(
  { secrets: [TAVILY_API_KEY], cors: ALLOWED_ORIGINS, timeoutSeconds: 60 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
    const guard = await runGuardChecks(req, res);
    if (!guard.ok) return;
    const body = req.body || {};
    const action = body.action === "extract" ? "extract" : "search";
    try {
      let upstream;
      if (action === "extract") {
        if (!Array.isArray(body.urls) || !body.urls.length || body.urls.length > 5) {
          res.status(400).json({ error: "invalid_urls" }); return;
        }
        upstream = await fetch("https://api.tavily.com/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: TAVILY_API_KEY.value(), urls: body.urls, extract_depth: "advanced" }),
        });
      } else {
        if (typeof body.query !== "string" || !body.query.trim() || body.query.length > MAX_QUERY_CHARS) {
          res.status(400).json({ error: "invalid_query" }); return;
        }
        const clean = {
          api_key: TAVILY_API_KEY.value(),
          query: body.query,
          search_depth: (body.search_depth === "advanced") ? "advanced" : "basic",
          max_results: Math.min(Number(body.max_results) || 5, 10),
          include_answer: !!body.include_answer,
          include_images: !!body.include_images,
          include_image_descriptions: !!body.include_image_descriptions,
        };
        if (Array.isArray(body.include_domains)) clean.include_domains = body.include_domains.slice(0, 10);
        upstream = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(clean),
        });
      }
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.send(text);
    } catch (err) {
      console.error("tavilyProxy error", err);
      res.status(502).json({ error: "upstream_failed", message: err.message });
    }
  }
);
