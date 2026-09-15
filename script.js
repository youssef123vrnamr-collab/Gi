(function(){
"use strict";

/* ============ FIREBASE ============
   Same Firebase project as the game (auth + database only — nothing
   about the game itself is reused here). */
const firebaseConfig = {
  apiKey: "AIzaSyC_1ZPw0NMw2YznMO0PE9vZGzFVa0f7jvQ",
  authDomain: "ai-prime-f9017.firebaseapp.com",
  projectId: "ai-prime-f9017",
  storageBucket: "ai-prime-f9017.firebasestorage.app",
  messagingSenderId: "932445525165",
  appId: "1:932445525165:web:425c870176b2091d12e224",
  databaseURL: "https://ai-prime-f9017-default-rtdb.europe-west1.firebasedatabase.app"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
// ── Firestore بتاع مشروع محفوظات نفسه (مش فلك) — هنا هنخزّن "الذاكرة الدائمة" (غرفة 3):
//    تقييمات الردود 👍👎 اللي بتغذي دروس مستفادة وردود عجبت الناس، خاصة بمحفوظات بس ──
const ownDb = firebase.firestore();

/* ============ SHARED AI KEYS (من نفس Firestore بتاع منصة فلك) ============
   منصة فلك (مشروع Firebase: planning-with-ai-390af) بتخزّن كل مفاتيح
   الذكاء الاصطناعي (Groq / Gemini / OpenRouter / Vercel AI Gateway / Tavily) في
   Firestore هنا: system/ai_settings — بنفس الطريقة دي بالظبط، المنصة
   الجديدة دي بتتصل بنفس المشروع (كـ "secondary app"، من غير ما تلمس أو
   تعدل حاجة في فلك نفسها) وتقرا نفس المفاتيح لحظة بلحظة، وتستخدم نفس
   نظام التوزيع والتبديل التلقائي (fallback) اللي فلك بتستخدمه بالظبط:
   Groq → Gemini → OpenRouter → Vercel AI Gateway لو اللي قبله فشل. */
const falakConfig = {
  apiKey: "AIzaSyCAgFi4D9hwtuK391fLsbnDuh5AtTDIHKU",
  authDomain: "planning-with-ai-390af.firebaseapp.com",
  projectId: "planning-with-ai-390af",
  storageBucket: "planning-with-ai-390af.firebasestorage.app",
  messagingSenderId: "601755857673",
  appId: "1:601755857673:web:b9d7d63e13035412a819d8"
};
const falakApp = firebase.initializeApp(falakConfig, "falak");
const falakDb = falakApp.firestore();

/* ============ ApiKeyPool (نفس نسخة فلك حرفيًا) ============
   لو فيه أكتر من مفتاح لنفس المزوّد، بيوزّع الطلبات بينهم (Round-Robin)،
   ولو مفتاح فشل مرتين على التوالي بيتجنّبه لمدة 5 دقايق ويستخدم غيره. */
const ApiKeyPool = {
  create(){
    const state = { keys: [], idx: 0, status: {} };
    return {
      setKeys(arr){
        state.keys = (arr||[]).map(k=>(k||'').toString().trim()).filter(Boolean);
        if (state.idx >= state.keys.length) state.idx = 0;
      },
      count(){ return state.keys.length; },
      next(){
        if (!state.keys.length) return null;
        const n = state.keys.length;
        for (let i=0;i<n;i++){
          const k = state.keys[state.idx % n];
          state.idx = (state.idx+1) % n;
          const s = state.status[k];
          const degraded = s && s.consecFail>=2 && (Date.now()-s.lastFailAt) < 300000;
          if (!degraded) return k;
        }
        return state.keys[0];
      },
      report(key, ok){
        if (!key) return;
        const s = state.status[key] || (state.status[key] = { consecFail:0, lastFailAt:0 });
        if (ok) s.consecFail = 0; else { s.consecFail++; s.lastFailAt = Date.now(); }
      }
    };
  }
};
const GroqKeyPool = ApiKeyPool.create();
const GeminiKeyPool = ApiKeyPool.create();
const OpenRouterKeyPool = ApiKeyPool.create();
const VercelGatewayKeyPool = ApiKeyPool.create();
let globalAiInstructions = "";
let tavilyApiKey = "";

falakDb.collection("system").doc("ai_settings").onSnapshot(
  snap => {
    const d = snap.exists ? (snap.data() || {}) : {};
    const soloGroq = (d.groqApiKey && String(d.groqApiKey).trim()) || "";
    const soloGemini = (d.geminiApiKey && String(d.geminiApiKey).trim()) || "";
    globalAiInstructions = (d.globalAiInstructions && String(d.globalAiInstructions).trim()) || "";
    tavilyApiKey = (d.tavilyApiKey && String(d.tavilyApiKey).trim()) || "";
    GroqKeyPool.setKeys(Array.isArray(d.groqApiKeys) && d.groqApiKeys.length ? d.groqApiKeys : (soloGroq ? [soloGroq] : []));
    GeminiKeyPool.setKeys(Array.isArray(d.geminiApiKeys) && d.geminiApiKeys.length ? d.geminiApiKeys : (soloGemini ? [soloGemini] : []));
    OpenRouterKeyPool.setKeys(Array.isArray(d.openrouterApiKeys) ? d.openrouterApiKeys : []);
    VercelGatewayKeyPool.setKeys(Array.isArray(d.vercelApiKeys) ? d.vercelApiKeys : []);
  },
  err => {
    // الأغلب لو ده ظهر: صلاحيات Firestore بتاعة فلك مش سامحة بالقراءة من
    // مشروع تاني. الحل: من إعدادات Firestore Rules في مشروع فلك، تسمح
    // بقراءة system/ai_settings (زي ما هي مسموحة أصلاً لمستخدمي فلك نفسها).
    console.warn("مقدرش أقرا مفاتيح الذكاء الاصطناعي من فلك:", err);
  }
);

/* ============ الذاكرة الدائمة (غرفة 3) — دروس من 👎 وردود عجبت الناس 👍 ============
   بتتخزن في Firestore بتاع محفوظات نفسها (ownDb)، مش فلك — عشان تبقى خاصة
   بمحفوظات وبمستخدميها بس، بنفس فكرة فلك بالظبط لكن قاعدة بيانات منفصلة. */
let lessonsList = [];   // ردود اتقيّمت 👎 — دروس متتكررش
let goodAnswersList = []; // ردود اتقيّمت 👍 — حافظ على نفس المستوى
ownDb.collection("ai_feedback").where("liked","==",false).orderBy("createdAt","desc").limit(8)
  .onSnapshot(snap => { lessonsList = snap.docs.map(d=>d.data()); }, err => console.warn("lessons feed err", err));
ownDb.collection("ai_feedback").where("liked","==",true).orderBy("createdAt","desc").limit(8)
  .onSnapshot(snap => { goodAnswersList = snap.docs.map(d=>d.data()); }, err => console.warn("good answers feed err", err));

function submitAIFeedback(liked, question, answer){
  try{
    ownDb.collection("ai_feedback").add({
      userId: (currentUser && currentUser.uid) || null,
      question: String(question||"").slice(0,500),
      answer: String(answer||"").slice(0,2000),
      liked: !!liked,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(e=>console.error("feedback add err", e));
  } catch(e){ console.error("submitAIFeedback err", e); }
}

const AI_DISPLAY_NAME = "AlalaGyGyAgha V1.6";
// النظام تلقائي بس دلوقتي — مفيش اختيار يدوي لموديل معيّن ولا متغيّر بيتفحص
// قيمته، عشان المستخدم دايمًا ياخد نفس تجربة "خطوط الدفاع"
// (Groq → Gemini → OpenRouter → Vercel) بالترتيب الثابت في getAIResponse.

/* ============ القراءة الصوتية (Text-to-Speech) — كانت موجودة في فلك وناقصة هنا ============
   بتقرا رد الذكاء بصوت عربي لو متاح على الجهاز، مع زرار توقف لو المستخدم عايز يقاطع. */
let voiceSettings = { voiceURI: null, rate: 1, pitch: 1 };
let availableVoices = [];
let currentUtterance = null;

function loadArabicVoices(){
  if (!('speechSynthesis' in window)) return;
  availableVoices = window.speechSynthesis.getVoices() || [];
  if (!voiceSettings.voiceURI){
    const ar = availableVoices.find(v => /^ar/i.test(v.lang));
    if (ar) voiceSettings.voiceURI = ar.voiceURI;
  }
}
if ('speechSynthesis' in window){
  loadArabicVoices();
  window.speechSynthesis.onvoiceschanged = loadArabicVoices;
}

// ── بيشيل الماركداون/كتل الكود من النص قبل ما ينطقه، عشان الصوت يبقى مفهوم ──
function stripForSpeech(raw){
  return String(raw||'')
    .replace(/```[\s\S]*?```/g, ' جزء كود، اضغط على البطاقة عشان تشوفه. ')
    .replace(/\[\[color:[a-zA-Z]+\]\]([\s\S]*?)\[\[\/color\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/https?:\/\/\S+/g, ' رابط. ')
    .replace(/[*_>~]/g, '')
    .trim();
}

function speakText(text, btnEl){
  if (!('speechSynthesis' in window)){
    showToastSafe('⚠️ المتصفح ده مش بيدعم القراءة الصوتية');
    return;
  }
  const wasSpeaking = window.speechSynthesis.speaking;
  window.speechSynthesis.cancel();
  document.querySelectorAll('.cosmos-action-btn.speaking').forEach(b=>{
    b.classList.remove('speaking'); b.innerHTML = '<i class="fas fa-volume-high"></i>';
  });
  if (wasSpeaking && btnEl && btnEl.dataset.wasActive === '1'){ btnEl.dataset.wasActive = '0'; return; }

  const clean = stripForSpeech(text);
  if (!clean) return;
  const utter = new SpeechSynthesisUtterance(clean);
  utter.rate = voiceSettings.rate; utter.pitch = voiceSettings.pitch;
  const voice = availableVoices.find(v => v.voiceURI === voiceSettings.voiceURI);
  if (voice) utter.voice = voice; else utter.lang = 'ar-EG';
  if (btnEl){
    btnEl.classList.add('speaking'); btnEl.innerHTML = '<i class="fas fa-stop"></i>'; btnEl.dataset.wasActive = '1';
  }
  utter.onend = utter.onerror = ()=>{
    if (btnEl){ btnEl.classList.remove('speaking'); btnEl.innerHTML = '<i class="fas fa-volume-high"></i>'; btnEl.dataset.wasActive = '0'; }
    currentUtterance = null;
  };
  currentUtterance = utter;
  window.speechSynthesis.speak(utter);
}
function showToastSafe(msg){ showToast(msg); }

// ── توست بسيط لرسائل قصيرة (نجاح/تحذير) — مفيش نظام توست جاهز في محفوظات فاستخدمناه هنا ──
let __toastTimer = null;
function showToast(msg){
  let el = document.getElementById('mahfoozat-toast');
  if (!el){
    el = document.createElement('div');
    el.id = 'mahfoozat-toast';
    el.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);' +
      'background:var(--panel-raised,#222);color:var(--text,#fff);padding:10px 18px;border-radius:20px;' +
      'font-size:13px;z-index:9999;box-shadow:0 4px 18px rgba(0,0,0,.35);border:1px solid var(--border,#333);' +
      'max-width:85vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(()=>{ el.style.opacity = '0'; }, 2600);
}

/* ============ غرفة 1: التفكير العميق — نفس تعليمات فلك بالظبط + دفعها لتفكير احترافي حقيقي ============ */
function buildReasoningRoomBlock(){
  return '\n\n--- غرفة التفكير العميق (Deep Thinking Room) — تفكيرك الداخلي الحقيقي، منفصل عن الرد النهائي ---\n' +
    'ملاحظة مهمة: النظام بيفصل تفكيرك (reasoning) عن ردك النهائي (content) تلقائيًا ويعرض تفكيرك في صندوق منفصل قابل للفتح للمستخدم — يعني اكتب تفكيرك بحرية وبالتفصيل هنا، ومتقلقش إنه هيظهر في الرد النهائي لأنه مش هيظهر فيه.\n' +
    'استخدم المساحة دي زي مهندس/خبير محترف بيفكر فعلاً قبل ما يجاوب، مش بس ملخص سريع. لو السؤال عن كود أو نظام تقني: افهم المطلوب بالظبط الأول (حتى لو محتاج تفترض حاجة غامضة، اذكرها لنفسك)، فكر في أكتر من طريقة ممكنة لحل المشكلة وقارن بينهم بصراحة (مميزات/عيوب كل واحدة)، اختار أفضل حل وقول ليه هو الأنسب هنا تحديدًا، فكر في الحالات الحدّية (edge cases) والأخطاء المحتملة وإزاي هتتعامل معاها، وراجع الحل في دماغك خطوة بخطوة قبل ما تكتبه في الرد النهائي (يعني "شغّله وهميًا" في عقلك وشوف هل فعلاً هيشتغل صح). لو السؤال تحليلي أو معلوماتي: فكك المشكلة لأجزاء، اجمع المعطيات، وازن بين وجهات النظر المختلفة لو موجودة، ووصل لاستنتاج مبني على منطق واضح مش رأي عشوائي. الهدف إن الرد النهائي يطلع نتيجة تفكير عميق فعلي، مش مجرد إجابة سريعة من أول خاطر.';
}

/* ============ قاعدة إلزامية: كود بمستوى مهندس محترف (Senior Engineer) ============
   مش بس "الكود يشتغل" — المطلوب كود نضيف، منظم، وبمعايير احترافية حقيقية. */
function buildProCodeQualityBlock(){
  return '\n\nقاعدة إلزامية بخصوص جودة الكود: لما تكتب كود، اكتبه بمستوى مهندس Senior محترف مش مجرد كود "بيشتغل وخلاص":\n' +
    '- استخدم أفضل الممارسات (best practices) المعروفة للغة/الإطار (framework) اللي بتكتب بيه، وابتعد عن أي نمط قديم أو متروك (deprecated).\n' +
    '- سمّي المتغيرات والدوال بأسماء واضحة ومعبّرة عن معناها، مش أسماء عشوائية زي x أو temp من غير داعي.\n' +
    '- افصل المسؤوليات (separation of concerns) — كل دالة أو جزء ليه مهمة واحدة واضحة، من غير حشو كل حاجة في مكان واحد.\n' +
    '- تعامل مع الأخطاء المتوقعة (error handling) بدل ما تفترض إن كل حاجة هتنجح دايمًا (زي فشل طلب شبكة، إدخال غلط من المستخدم، قيمة فاضية أو null).\n' +
    '- غطّي الحالات الحدّية (edge cases) المنطقية للمشكلة، مش بس الحالة السعيدة (happy path).\n' +
    '- لو الكود فيه منطق مش بديهي أو قرار تصميمي مهم، حط تعليق قصير يشرح "ليه" مش بس "إيه" — من غير ما تبالغ في التعليقات على حاجات واضحة أصلاً.\n' +
    '- انتبه للأداء (performance) في الحاجات اللي منطقيًا ممكن تبقى مشكلة (زي حلقات متداخلة على بيانات كبيرة، أو طلبات شبكة زيادة عن اللزوم)، من غير ما تعقّد الكود بلا داعي في حاجات بسيطة.\n' +
    '- لو في اعتبار أمني واضح للسياق (زي مدخلات مستخدم، مفاتيح، صلاحيات)، خده بالك منه.\n' +
    'باختصار: تخيل إن الكود ده هيتراجع من مبرمج محترف تاني قبل ما يتنشر — لازم يبان إنه مكتوب باحتراف من أول قراءة، مش مجرد حل سريع.';
}

/* ============ قاعدة تلوين وتنسيق النص (ألوان متناسقة مع خلفية التطبيق + تنسيقات حرة) + منع اللاتكس الخام ============ */
function buildColorPolicyBlock(){
  return '\n\nقاعدة التلوين والتنسيق: عندك حرية إنك تلوّن وتنسّق أي جزء من ردك النصي (مش الكود) زي ما تحس إنه مناسب، لكن الألوان لازم تكون من مجموعة محددة ومظبوطة عشان تبان متناسقة مع خلفية التطبيق الغامقة الدافية، مش أي لون عشوائي ممكن يبان لاقع أو مش متناسق مع التصميم. استخدم الصيغة دي بالظبط: [[fmt:خصائص]]النص هنا[[/fmt]] — و"خصائص" قائمة مفصولة بفاصلة، ممكن تحط فيها لون واحد بس من القائمة المسموحة دي (وكل لون له معنى مقترح بس مش إلزامي تلتزم بيه):\n'
    + '- gold أو amber → تمييز أو تنبيه إيجابي أو نقطة مهمة\n'
    + '- sage → نجاح أو نقطة إيجابية\n'
    + '- rose → تحذير أو خطأ\n'
    + '- coral → تنبيه متوسط\n'
    + '- sky → معلومة أو ملاحظة\n'
    + '- lavender → حاجة مميزة أو غير عادية\n'
    + '- sand أو slate → تفاصيل ثانوية أقل أهمية\n'
    + 'وممكن تضيف مع اللون (أو من غيره) أي من دول: bold, italic, underline, strike, highlight — و highlight بتحط خلفية خفيفة شفافة بنفس اللون حوالين النص زي شارة (badge). مثال: [[fmt:rose,bold]]تحذير مهم[[/fmt]] أو [[fmt:gold,highlight]]نقطة مميزة[[/fmt]]. ممنوع تماما تستخدم أي لون تاني غير القائمة دي، وممنوع تكتب كود hex أو أسماء ألوان عادية زي red أو blue أو green مباشرة — استخدم الأسماء المتناسقة دي بس عشان تفضل شكل التطبيق موحّد وحلو. ومتلوّنش أو تنسّق الرد كله ولا كل سطر، استخدمها بس لما فعلاً تفيد.';
}
function buildNoRawLatexBlock(){
  return '\n\nقاعدة إلزامية: ممنوع تستخدم صيغة LaTeX الخام (زي \\frac{}{} أو \\sqrt{} أو \\gamma أو \\times) في أي معادلة رياضية، لأن واجهة المحادثة دي مفيهاش عارض LaTeX وهتظهر للمستخدم كرموز خام غريبة بدل معادلة واضحة. اكتب المعادلات بصيغة نصية عادية ومقروءة بس (زي x^2 أو (a+b)/c أو √x أو a/b أو γ = 1/√(1-v²/c²)).';
}
/* ============ قاعدة إلزامية: أكواد كاملة أبدًا مبتورة ============
   أكتر مشكلة بتحصل مع الموديلات: بتوقف الكود في نص الطريق أو تحط تعليق
   زي "// باقي الكود زي ما هو" بدل ما تكتبه فعليًا. القاعدة دي بتمنع ده. */
function buildCodeCompletenessBlock(){
  return '\n\nقاعدة إلزامية بخصوص الأكواد: لما تكتب كود جوه ```، لازم يكون الكود كامل 100% وشغّال من الأول للآخر، من غير أي اختصار أو حذف. ممنوع تماما تستخدم أي حاجة زي "// باقي الكود زي ما هو"، "// rest of the code"، "// ...", "/* نفس الكود اللي فات */"، أو أي جملة تلخيصية بدل ما تكتب الكود فعليًا — حتى لو الملف طويل. لو الكود طويل جدًا ومحتاج مساحة أكبر من اللي قدامك، اكتب أكبر قدر ممكن منه وسيبه بدون علامة إغلاق ``` في نهاية ردك (يعني متقفلش الكود الفاضي)، عشان النظام هيطلب منك تكمل تلقائيًا من نفس النقطة؛ أما لو خلصت الكود فعلاً، اقفله بـ ``` عادي. الأولوية دايمًا لكود كامل وصحيح، حتى لو ده معناه إجابة أطول.';
}
/* ============ نظام كتابة الأكواد الذكي — بطاقة ملف لكل كتلة كود ============
   هيدر فيه أيقونة/اسم ملف/لغة/عدد أسطر + تلوين كود احترافي (highlight.js) + نسخ/تنزيل + تقييم 👍👎
   يغذي "غرفة كود دائمة" منفصلة عن غرفة النصوص، بنفس فكرة فلك بالظبط. */
window.__codeGroups = window.__codeGroups || {};
let _codeGidCounter = 0;

const CODE_EXT_MAP   = { html:'html', htm:'html', xml:'xml', css:'css', scss:'scss', js:'js', javascript:'js', jsx:'jsx', ts:'ts', typescript:'ts', json:'json', py:'py', python:'py', sql:'sql', sh:'sh', bash:'sh', shell:'sh', c:'c', cpp:'cpp', java:'java', php:'php', rb:'rb', ruby:'rb', go:'go', yaml:'yaml', yml:'yaml', md:'md' };
const CODE_LABEL_MAP = { html:'HTML', htm:'HTML', css:'CSS', scss:'SCSS', js:'JS', javascript:'JS', jsx:'JSX', ts:'TS', typescript:'TS', json:'JSON', py:'PY', python:'PY', sql:'SQL', sh:'SH', bash:'SH', shell:'SH', c:'C', cpp:'C++', java:'JAVA', php:'PHP', rb:'RUBY', ruby:'RUBY', go:'GO', yaml:'YAML', yml:'YAML', md:'MD' };
const CODE_NAME_MAP  = { html:'index', css:'style', js:'script', jsx:'app', ts:'app', json:'data', py:'main', sql:'query', sh:'script', c:'main', cpp:'main', java:'Main', php:'index', rb:'main', go:'main', md:'readme' };
const CODE_HLJS_MAP  = { html:'xml', htm:'xml', css:'css', scss:'scss', js:'javascript', javascript:'javascript', jsx:'javascript', ts:'typescript', typescript:'typescript', json:'json', py:'python', python:'python', sql:'sql', sh:'bash', bash:'bash', shell:'bash', c:'c', cpp:'cpp', java:'java', php:'php', rb:'ruby', ruby:'ruby', go:'go', yaml:'yaml', yml:'yaml', md:'markdown' };

function buildCodeFileCard(lang, code){
  const gid = 'cg' + (++_codeGidCounter) + '_' + Date.now();
  window.__codeGroups[gid] = code;
  const l = (lang||'').toLowerCase().trim();
  const ext = CODE_EXT_MAP[l] || 'txt';
  const label = CODE_LABEL_MAP[l] || (l ? l.toUpperCase() : 'TXT');
  const baseName = CODE_NAME_MAP[l] || 'file';
  const filename = baseName + '.' + ext;
  const title = baseName.charAt(0).toUpperCase() + baseName.slice(1);
  window.__codeMeta = window.__codeMeta || {};
  window.__codeMeta[gid] = { filename, title, label, hljsLang: CODE_HLJS_MAP[l] || l || 'plaintext' };
  // ── بطاقة بمقاس ثابت دايمًا (نفس الشكل/الطول/العرض) بغض النظر عن طول الكود —
  //    الضغط عليها بيفتح الكود كامل في نافذة منفصلة، مش بيوسّع جوه الشات ──
  return '<div class="code-file-card" data-gid="'+gid+'" onclick="openCodeFileModal(\''+gid+'\')">'
    + '<div class="code-file-icon"><i class="fas fa-code"></i></div>'
    + '<div class="code-file-meta"><div class="code-file-name" dir="ltr">'+title+'</div>'
    + '<div class="code-file-sub" dir="ltr">كود · '+label+'</div></div>'
    + '<i class="fas fa-chevron-left code-file-arrow"></i>'
    + '</div>';
}

window.openCodeFileModal = function(gid){
  const code = window.__codeGroups[gid];
  const meta = (window.__codeMeta || {})[gid];
  if (!code || !meta) return;
  document.querySelectorAll('.code-modal-overlay').forEach(el=>el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'code-modal-overlay';
  overlay.setAttribute('data-gid', gid);
  overlay.innerHTML =
    '<div class="code-modal">'
    + '<div class="code-modal-header">'
    + '<div class="code-modal-title" dir="ltr">'+meta.filename+'</div>'
    + '<div class="code-modal-actions">'
    + '<button type="button" class="code-modal-btn" title="نسخ" onclick="copyCodeFile(\''+gid+'\',this)"><i class="fas fa-copy"></i></button>'
    + '<button type="button" class="code-modal-btn" title="تنزيل" onclick="downloadCodeFile(\''+gid+'\',\''+meta.filename+'\')"><i class="fas fa-download"></i></button>'
    + '<button type="button" class="code-modal-btn" title="إغلاق" onclick="closeCodeModal(\''+gid+'\')"><i class="fas fa-times"></i></button>'
    + '</div></div>'
    + '<div class="code-modal-body"><pre><code class="hljs language-'+meta.hljsLang+'">'+escapeHtml(code)+'</code></pre></div>'
    + '<div class="code-rate-bar"><span class="code-rate-label">الكود ده عجبك؟</span>'
    + '<button type="button" class="code-rate-btn code-rate-good" onclick="rateCodeGood(\''+gid+'\',this)"><i class="fas fa-thumbs-up"></i></button>'
    + '<button type="button" class="code-rate-btn code-rate-bad" onclick="rateCodeBad(\''+gid+'\',this)"><i class="fas fa-thumbs-down"></i></button>'
    + '</div></div>';
  overlay.addEventListener('click', (e)=>{ if (e.target === overlay) closeCodeModal(gid); });
  document.body.appendChild(overlay);
  if (window.hljs){ overlay.querySelectorAll('pre code').forEach(b=> hljs.highlightElement(b)); }
};
window.closeCodeModal = function(gid){
  const overlay = document.querySelector('.code-modal-overlay[data-gid="'+gid+'"]');
  if (overlay) overlay.remove();
};
window.copyCodeFile = function(gid, btnEl){
  const code = window.__codeGroups[gid];
  if (!code || !navigator.clipboard) return;
  navigator.clipboard.writeText(code).then(()=>{
    const icon = btnEl.querySelector('i');
    icon.className = 'fas fa-check';
    setTimeout(()=>{ icon.className = 'fas fa-copy'; }, 1200);
  });
};
window.downloadCodeFile = function(gid, filename){
  const code = window.__codeGroups[gid];
  if (!code) return;
  const blob = new Blob([code], { type:'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
};

// ── تقييم الكود نفسه (منفصل عن تقييم الرد بالكامل) — بيغذي "دروس كود" دائمة ──
let goodCodeList = [], badCodeList = [];
ownDb.collection("ai_code_feedback").where("liked","==",true).orderBy("createdAt","desc").limit(6)
  .onSnapshot(snap => { goodCodeList = snap.docs.map(d=>d.data()); }, err => console.warn("good code feed err", err));
ownDb.collection("ai_code_feedback").where("liked","==",false).orderBy("createdAt","desc").limit(6)
  .onSnapshot(snap => { badCodeList = snap.docs.map(d=>d.data()); }, err => console.warn("bad code feed err", err));

window.rateCodeGood = function(gid, btnEl){
  const code = window.__codeGroups[gid];
  if (!code) return;
  const bar = btnEl.closest('.code-rate-bar');
  bar.querySelectorAll('.code-rate-btn').forEach(b=>b.classList.remove('active'));
  btnEl.classList.add('active');
  ownDb.collection("ai_code_feedback").add({
    userId: (currentUser && currentUser.uid) || null,
    code: code.slice(0,1500), liked: true,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(e=>console.error(e));
};
window.rateCodeBad = function(gid, btnEl){
  const code = window.__codeGroups[gid];
  if (!code) return;
  const bar = btnEl.closest('.code-rate-bar');
  bar.querySelectorAll('.code-rate-btn').forEach(b=>b.classList.remove('active'));
  btnEl.classList.add('active');
  ownDb.collection("ai_code_feedback").add({
    userId: (currentUser && currentUser.uid) || null,
    code: code.slice(0,1500), liked: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(e=>console.error(e));
};
function buildGoodCodeBlock(){
  if (!goodCodeList.length) return '';
  const list = goodCodeList.map(g => '```\n'+(g.code||'').slice(0,300)+'\n```').join('\n');
  return '\n\n--- أمثلة كود سابقة عجبت المستخدمين وقيّموها 👍 (حافظ على نفس الأسلوب والجودة) ---\n' + list + '\n---';
}
function buildBadCodeBlock(){
  if (!badCodeList.length) return '';
  const list = badCodeList.map(b => '```\n'+(b.code||'').slice(0,300)+'\n```').join('\n');
  return '\n\n--- أمثلة كود سابقة اتقيّمت سلبيًا 👎 (تجنب نفس الأسلوب ده) ---\n' + list + '\n---';
}

function buildLessonsBlock(){
  if (!lessonsList.length) return '';
  const list = lessonsList.map(l => '- سؤال: ' + (l.question||'') + '\n  رد اتقيّم سلبيًا: ' + (l.answer||'').slice(0,300)).join('\n');
  return '\n\n--- دروس مستفادة من تقييمات سابقة (تعلّم منها ولا تكرر نفس القصور) ---\n' + list +
    '\n---\nلو جالك سؤال شبيه بأي واحد من دول، خد بالك وحاول تجاوب بشكل أعمق وأدق ووضح من المرة اللي فاتت.';
}
function buildGoodAnswersBlock(){
  if (!goodAnswersList.length) return '';
  const list = goodAnswersList.map(g => '- سؤال: ' + (g.question||'') + '\n  رد عجب المستخدم: ' + (g.answer||'').slice(0,300)).join('\n');
  return '\n\n--- ردود سابقة عجبت المستخدمين وقيّموها 👍 (حافظ على نفس أسلوبها ومستوى وضوحها) ---\n' + list +
    '\n---\nخد بالك من الأسلوب والمستوى اللي عجب المستخدمين في الردود دي، وحاول تحافظ عليه أو تتخطاه.';
}

/* ============ تجميع "تعليمات النظام" الكاملة — دالة واحدة بتلزّق كل البلوكات فوق بعض ============
   كل بلوك (buildXBlock) مسؤول عن قاعدة واحدة بس (هوية، تفكير عميق، تلوين،
   جودة كود، دروس مستفادة...) والدالة دي بترتبهم بترتيب ثابت وواحد لكل رسالة:
   1) الهوية الأساسية  2) السياق الحي (وقت/موقع/صلاة)  3) غرفة التفكير العميق
   4) قواعد التلوين واللاتكس والكود  5) الدروس والردود الحلوة القديمة
   6) نتائج البحث (لو موجودة، بتتحط في الآخر عشان تبقى أقرب حاجة للسؤال)
   7) تعليمات إضافية من لوحة التحكم (globalAiInstructions). ترتيبهم مقصود:
   القواعد الثابتة الأول، والسياق اللي بيتغيّر كل رسالة (بحث/تعليمات إدارية) آخر حاجة. */
function buildSystemPrompt(searchResultsBlock){
  return 'اسمك "' + AI_DISPLAY_NAME + '". جاوب بالعربية بوضوح واحترافية. لو حد سألك مين انت، قول إنك مساعد ذكاء اصطناعي بس، من غير ما تحدد اسم شركة أو موديل معيّن (لأن الردود بتتوزّع تلقائيًا على أكتر من نموذج في الخلفية). ممنوع تقول إنك Claude أو ChatGPT أو أي هوية مختلفة عن دي.'
    + buildLiveContextBlock()
    + buildReasoningRoomBlock()
    + buildColorPolicyBlock()
    + buildNoRawLatexBlock()
    + buildCodeCompletenessBlock()
    + buildProCodeQualityBlock()
    + buildLessonsBlock()
    + buildGoodAnswersBlock()
    + buildGoodCodeBlock()
    + buildBadCodeBlock()
    + (searchResultsBlock || '')
    + (globalAiInstructions ? ('\n\nتعليمات إضافية:\n' + globalAiInstructions) : '');
}

/* ============ الوقت / التاريخ / الهجري / مواعيد الصلاة / اتجاه القبلة (حقيقي، لحظي) ============
   بيانات الساعة والتاريخ بتتحسب محليًا (Intl) من غير أي نت. بيانات الموقع ومواعيد
   الصلاة واتجاه القبلة بتتجاب مرة واحدة في اليوم (لأول رسالة) عن طريق موقع
   المتصفح الجغرافي + Aladhan API (مواعيد الصلاة + التاريخ الهجري الدقيق + اتجاه
   القبلة) + BigDataCloud (اسم المدينة/الدولة) — كلها من غير أي مفتاح API. */
let geoState = { status:'idle', lat:null, lng:null, locationName:'', timings:null, hijriApi:null, qiblaDeg:null, qiblaCompass:null, fetchedDay:null };

function requestGeolocation(){
  return new Promise((resolve)=>{
    if (!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      ()  => resolve(null),
      { enableHighAccuracy:false, timeout:8000, maximumAge:600000 }
    );
  });
}

function bearingToCompass(deg){
  const dirs = ['شمال','شمال شرقي','شرق','جنوب شرقي','جنوب','جنوب غربي','غرب','شمال غربي'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return dirs[idx];
}

// ── بتتجاب مرة واحدة في اليوم بس (كاش بـ fetchedDay)، وبتفشل بهدوء لو المستخدم رفض إذن الموقع ──
async function refreshGeoContext(){
  const todayKey = new Date().toDateString();
  if (geoState.fetchedDay === todayKey && geoState.timings) return;
  if (geoState.status === 'denied' && geoState.fetchedDay === todayKey) return;

  const loc = await requestGeolocation();
  if (!loc){ geoState.status = 'denied'; geoState.fetchedDay = todayKey; return; }

  geoState.lat = loc.lat; geoState.lng = loc.lng; geoState.status = 'ok';
  try{
    const [geoRes, prayerRes, qiblaRes] = await Promise.all([
      fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude='+loc.lat+'&longitude='+loc.lng+'&localityLanguage=ar').then(r=>r.json()).catch(()=>null),
      fetch('https://api.aladhan.com/v1/timings/'+Math.floor(Date.now()/1000)+'?latitude='+loc.lat+'&longitude='+loc.lng+'&method=5').then(r=>r.json()).catch(()=>null),
      fetch('https://api.aladhan.com/v1/qibla/'+loc.lat+'/'+loc.lng).then(r=>r.json()).catch(()=>null)
    ]);
    if (geoRes){
      geoState.locationName = [geoRes.city || geoRes.locality, geoRes.principalSubdivision, geoRes.countryName].filter(Boolean).join('، ');
    }
    if (prayerRes && prayerRes.data){
      geoState.timings = prayerRes.data.timings;
      geoState.hijriApi = prayerRes.data.date && prayerRes.data.date.hijri;
    }
    if (qiblaRes && qiblaRes.data && typeof qiblaRes.data.direction === 'number'){
      geoState.qiblaDeg = qiblaRes.data.direction;
      geoState.qiblaCompass = bearingToCompass(qiblaRes.data.direction);
    }
    geoState.fetchedDay = todayKey;
  } catch(e){ console.warn('refreshGeoContext failed', e); }
}

// ── الساعة والتاريخ (ميلادي + هجري تقريبي) بيتحسبوا محليًا من غير نت، فبيبقوا جاهزين فورًا ──
function getLiveClockBlock(){
  const now = new Date();
  let weekdayAr = '', dateAr = '', timeAr = '', hijriAr = '';
  try{ weekdayAr = new Intl.DateTimeFormat('ar-EG', { weekday:'long' }).format(now); } catch(e){}
  try{ dateAr = new Intl.DateTimeFormat('ar-EG', { day:'numeric', month:'long', year:'numeric' }).format(now); } catch(e){}
  try{ timeAr = new Intl.DateTimeFormat('ar-EG', { hour:'numeric', minute:'2-digit', hour12:true }).format(now); } catch(e){}
  try{ hijriAr = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { day:'numeric', month:'long', year:'numeric' }).format(now); } catch(e){}
  return { weekdayAr, dateAr, timeAr, hijriAr };
}

function buildLiveContextBlock(){
  const c = getLiveClockBlock();
  let block = '\n\n--- الوقت والتاريخ الحاليين (بيانات حقيقية دلوقتي، اعتمد عليها دايمًا ولو مختلفة عن أي معلومة عندك من قبل) ---\n'
    + 'اليوم: ' + c.weekdayAr + '\n'
    + 'التاريخ الميلادي: ' + c.dateAr + '\n'
    + 'الساعة الحالية (بتوقيت جهاز المستخدم): ' + c.timeAr + '\n'
    + (c.hijriAr ? ('التاريخ الهجري (تقريبي): ' + c.hijriAr + '\n') : '');

  if (geoState.locationName) block += 'موقع المستخدم الحالي: ' + geoState.locationName + '\n';
  if (geoState.hijriApi && geoState.hijriApi.month){
    block += 'التاريخ الهجري الدقيق حسب موقع المستخدم: ' + geoState.hijriApi.day + ' ' + geoState.hijriApi.month.ar + ' ' + geoState.hijriApi.year + 'هـ\n';
  }
  if (geoState.timings){
    const t = geoState.timings;
    block += 'مواعيد الصلاة اليوم في موقع المستخدم: الفجر ' + t.Fajr + '، الشروق ' + t.Sunrise + '، الظهر ' + t.Dhuhr + '، العصر ' + t.Asr + '، المغرب ' + t.Maghrib + '، العشاء ' + t.Isha + '\n';
  }
  if (geoState.qiblaCompass){
    block += 'اتجاه القبلة من موقع المستخدم: ' + geoState.qiblaCompass + ' (بزاوية تقريبية ' + Math.round(geoState.qiblaDeg) + '° من الشمال)\n';
  }
  if (geoState.status === 'denied'){
    block += 'ملحوظة: المستخدم مسموحش (أو لسه) بالوصول لموقعه الجغرافي، فمعرفتش أجيب مواعيد الصلاة أو اتجاه القبلة أو اسم مدينته بالظبط — لو سأل عن حاجة من دي، قوله يسمح بإذن الموقع من المتصفح.\n';
  }
  block += '---';
  return block;
}

/* ============ البحث الحقيقي في الإنترنت عبر Tavily (نفس فلك بالظبط) ============ */
function getTavilyApiKey(){ return (tavilyApiKey && String(tavilyApiKey).trim()) || ""; }

async function performWebSearch(query, includeDomains){
  const key = getTavilyApiKey();
  if (!key) return null;
  try{
    const body = {
      api_key: key,
      query: query,
      search_depth: 'advanced',
      max_results: 5,
      include_answer: false,
      include_images: true,
      include_image_descriptions: true
    };
    if (includeDomains && includeDomains.length) body.include_domains = includeDomains;
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) return null;
    return await r.json();
  } catch(e){ console.warn('performWebSearch failed', e); return null; }
}

/* ============ قرار "هل الرسالة محتاجة بحث؟" — مرحلتين، بنفس فكرة النظام التلقائي للموديلات ============
   المرحلة 1 (سريعة، من غير أي طلب شبكة): لو الرسالة فيها كلمة صريحة من
   WEB_SEARCH_TRIGGERS (زي "ابحث" أو "اخر اخبار")، القرار بيبقى "أيوه محتاجة
   بحث" فورًا من غير أي تأخير.
   المرحلة 2 (لو المرحلة 1 مقالتش حاجة): بنسأل نموذج صغير وسريع (Groq) يحكم
   هو نفسه بكلمة واحدة بس ("نعم"/"لا") هل الرسالة محتاجة معلومة حديثة أو
   حدث حالي، عشان نمسك الحالات اللي مفيهاش كلمة مفتاحية واضحة لكنها فعليًا
   محتاجة بحث (زي "مين رئيس وزراء بريطانيا؟" من غير ما يقول "ابحث"). */
// ── مرحلة أولى سريعة: كلمات صريحة بتدل على طلب بحث (رد فوري من غير انتظار) ──
const WEB_SEARCH_TRIGGERS = [
  'ابحث', 'دور لي', 'دور على', 'فتش', 'اخبار', 'أخبار', 'اخر اخبار', 'آخر أخبار',
  'احدث', 'أحدث', 'صحيح ان', 'صحيح إن', 'هل صحيح', 'اتأكد', 'تأكد من',
  'معلومات عن', 'ايه اخبار', 'إيه أخبار', 'اخر حاجة', 'جديد في',
  'اخر ', 'آخر ', 'اخره', 'آخره', 'امتى', 'إمتى', 'متى', 'حاليا', 'حاليًا',
  'دلوقتي', 'الان', 'الآن', 'لسه', 'لسة', 'اخر مرة', 'آخر مرة', 'اخر تحديث', 'آخر تحديث'
];
function shouldWebSearch(t){
  if (!t) return false;
  const l = String(t).toLowerCase();
  return WEB_SEARCH_TRIGGERS.some(k => l.includes(k));
}

// ── مرحلة تانية ذكية: لو مفيش كلمة صريحة، الذكاء الاصطناعي نفسه بيقرر ──
async function classifyNeedsSearch(userMsg){
  try{
    const apiKey = GroqKeyPool.next();
    if (!apiKey || !userMsg || userMsg.trim().length < 4) return false;
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        max_tokens: 3,
        temperature: 0,
        messages: [
          { role: 'system', content: 'رد بكلمة واحدة بس: "نعم" لو الرسالة محتاجة معلومة حديثة/حقيقية أو حدث حالي أو حاجة لازم تتأكد منها من الإنترنت (زي أخبار، أسعار، تواريخ قريبة، أسماء أشخاص أو شركات أو منتجات حالية، نتائج، إحصائيات، حاجة بتتغيّر بمرور الوقت). أو رد "لا" لو مجرد كلام عادي، تحية، سؤال عن مفهوم علمي/تاريخي ثابت، طلب مساعدة عامة، أو طلب برمجة/كود. رد بكلمة واحدة بس من غير أي شرح.' },
          { role: 'user', content: userMsg }
        ]
      })
    });
    if (!r.ok) return false;
    const d = await r.json();
    const ans = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    return /نعم|yes/i.test(ans.trim());
  } catch(e){ console.warn('classifyNeedsSearch failed', e); return false; }
}

// ── لو المستخدم بعت رابط صريح، بندخله فعليًا عبر Tavily Extract (مش بحث، قراءة رابط بعينه) ──
const URL_REGEX = /(https?:\/\/[^\s<>"')]+)/g;
function extractFirstUrl(text){
  if (!text) return null;
  const m = String(text).match(URL_REGEX);
  return m && m[0] ? m[0] : null;
}
async function performUrlExtract(url){
  const key = getTavilyApiKey();
  if (!key) return null;
  try{
    const r = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, urls: [url] })
    });
    if (!r.ok) return null;
    const d = await r.json();
    const item = d && d.results && d.results[0];
    return item ? { url: item.url || url, content: item.raw_content || '' } : null;
  } catch(e){ console.warn('performUrlExtract failed', e); return null; }
}
function buildUrlContentBlock(extracted){
  if (!extracted || !extracted.content) return '';
  return '\n\n--- محتوى الرابط اللي بعته المستخدم (' + extracted.url + ') — استخدمه في ردك ---\n' +
    extracted.content.slice(0, 6000) + '\n---';
}

function buildSearchResultsBlock(results){
  if (!results || !results.results || !results.results.length) return '';
  const list = results.results.slice(0,5).map((r,i) => (i+1)+'. '+(r.title||'')+'\n   '+(r.url||'')+'\n   '+(r.content||'').slice(0,300)).join('\n');
  return '\n\n--- نتائج بحث حقيقية من الإنترنت الآن (استخدمها في ردك، وممنوع تتجاهلها أو تجاوب من معلوماتك العامة القديمة لو فيها تعارض) ---\n' + list + '\n---';
}

/* ============ خط الدفاع 1: Groq — Streaming + غرفة التفكير العميق الحية ============
   لو الرد اتقطع قبل ما يخلص (finish_reason === 'length' — بيحصل غالبًا مع أكواد
   طويلة)، بنكمّل تلقائيًا بطلب تاني من نفس النقطة، لحد ما يخلص فعلاً أو نوصل
   للحد الأقصى من المحاولات، بدل ما نسيب الكود مبتور. */
const CONTINUE_PROMPT = 'كمل بالظبط من نفس الحرف اللي وقفت عنده، من غير ما تعيد ولا حرف كتبته قبل كده، ومن غير أي مقدمة أو تعليق زيادة. لو كنت في نص كود، كمل الكود نفسه لحد ما يخلص ويتقفل بـ ``` — ممنوع تلخيص أو اختصار أي جزء.';
const MAX_CONTINUATIONS = 5;

async function callGroqChat(historyMsgs, onReasoningDelta, searchResultsBlock, onContentDelta){
  if (!GroqKeyPool.count()) return null;
  const maxAttempts = Math.min(GroqKeyPool.count(), 3);
  const sys = buildSystemPrompt(searchResultsBlock || '');
  let runningMessages = [{ role:'system', content: sys }].concat(historyMsgs);
  let fullTotal = '', fullReasoning = '';

  for (let round = 0; round <= MAX_CONTINUATIONS; round++){
    let roundResult = null;
    for (let i=0;i<maxAttempts;i++){
      const key = GroqKeyPool.next();
      if (!key) break;
      try{
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-oss-120b", messages: runningMessages, max_tokens: 8192, temperature: 0.4,
            stream: true, reasoning_effort: 'high', reasoning_format: 'parsed'
          })
        });
        if (!res.ok || !res.body){
          GroqKeyPool.report(key, res.status !== 429);
          if (res.status !== 429) { i = maxAttempts; break; }
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', full = '', reasoningPart = '', finishReason = null;
        while (true){
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines){
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try{
              const evt = JSON.parse(payload);
              const choice = evt.choices && evt.choices[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta;
              if (!delta) continue;
              if (delta.content){ full += delta.content; if (onContentDelta) onContentDelta(fullTotal + full); }
              const rPiece = delta.reasoning || delta.reasoning_content;
              if (rPiece){ reasoningPart += rPiece; if (onReasoningDelta) onReasoningDelta(fullReasoning + reasoningPart); }
            } catch(e){ /* سطر ناقص، هيكمل في القراءة الجاية */ }
          }
        }
        GroqKeyPool.report(key, true);
        roundResult = { text: full, reasoning: reasoningPart, finishReason };
        break;
      } catch(e){ console.warn("Groq call failed", e); GroqKeyPool.report(key, false); }
    }
    if (!roundResult || !roundResult.text) break;
    fullTotal += roundResult.text;
    fullReasoning = round === 0 ? roundResult.reasoning : (fullReasoning + '\n' + roundResult.reasoning);
    if (roundResult.finishReason !== 'length' || round === MAX_CONTINUATIONS) break;
    runningMessages = runningMessages.concat([
      { role:'assistant', content: roundResult.text },
      { role:'user', content: CONTINUE_PROMPT }
    ]);
  }
  return fullTotal ? { text: fullTotal, reasoning: fullReasoning } : null;
}

/* ============ خط الدفاع 2: Gemini ============ */
async function callGeminiChat(historyMsgs){
  if (!GeminiKeyPool.count()) return null;
  const maxAttempts = Math.min(GeminiKeyPool.count(), 3);
  let contents = historyMsgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  let fullTotal = '';

  for (let round = 0; round <= MAX_CONTINUATIONS; round++){
    let roundText = null, roundFinish = null;
    for (let i=0;i<maxAttempts;i++){
      const key = GeminiKeyPool.next();
      if (!key) break;
      try{
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: buildSystemPrompt() }] }, generationConfig: { temperature: 0.4, maxOutputTokens: 8192 } })
        });
        const data = await res.json();
        const cand = data && data.candidates && data.candidates[0];
        const txt = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
        GeminiKeyPool.report(key, res.status !== 429);
        if (txt){ roundText = txt; roundFinish = cand.finishReason || null; break; }
        if (res.status !== 429) { i = maxAttempts; break; }
      } catch(e){ console.warn("Gemini call failed", e); }
    }
    if (!roundText) break;
    fullTotal += roundText;
    if (roundFinish !== 'MAX_TOKENS' || round === MAX_CONTINUATIONS) break;
    contents = contents.concat([
      { role:'model', parts:[{ text: roundText }] },
      { role:'user', parts:[{ text: CONTINUE_PROMPT }] }
    ]);
  }
  return fullTotal ? { text: fullTotal, reasoning: '' } : null;
}

/* ============ خط الدفاع 3: OpenRouter (موديلات مجانية) ============ */
let orFreeModelsCache = { list: [], key: null, at: 0 };
async function getFreeOpenRouterModels(key){
  if (orFreeModelsCache.key === key && orFreeModelsCache.list.length && (Date.now()-orFreeModelsCache.at) < 1800000) return orFreeModelsCache.list;
  try{
    const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { "Authorization": "Bearer " + key } });
    const d = await r.json();
    const list = (d && d.data ? d.data : []).filter(m => m && m.pricing && Number(m.pricing.prompt)===0 && Number(m.pricing.completion)===0).map(m=>m.id).slice(0,3);
    if (list.length){ orFreeModelsCache = { list, key, at: Date.now() }; return list; }
    return [];
  } catch(e){ return []; }
}
async function callOpenRouterChat(historyMsgs){
  if (!OpenRouterKeyPool.count()) return null;
  const baseMessages = [{ role:'system', content: buildSystemPrompt() }].concat(historyMsgs);
  const maxAttempts = Math.min(OpenRouterKeyPool.count(), 3);
  for (let i=0;i<maxAttempts;i++){
    const key = OpenRouterKeyPool.next();
    if (!key) break;
    let models = await getFreeOpenRouterModels(key);
    if (!models.length) models = ['meta-llama/llama-3.3-70b-instruct:free','mistralai/mistral-7b-instruct:free','google/gemma-2-9b-it:free'];
    let keyFailed429 = false;
    for (const model of models){
      try{
        let messages = baseMessages.slice();
        let fullTotal = '';
        for (let round = 0; round <= MAX_CONTINUATIONS; round++){
          const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "Mahfoozat" },
            body: JSON.stringify({ model, messages, max_tokens: 8192, temperature: 0.4 })
          });
          const d = await r.json();
          const choice = d && d.choices && d.choices[0];
          const txt = choice && choice.message && choice.message.content;
          OpenRouterKeyPool.report(key, r.status !== 429);
          if (!txt){ if (r.status === 429) keyFailed429 = true; break; }
          fullTotal += txt;
          if (choice.finish_reason !== 'length' || round === MAX_CONTINUATIONS) break;
          messages = messages.concat([
            { role:'assistant', content: txt },
            { role:'user', content: CONTINUE_PROMPT }
          ]);
        }
        if (fullTotal) return { text: fullTotal, reasoning: '' };
      } catch(e){ console.warn("OpenRouter call failed", e); }
    }
    if (!keyFailed429) break;
  }
  return null;
}

/* ============ خط الدفاع 4: Vercel AI Gateway ============ */
async function callVercelChat(historyMsgs){
  if (!VercelGatewayKeyPool.count()) return null;
  const baseMessages = [{ role:'system', content: buildSystemPrompt() }].concat(historyMsgs);
  const models = ['openai/gpt-4o-mini','google/gemini-2.0-flash','anthropic/claude-haiku-4-5'];
  const maxAttempts = Math.min(VercelGatewayKeyPool.count(), 3);
  for (let i=0;i<maxAttempts;i++){
    const key = VercelGatewayKeyPool.next();
    if (!key) break;
    let keyFailed429 = false;
    for (const model of models){
      try{
        let messages = baseMessages.slice();
        let fullTotal = '';
        for (let round = 0; round <= MAX_CONTINUATIONS; round++){
          const r = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages, max_tokens: 8192, temperature: 0.4, stream: false })
          });
          const d = await r.json();
          const choice = d && d.choices && d.choices[0];
          const txt = choice && choice.message && choice.message.content;
          VercelGatewayKeyPool.report(key, r.status !== 429);
          if (!txt){ if (r.status === 429) keyFailed429 = true; break; }
          fullTotal += txt;
          if (choice.finish_reason !== 'length' || round === MAX_CONTINUATIONS) break;
          messages = messages.concat([
            { role:'assistant', content: txt },
            { role:'user', content: CONTINUE_PROMPT }
          ]);
        }
        if (fullTotal) return { text: fullTotal, reasoning: '' };
      } catch(e){ console.warn("Vercel Gateway call failed", e); }
    }
    if (!keyFailed429) break;
  }
  return null;
}

/* ============ الموزّع الرئيسي: بحث عبر الإنترنت لو محتاج، بعدين يجرب كل خط دفاع بالترتيب ============
   onStep(text) بتتنادى عند كل خطوة حقيقية بتحصل هنا، عشان تتعرض للمستخدم
   لحظة بلحظة في مؤشر "بيشتغل دلوقتي" (مش نصوص وهمية — دي هي نفس الخطوات
   اللي الكود فعلاً بيمر بيها). */
async function getAIResponse(messageHistory, onReasoningDelta, onStep, onContentDelta){
  const lastUserText = (messageHistory[messageHistory.length-1] && messageHistory[messageHistory.length-1].text) || '';
  const messages = messageHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
  const step = (text)=>{ if (onStep) onStep(text); };

  let searchResultsBlock = '';
  const tavilyReady = !!getTavilyApiKey();

  // ── لو المستخدم بعت رابط صريح، ندخله ونقرا محتواه فعليًا بدل ما نعمل بحث عام ──
  const explicitUrl = extractFirstUrl(lastUserText);
  if (tavilyReady && explicitUrl){
    step('بيفتح الرابط اللي بعته ويقرا محتواه...');
    const extracted = await performUrlExtract(explicitUrl);
    searchResultsBlock = buildUrlContentBlock(extracted);
  }

  // ── قرار البحث العام: كلمة صريحة الأول، وإلا نسأل الموديل نفسه (لو مفيش رابط اتقرا فعلاً) ──
  if (tavilyReady && !searchResultsBlock){
    const explicitNeed = shouldWebSearch(lastUserText);
    let needsSearch = explicitNeed;
    if (!needsSearch){
      step('بيقرر لو الرسالة محتاجة بحث في الإنترنت ولا لأ...');
      needsSearch = await classifyNeedsSearch(lastUserText);
    }
    if (needsSearch){
      step('بيبحث في الإنترنت 🔎...');
      const results = await performWebSearch(lastUserText);
      searchResultsBlock = buildSearchResultsBlock(results);
    }
  }

  const providers = [
    { id:'groq', label:'Groq', fn: (msgs)=>callGroqChat(msgs, onReasoningDelta, searchResultsBlock, onContentDelta) },
    { id:'gemini', label:'Gemini', fn: callGeminiChat },
    { id:'openrouter', label:'OpenRouter', fn: callOpenRouterChat },
    { id:'vercel', label:'Vercel Gateway', fn: callVercelChat }
  ];
  // النظام تلقائي دايمًا (مفيش اختيار يدوي لموديل)، فبنجرب المزوّدين بالترتيب
  // الافتراضي زي ما هو، وكل محاولة بتتعرض كخطوة حقيقية للمستخدم أول ما تبدأ.
  for (const p of providers){
    step('بيجهّز الرد عن طريق ' + p.label + '...');
    const result = await p.fn(messages);
    if (result && result.text) return { text: result.text, reasoning: result.reasoning || '', provider: p.label };
    step(p.label + ' مردّش، بيجرب مزوّد تاني...');
  }

  if (!GroqKeyPool.count() && !GeminiKeyPool.count() && !OpenRouterKeyPool.count() && !VercelGatewayKeyPool.count()){
    return { text: "لسه بجيب مفاتيح الذكاء الاصطناعي... جرب تاني بعد ثانية.", provider: null, reasoning: '' };
  }
  throw new Error("كل مزوّدي الذكاء الاصطناعي فشلوا");
}

/* ============ تحليل الصور عبر Gemini Vision (زي فلك بالظبط) ============
   التدفق: 1) compressImage بتصغّر أي صورة لحد 900px وتضغطها jpeg 0.6 قبل
   أي حاجة تانية (تخزين أو إرسال) عشان الرسالة تفضل خفيفة. 2) الصور
   المضغوطة بتتحول لـ base64 وتتبعت لـ Gemini Vision مع نص السؤال (لو
   موجود) في analyzeImagesWithGemini، وبيرجع وصف/تحليل نصي للصور. */
// بنضغط الصورة (max 900px, jpeg 0.6) قبل الإرسال والتخزين، عشان الرسالة تفضل خفيفة في قاعدة البيانات
function compressImage(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.onload = () => {
      const scale = Math.min(1, 900 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    }; img.onerror = reject; img.src = reader.result; };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function analyzeImagesWithGemini(dataUrls, promptText){
  if (!GeminiKeyPool.count()){
    return "لسه مفيش مفتاح Gemini متسجل على فلك، فمقدرش أحلل الصور دلوقتي.";
  }
  const list = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
  const imageParts = list.map(dataUrl=>{
    const commaIdx = dataUrl.indexOf(',');
    const base64Data = commaIdx > -1 ? dataUrl.slice(commaIdx+1) : dataUrl;
    const mimeMatch = /^data:([^;]+);base64/.exec(dataUrl);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    return { inline_data: { mime_type: mimeType, data: base64Data } };
  });
  const fullPrompt = (promptText || (list.length > 1 ? 'صف الصور دي بالتفصيل باللغة العربية.' : 'صف هذه الصورة بالتفصيل باللغة العربية.')) +
    '\n\nجاوب بأسلوب احترافي منظم بنقاط عند الحاجة، من غير ماركداون خام زي ### أو --- أو جداول |.';
  const parts = [{ text: fullPrompt }].concat(imageParts);
  const maxAttempts = Math.min(GeminiKeyPool.count(), 3);
  for (let i=0;i<maxAttempts;i++){
    const key = GeminiKeyPool.next();
    if (!key) break;
    try{
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts }] })
      });
      const data = await res.json();
      const txt = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      GeminiKeyPool.report(key, res.status !== 429);
      if (txt) return txt;
      if (res.status !== 429) break;
    } catch(e){ console.warn("Gemini vision failed", e); }
  }
  return "عذراً، مقدرتش أحلل الصورة دلوقتي.";
}

/* ============ STATE ============ */
let currentUser = null;
let currentConvId = null;
let conversationsRef = null;
// ── ممكن تتراكم أكتر من مرفق مع بعض (صور و/أو ملفات)، كل واحد بصندوقه الخاص جنب التاني ──
let pendingAttachments = []; // [{ id, type:'image'|'file', dataUrl?, name, kind, note, extractedText, processing }]
let attachSeq = 0;

/* ============ قراءة/تحليل الملفات المرفقة (PDF / Word / Excel / صوت / ZIP / نصوص) ============
   كل دالة بترجع نص مستخرج من الملف، وده بيتحط جوه رسالة المستخدم كـ"سياق" يتقرا
   للذكاء الاصطناعي بس (من غير ما يتكدّس جوه فقاعة الرسالة اللي بتتعرض للمستخدم). */
const MAX_FILE_CONTEXT_CHARS = 18000;

const TEXT_EXTENSIONS = /\.(txt|md|json|csv|js|ts|jsx|tsx|py|java|c|cpp|h|cs|php|rb|go|rs|sql|sh|yaml|yml|xml|html|css|log)$/i;

/* ============ نظام معالجة المرفقات — فرز وتوجيه تلقائي، بنفس فكرة النظام التلقائي للموديلات بالظبط ============
   زي ما نظام الموديلات بيجرب المزوّدين بالترتيب من غير ما المستخدم يختار،
   نظام المرفقات ده بيكتشف نوع الملف تلقائيًا وبيوجّهه لأداة القراءة
   المناسبة له، من غير أي تدخل يدوي:
   1) getFileKind(file) — "الحكم": بيبص على امتداد الاسم ونوع MIME ويرجّع
      كلمة وحدة تصف نوع الملف (image/audio/pdf/docx/excel/zip/text/other).
   2) لكل نوع، فيه دالة استخراج مخصصة له بس (single responsibility):
      - extractPdfText   → PDF عن طريق pdf.js
      - extractDocxText  → Word عن طريق mammoth.js
      - extractExcelText → Excel/CSV عن طريق SheetJS، شيت شيت
      - transcribeAudio  → صوت عن طريق Groq Whisper (بيرجع نص التفريغ)
      - readZipFile      → ملف مضغوط، إما بيفكه ويقرا كل ملف نصي جواه أو
        بيسيبه مقفول وبيرجّع بس قائمة أسماء الملفات (حسب opts.extractZip)
      - readFileAsText   → أي ملف نصي/كود عادي مباشرة
   3) processAttachedFile(file, opts) — "الموزّع الرئيسي": بيستدعي
      getFileKind أول حاجة، وعلى حسب النتيجة بيستدعي دالة الاستخراج
      الصح، وبيرجّع شكل موحّد { kind, name, extractedText, note } جاهز
      إنه يتحط في سياق المحادثة للذكاء الاصطناعي، مهما كان نوع الملف. */
function getFileKind(file){
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|flac|aac)$/i.test(name)) return 'audio';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx') || type.includes('wordprocessingml')) return 'docx';
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || type.includes('spreadsheetml')) return 'excel';
  if (name.endsWith('.zip') || type === 'application/zip' || type === 'application/x-zip-compressed') return 'zip';
  if (TEXT_EXTENSIONS.test(name) || type.startsWith('text/')) return 'text';
  return 'other';
}

function readFileAsText(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}
function readFileAsArrayBuffer(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}

async function extractPdfText(file){
  if (!window.pdfjsLib) throw new Error('مكتبة قراءة PDF مش محمّلة');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await readFileAsArrayBuffer(file);
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  const maxPages = Math.min(pdf.numPages, 40);
  for (let p=1; p<=maxPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(it=>it.str).join(' ') + '\n\n';
    if (text.length > MAX_FILE_CONTEXT_CHARS) break;
  }
  return text.trim();
}

async function extractDocxText(file){
  if (!window.mammoth) throw new Error('مكتبة قراءة Word مش محمّلة');
  const buf = await readFileAsArrayBuffer(file);
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return (result.value || '').trim();
}

async function extractExcelText(file){
  if (!window.XLSX) throw new Error('مكتبة قراءة Excel مش محمّلة');
  const buf = await readFileAsArrayBuffer(file);
  const wb = window.XLSX.read(buf, { type:'array' });
  let out = '';
  wb.SheetNames.forEach(sheetName=>{
    out += '--- شيت: ' + sheetName + ' ---\n';
    out += window.XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
    out += '\n\n';
  });
  return out.trim();
}

async function transcribeAudio(file){
  const key = GroqKeyPool.next();
  if (!key) throw new Error('مفيش مفتاح Groq متاح للتفريغ الصوتي دلوقتي');
  const form = new FormData();
  form.append('file', file);
  form.append('model', 'whisper-large-v3');
  form.append('language', 'ar');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key },
    body: form
  });
  GroqKeyPool.report(key, res.ok);
  if (!res.ok) throw new Error('فشل تفريغ الصوت');
  const data = await res.json();
  return (data.text || '').trim();
}

// ── ZIP: لو extract=true بنفك الضغط ونقرا كل ملف نصي جواه (بتخطي الملفات الثنائية/الكبيرة)،
//    ولو extract=false بنسيبه مضغوط ونكتفي بعرض قائمة الملفات اللي جواه للذكاء ──
async function readZipFile(file, extract){
  if (!window.JSZip) throw new Error('مكتبة ZIP مش محمّلة');
  const zip = await window.JSZip.loadAsync(file);
  const entries = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  if (!extract){
    return { note: 'ملف مضغوط (' + entries.length + ' ملف) — سايبه زي ما هو من غير فك ضغط. قائمة الملفات:\n- ' + entries.slice(0,50).join('\n- '), zipEntries: entries };
  }
  let out = 'محتوى الملفات داخل الأرشيف المضغوط (' + entries.length + ' ملف):\n\n';
  let used = 0;
  for (const name of entries){
    if (used > MAX_FILE_CONTEXT_CHARS) { out += '\n... (باقي الملفات اتقطعت عشان المساحة)'; break; }
    if (!TEXT_EXTENSIONS.test(name) && !/\.(pdf|docx?|xlsx?)$/i.test(name)){
      out += '📁 ' + name + ' (ملف ثنائي، متقروش نصيًا)\n';
      continue;
    }
    try{
      const content = await zip.files[name].async('string');
      const trimmed = content.slice(0, 3000);
      out += '--- ' + name + ' ---\n' + trimmed + '\n\n';
      used += trimmed.length;
    } catch(e){ out += '⚠️ مقدرتش أقرا ' + name + '\n'; }
  }
  return { note: out.trim(), zipEntries: entries };
}

// ── الموزّع الرئيسي: بياخد ملف ويرجع { kind, name, extractedText, note } جاهزة للإرفاق ──
async function processAttachedFile(file, opts){
  const kind = getFileKind(file);
  const result = { kind, name: file.name, extractedText: '', note: '' };
  if (kind === 'pdf'){
    result.extractedText = (await extractPdfText(file)).slice(0, MAX_FILE_CONTEXT_CHARS);
    result.note = 'ملف PDF (' + Math.round(file.size/1024) + ' كيلوبايت)';
  } else if (kind === 'docx'){
    result.extractedText = (await extractDocxText(file)).slice(0, MAX_FILE_CONTEXT_CHARS);
    result.note = 'ملف Word';
  } else if (kind === 'excel'){
    result.extractedText = (await extractExcelText(file)).slice(0, MAX_FILE_CONTEXT_CHARS);
    result.note = 'ملف Excel';
  } else if (kind === 'audio'){
    result.extractedText = await transcribeAudio(file);
    result.note = 'ملف صوتي (تم تفريغه لنص)';
  } else if (kind === 'zip'){
    const zr = await readZipFile(file, !!(opts && opts.extractZip));
    result.extractedText = zr.note;
    result.note = (opts && opts.extractZip) ? 'ملف مضغوط (اتفك وقُريت محتوياته)' : 'ملف مضغوط (سايبه زي ما هو)';
  } else if (kind === 'text'){
    result.extractedText = (await readFileAsText(file)).slice(0, MAX_FILE_CONTEXT_CHARS);
    result.note = 'ملف نصي/كود';
  } else {
    result.note = 'ملف (' + (file.type || 'نوع غير معروف') + ') — متقروش محتواه نصيًا، بس اسمه اتبعت للذكاء';
  }
  return result;
}

/* ============ ELEMENTS ============ */
const loadingScreen = document.getElementById('loading-screen');
const authScreen = document.getElementById('auth-screen');
const appShell = document.getElementById('app-shell');

const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const loginError = document.getElementById('login-error');
const signupError = document.getElementById('signup-error');

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const conversationList = document.getElementById('conversation-list');
const newChatBtn = document.getElementById('new-chat-btn');
const logoutBtn = document.getElementById('logout-btn');
const userNameLabel = document.getElementById('user-name-label');
const conversationTitle = document.getElementById('conversation-title');

const messagesEl = document.getElementById('messages');
// ── لو حد ضغط على رابط جوه رد الذكاء (.msg-link)، بنفتحه إحنا بأنفسنا عن طريق
//    window.open بدل ما نسيب المتصفح يقرر — بعض المتصفحات/التطبيقات المغلّفة
//    بتتجاهل target="_blank" بصمت لو الرابط كان جوه عنصر اتبنى ديناميكيًا
//    (زي أنيميشن الكتابة التدريجي هنا)، فده بيضمن إن الضغط دايمًا هيفتح الرابط ──
messagesEl.addEventListener('click', (e)=>{
  const link = e.target.closest('a.msg-link');
  if (!link) return;
  e.preventDefault();
  window.open(link.href, '_blank', 'noopener,noreferrer');
});
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');
const sendBtn = composer.querySelector('.send-btn');
const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
const attachPreview = document.getElementById('attach-preview');

/* ============ CONVERSATION CONTEXT MENU + MODALS ELEMENTS ============ */
const contextMenu = document.getElementById('conv-context-menu');
const contextMenuBackdrop = document.getElementById('context-menu-backdrop');
const renameModal = document.getElementById('rename-modal');
const renameForm = document.getElementById('rename-form');
const renameInput = document.getElementById('rename-input');
const renameCancelBtn = document.getElementById('rename-cancel-btn');
const deleteModal = document.getElementById('delete-modal');
const deleteModalText = document.getElementById('delete-modal-text');
const deleteCancelBtn = document.getElementById('delete-cancel-btn');
const deleteConfirmBtn = document.getElementById('delete-confirm-btn');

/* ============ AUTH TABS ============ */
tabLogin.addEventListener('click', ()=>{
  tabLogin.classList.add('active'); tabSignup.classList.remove('active');
  loginForm.style.display='flex'; signupForm.style.display='none';
});
tabSignup.addEventListener('click', ()=>{
  tabSignup.classList.add('active'); tabLogin.classList.remove('active');
  signupForm.style.display='flex'; loginForm.style.display='none';
});

/* ============ SIGNUP ============ */
signupForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  signupError.textContent='';
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const btn = signupForm.querySelector('.primary-btn');
  btn.disabled = true;
  try{
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name || email.split('@')[0] });
    await db.ref('users/'+cred.user.uid+'/profile').set({
      name: name || email.split('@')[0],
      email,
      createdAt: Date.now()
    });
    // onAuthStateChanged below handles the transition into the app.
  } catch(err){
    signupError.textContent = describeAuthError(err);
  } finally {
    btn.disabled = false;
  }
});

/* ============ LOGIN ============ */
loginForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  loginError.textContent='';
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = loginForm.querySelector('.primary-btn');
  btn.disabled = true;
  try{
    await auth.signInWithEmailAndPassword(email, password);
  } catch(err){
    loginError.textContent = describeAuthError(err);
  } finally {
    btn.disabled = false;
  }
});

function describeAuthError(err){
  const map = {
    'auth/email-already-in-use': 'البريد ده متسجل قبل كده.',
    'auth/invalid-email': 'صيغة البريد مش صح.',
    'auth/weak-password': 'كلمة المرور لازم تكون ٦ حروف على الأقل.',
    'auth/user-not-found': 'مفيش حساب بالبريد ده.',
    'auth/wrong-password': 'كلمة المرور غلط.',
    'auth/invalid-credential': 'البريد أو كلمة المرور غلط.',
    'auth/operation-not-allowed': 'تسجيل الدخول بالبريد وكلمة المرور مش مفعّل في المشروع.',
    'auth/unauthorized-domain': 'الدومين ده مش مُصرَّح له في إعدادات Firebase.'
  };
  return map[err.code] || 'حصل خطأ، جرب تاني.';
}

logoutBtn.addEventListener('click', ()=> auth.signOut());

/* ============ AUTH STATE ============ */
auth.onAuthStateChanged(user=>{
  loadingScreen.style.display='none';
  if(user){
    currentUser = user;
    userNameLabel.textContent = user.displayName || user.email;
    authScreen.style.display='none';
    appShell.style.display='flex';
    listenToConversations();
    refreshGeoContext(); // بيجيب الموقع/مواعيد الصلاة/القبلة في الخلفية، من غير ما يعطل حاجة
  } else {
    currentUser = null;
    currentConvId = null;
    if(conversationsRef) conversationsRef.off();
    authScreen.style.display='flex';
    appShell.style.display='none';
  }
});

/* ============ CONVERSATIONS ============ */
let conversationsCache = {};

function listenToConversations(){
  conversationsRef = db.ref('users/'+currentUser.uid+'/conversations');
  conversationsRef.on('value', snap=>{
    const data = snap.val() || {};
    conversationsCache = data;
    renderConversationList(data);
    const ids = Object.keys(data);
    if(!currentConvId && ids.length){
      openConversation(ids[ids.length-1]);
    } else if(!ids.length){
      startNewConversation();
    }
  });
}

function renderConversationList(data){
  conversationList.innerHTML='';
  const entries = Object.entries(data).sort((a,b)=> (b[1].updatedAt||0)-(a[1].updatedAt||0));
  for(const [id, conv] of entries){
    const title = conv.title || 'محادثة جديدة';
    const item = document.createElement('div');
    item.className = 'conv-item' + (id===currentConvId ? ' active' : '');
    item.dataset.convId = id;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'conv-item-title';
    titleSpan.textContent = title;
    item.appendChild(titleSpan);

    const kebabBtn = document.createElement('button');
    kebabBtn.type = 'button';
    kebabBtn.className = 'conv-kebab';
    kebabBtn.setAttribute('aria-label', 'خيارات المحادثة');
    kebabBtn.innerHTML = '<i class="fas fa-ellipsis-vertical"></i>';
    kebabBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      openContextMenu(id, (conversationsCache[id]||{}).title || 'محادثة جديدة', kebabBtn.getBoundingClientRect());
    });
    item.appendChild(kebabBtn);

    attachConvItemGestures(item, id);
    conversationList.appendChild(item);
  }
}

/* ============ LONG-PRESS / RIGHT-CLICK ON A CONVERSATION ITEM ============
   لمسة عادية = فتح المحادثة. ضغطة مطوّلة (أو زر يمين على الديسكتوب أو ضغط
   أيقونة الثلاث نقط) = تفتح قائمة صغيرة فيها "تعديل الاسم" و"حذف المحادثة". */
function attachConvItemGestures(item, id){
  const LONG_PRESS_MS = 450;
  const MOVE_TOLERANCE = 10;
  let timer = null, startX = 0, startY = 0, longPressed = false;

  function clearTimer(){ if(timer){ clearTimeout(timer); timer = null; } }
  function getTitle(){ return (conversationsCache[id]||{}).title || 'محادثة جديدة'; }

  item.addEventListener('touchstart', (e)=>{
    const t = e.touches && e.touches[0];
    if(!t) return;
    longPressed = false;
    startX = t.clientX; startY = t.clientY;
    clearTimer();
    item.classList.add('pressing');
    timer = setTimeout(()=>{
      longPressed = true;
      item.classList.remove('pressing');
      if(navigator.vibrate) navigator.vibrate(12);
      openContextMenu(id, getTitle(), item.getBoundingClientRect());
    }, LONG_PRESS_MS);
  }, {passive:true});

  item.addEventListener('touchmove', (e)=>{
    const t = e.touches && e.touches[0];
    if(!t) return;
    if(Math.abs(t.clientX-startX) > MOVE_TOLERANCE || Math.abs(t.clientY-startY) > MOVE_TOLERANCE){
      clearTimer();
      item.classList.remove('pressing');
    }
  }, {passive:true});

  item.addEventListener('touchend', ()=>{ clearTimer(); item.classList.remove('pressing'); });
  item.addEventListener('touchcancel', ()=>{ clearTimer(); item.classList.remove('pressing'); });

  item.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    openContextMenu(id, getTitle(), { left:e.clientX, top:e.clientY, right:e.clientX, bottom:e.clientY });
  });

  item.addEventListener('click', ()=>{
    if(longPressed){ longPressed = false; return; }
    openConversation(id);
  });
}

/* ============ CONTEXT MENU (تعديل الاسم / حذف) ============ */
function openContextMenu(id, title, anchorRect){
  contextMenu.innerHTML =
    '<button type="button" class="context-menu-item" data-action="rename"><i class="fas fa-pen"></i><span>تعديل اسم المحادثة</span></button>'+
    '<div class="context-menu-divider"></div>'+
    '<button type="button" class="context-menu-item danger" data-action="delete"><i class="fas fa-trash-can"></i><span>حذف المحادثة</span></button>';

  contextMenu.querySelector('[data-action="rename"]').addEventListener('click', ()=>{
    closeContextMenu();
    openRenameModal(id, title);
  });
  contextMenu.querySelector('[data-action="delete"]').addEventListener('click', ()=>{
    closeContextMenu();
    openDeleteModal(id, title);
  });

  contextMenu.style.display = 'block';
  contextMenuBackdrop.style.display = 'block';

  requestAnimationFrame(()=>{
    const mw = contextMenu.offsetWidth || 210;
    const mh = contextMenu.offsetHeight || 96;
    let left = anchorRect.left;
    let top = (anchorRect.bottom||anchorRect.top) + 6;
    if(left + mw > window.innerWidth - 10) left = window.innerWidth - mw - 10;
    if(left < 10) left = 10;
    if(top + mh > window.innerHeight - 10) top = anchorRect.top - mh - 6;
    if(top < 10) top = 10;
    contextMenu.style.left = left + 'px';
    contextMenu.style.top = top + 'px';
  });
}
function closeContextMenu(){
  contextMenu.style.display = 'none';
  contextMenuBackdrop.style.display = 'none';
}
contextMenuBackdrop.addEventListener('click', closeContextMenu);

/* ============ RENAME MODAL ============ */
let renameConvId = null;
function openRenameModal(id, title){
  renameConvId = id;
  renameInput.value = title;
  renameModal.classList.add('open');
  setTimeout(()=>{ renameInput.focus(); renameInput.select(); }, 60);
}
function closeRenameModal(){
  renameModal.classList.remove('open');
  renameConvId = null;
}
renameCancelBtn.addEventListener('click', closeRenameModal);
renameModal.addEventListener('click', (e)=>{ if(e.target === renameModal) closeRenameModal(); });
renameForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const id = renameConvId;
  const newTitle = renameInput.value.trim();
  closeRenameModal();
  if(!id || !newTitle) return;
  try{
    await db.ref('users/'+currentUser.uid+'/conversations/'+id).update({ title:newTitle });
    if(id === currentConvId) conversationTitle.textContent = newTitle;
  } catch(err){
    console.error('rename err', err);
    alert('معلش، مقدرتش أعدّل اسم المحادثة.');
  }
});

/* ============ DELETE MODAL ============ */
let deleteConvId = null;
function openDeleteModal(id, title){
  deleteConvId = id;
  deleteModalText.textContent = 'هتتحذف محادثة "'+title+'" والرسائل اللي فيها نهائيًا، ومش هينفع ترجّعها تاني.';
  deleteModal.classList.add('open');
}
function closeDeleteModal(){
  deleteModal.classList.remove('open');
  deleteConvId = null;
}
deleteCancelBtn.addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('click', (e)=>{ if(e.target === deleteModal) closeDeleteModal(); });
deleteConfirmBtn.addEventListener('click', async ()=>{
  const id = deleteConvId;
  if(!id) return;
  deleteConfirmBtn.disabled = true;
  try{
    await db.ref('users/'+currentUser.uid+'/conversations/'+id).remove();
    if(id === currentConvId){
      currentConvId = null;
      if(messagesRef) messagesRef.off();
      messagesEl.innerHTML = '';
      // مستمع listenToConversations هيفتح تاني محادثة موجودة، أو يبدأ واحدة جديدة لو مفيش حاجة باقية.
    }
  } catch(err){
    console.error('delete err', err);
    alert('معلش، مقدرتش أحذف المحادثة.');
  } finally {
    deleteConfirmBtn.disabled = false;
    closeDeleteModal();
  }
});

document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    closeContextMenu();
    closeRenameModal();
    closeDeleteModal();
  }
});

function startNewConversation(){
  const ref = db.ref('users/'+currentUser.uid+'/conversations').push();
  ref.set({ title:'محادثة جديدة', createdAt: Date.now(), updatedAt: Date.now() });
  openConversation(ref.key);
}
newChatBtn.addEventListener('click', startNewConversation);

let messagesRef = null;
function openConversation(convId){
  if(messagesRef) messagesRef.off();
  currentConvId = convId;
  conversationTitle.textContent = (conversationsCache[convId] && conversationsCache[convId].title) || 'محادثة جديدة';
  messagesEl.innerHTML='';
  messagesRef = db.ref('users/'+currentUser.uid+'/conversations/'+convId+'/messages');
  messagesRef.on('child_added', snap=>{
    const msg = snap.val();
    if (msg && msg.ts && window.__locallyRendered && window.__locallyRendered.has(msg.ts)){
      window.__locallyRendered.delete(msg.ts);
      return;
    }
    appendMessageBubble(msg);
  });
  document.querySelectorAll('.conv-item').forEach(el=> el.classList.toggle('active', el.dataset.convId === convId));
  if(window.innerWidth <= 760) sidebar.classList.add('collapsed');
}

/* ============ MESSAGES UI ============ */
function formatTime(ts){
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── نفس فكرة formatAIAnswer بتاع فلك: تلوين مخصص، كتل كود، خطوط عريضة، عناوين،
//    صفوف جداول (بما إن مفيش عارض جداول حقيقي، بنحولها لسطر بنقط فاصلة زي فلك بالظبط) ──
// ── لوحة ألوان متناسقة مع خلفية التطبيق الغامقة الدافية (--bg:#1b1a17) — الذكاء
//    بيختار من الأسماء دي بس، مش أي لون خام، عشان يفضل الشكل موحّد وحلو دايمًا.
//    الأسماء القديمة (red/green/blue...) لسه متدعّمة عشان الرسائل المخزّنة قبل كده. ──
var STYLE_COLOR_PALETTE = {
  gold:'#d8a34c', amber:'#e8b768', coral:'#e0916d', rose:'#d98a8f',
  sage:'#9cb88a', mint:'#7fc4ad', sky:'#7fa8d0', lavender:'#b29bd6',
  sand:'#c9b28a', slate:'#9aa3b0',
  red:'#d98a8f', green:'#9cb88a', blue:'#7fa8d0', yellow:'#e8b768',
  orange:'#e0916d', purple:'#b29bd6', pink:'#d9a0ae', cyan:'#7fc4ad', teal:'#6fae9c'
};
function styleHexToRgba(hex, alpha){
  var h = hex.replace('#','');
  var r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  return 'rgba('+r+','+g+','+b+','+alpha+')';
}

function formatAnswer(raw){
  if (!raw) return '';
  var s = String(raw);

  var styleBlocks = [];
  // ── بيتقبل الصيغة الجديدة [[fmt:خصائص]]...[[/fmt]] (لون + bold/italic/underline/strike/highlight)
  //    وكمان الصيغة القديمة [[color:اسم]]...[[/color]] للتوافق مع رسائل اتخزنت قبل كده ──
  s = s.replace(/\[\[(fmt|color):([a-zA-Z, ]+)\]\]([\s\S]*?)\[\[\/\1\]\]/g, function(m, tag, tokensRaw, inner){
    var tokens = tokensRaw.split(',').map(function(t){ return t.trim().toLowerCase(); }).filter(Boolean);
    var colorToken = tokens.filter(function(t){ return STYLE_COLOR_PALETTE[t]; })[0];
    var mods = {
      bold: tokens.indexOf('bold') > -1,
      italic: tokens.indexOf('italic') > -1,
      underline: tokens.indexOf('underline') > -1,
      strike: tokens.indexOf('strike') > -1,
      highlight: tokens.indexOf('highlight') > -1
    };
    var idx = styleBlocks.length;
    styleBlocks.push({ hex: colorToken ? STYLE_COLOR_PALETTE[colorToken] : null, mods: mods, text: inner });
    return '\u0000CL' + idx + '\u0000';
  });

  var codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, function(m, lang, code){
    var idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang||'').trim(), code: code.replace(/\n$/,'') });
    return '\u0000CB' + idx + '\u0000';
  });

  // ── روابط قابلة للضغط: بتتفتح في تاب جديد بالمتصفح مباشرة ──
  var linkBlocks = [];
  s = s.replace(/(https?:\/\/[^\s<>"')\u0000]+?)([.,;:!?]*)(?=\s|$)/g, function(m, url, trail){
    var idx = linkBlocks.length;
    linkBlocks.push(url);
    return '\u0000LK' + idx + '\u0000' + trail;
  });

  s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  var lines = s.split('\n'), out = [];
  for (var i=0;i<lines.length;i++){
    var line = lines[i];
    if (/\u0000CB\d+\u0000/.test(line)) { out.push(line); continue; }
    var t = line.trim();
    if (/^[-=_]{3,}$/.test(t)) continue;
    if (/^\|?[\s:|-]{3,}\|?$/.test(t) && t.indexOf('-') > -1 && t.indexOf('|') > -1) continue;
    var hMatch = t.match(/^#{1,6}\s*(.+)$/);
    if (hMatch) { out.push('<b>' + hMatch[1].trim() + '</b>'); continue; }
    if (t.indexOf('|') > -1 && t.indexOf('|') !== t.lastIndexOf('|')) {
      var cells = t.split('|').map(c=>c.trim()).filter(c=>c.length);
      if (cells.length) { out.push(cells.join('  •  ')); continue; }
    }
    line = line.replace(/^(\s*)[-*]\s+/, '$1• ');
    out.push(line);
  }
  s = out.join('\n');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,.08);padding:.1rem .3rem;border-radius:4px;direction:ltr;display:inline-block">$1</code>');
  s = s.replace(/\n{3,}/g, '\n\n').replace(/\n/g, '<br>');

  for (var ci=0; ci<styleBlocks.length; ci++){
    var cb = styleBlocks[ci];
    var esc = cb.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    esc = esc.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
    var hex = cb.hex || '#d8a34c';
    var styleParts = [];
    if (cb.mods.highlight){
      styleParts.push('background:'+styleHexToRgba(hex,0.16));
      styleParts.push('color:'+hex);
      styleParts.push('padding:.05rem .4rem');
      styleParts.push('border-radius:6px');
    } else if (cb.hex){
      styleParts.push('color:'+hex);
    }
    if (cb.mods.bold) styleParts.push('font-weight:700');
    if (cb.mods.italic) styleParts.push('font-style:italic');
    var decorations = [];
    if (cb.mods.underline) decorations.push('underline');
    if (cb.mods.strike) decorations.push('line-through');
    if (decorations.length) styleParts.push('text-decoration:'+decorations.join(' '));
    var styleAttr = styleParts.length ? ' style="'+styleParts.join(';')+'"' : '';
    s = s.split('\u0000CL' + ci + '\u0000').join('<span'+styleAttr+'>'+esc+'</span>');
  }

  for (var bi=0; bi<codeBlocks.length; bi++){
    var blk = codeBlocks[bi];
    s = s.split('\u0000CB' + bi + '\u0000').join(buildCodeFileCard(blk.lang, blk.code));
  }

  for (var lki=0; lki<linkBlocks.length; lki++){
    var url = linkBlocks[lki];
    var safeHref = url.replace(/"/g,'%22');
    s = s.split('\u0000LK' + lki + '\u0000').join('<a class="msg-link" href="'+safeHref+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(url)+'</a>');
  }

  return s;
}

// ── نفس شريط فلك بالظبط: نسخ / 👎 / 👍 — بيغذي غرفة 3 (الذاكرة الدائمة) ──
function buildActionBar(questionText, answerText){
  const bar = document.createElement('div');
  bar.className = 'cosmos-action-bar';

  function mkBtn(icon, title, handler){
    const b = document.createElement('button');
    b.className = 'cosmos-action-btn';
    b.type = 'button';
    b.title = title;
    b.innerHTML = '<i class="'+icon+'"></i>';
    b.addEventListener('click', (e)=>{ e.stopPropagation(); handler(b); });
    return b;
  }

  bar.appendChild(mkBtn('fas fa-copy', 'نسخ', (btn)=>{
    navigator.clipboard && navigator.clipboard.writeText(answerText).then(()=>{
      btn.innerHTML = '<i class="fas fa-check"></i>';
      setTimeout(()=>{ btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
    });
  }));
  bar.appendChild(mkBtn('fas fa-thumbs-down', 'مش مفيد', (btn)=>{
    const wasActive = btn.classList.contains('disliked');
    bar.querySelectorAll('.cosmos-action-btn').forEach(x=>x.classList.remove('liked','disliked'));
    if(!wasActive){
      btn.classList.add('disliked');
      submitAIFeedback(false, questionText, answerText);
    }
  }));
  bar.appendChild(mkBtn('fas fa-thumbs-up', 'مفيد', (btn)=>{
    const wasActive = btn.classList.contains('liked');
    bar.querySelectorAll('.cosmos-action-btn').forEach(x=>x.classList.remove('liked','disliked'));
    if(!wasActive){
      btn.classList.add('liked');
      submitAIFeedback(true, questionText, answerText);
    }
  }));
  bar.appendChild(mkBtn('fas fa-volume-high', 'قراءة صوتية', (btn)=>{
    speakText(answerText, btn);
  }));
  return bar;
}

// ── لو الرد فيه ملفين كود أو أكتر، نضيف زرار "تحميل الكل ZIP" تحت آخر عنصر في الرسالة ──
function maybeAddZipAllButton(wrap){
  if (!window.JSZip) return;
  const cards = wrap.querySelectorAll('.code-file-card[data-gid]');
  if (cards.length < 2) return;
  const gids = Array.from(cards).map(c => c.dataset.gid);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cosmos-zip-all-btn';
  btn.innerHTML = '<i class="fas fa-file-zipper"></i><span>تحميل كل الملفات ('+gids.length+') كـ ZIP</span>';
  btn.addEventListener('click', async ()=>{
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>بيضغط...</span>';
    try{
      const zip = new JSZip();
      gids.forEach(gid=>{
        const code = window.__codeGroups[gid];
        const meta = (window.__codeMeta || {})[gid];
        if (code && meta) zip.file(meta.filename, code);
      });
      const blob = await zip.generateAsync({ type:'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'محفوظات-ملفات.zip';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch(e){ console.error(e); showToast('❌ مقدرتش أضغط الملفات'); }
    finally { btn.disabled = false; btn.innerHTML = originalHtml; }
  });
  wrap.appendChild(btn);
}

// ── صندوق "غرفة التفكير العميق" القابل للفتح — نفس تصميم فلك ──
function buildDeepThinkBox(reasoningText){
  const box = document.createElement('div');
  box.className = 'cosmos-deep-think';
  box.innerHTML =
    '<button type="button" class="cosmos-deep-think-toggle">'+
    '<i class="fas fa-brain"></i><span>غرفة التفكير العميق</span><i class="fas fa-chevron-down cosmos-deep-think-chevron"></i>'+
    '</button>'+
    '<div class="cosmos-deep-think-body"><div class="cosmos-deep-think-inner">'+escapeHtml(reasoningText)+'</div></div>';
  box.querySelector('.cosmos-deep-think-toggle').addEventListener('click', ()=> box.classList.toggle('open'));
  return box;
}

// ── أنيميشن الكتابة التدريجي الثابت — نفس فلك بالظبط: بيفكك الـ HTML الجاهز (منسّق، ملوّن،
//    فيه بطاقات كود) لعمليات "حرف / فتح تاج / قفل تاج" وبيعيد بناءه تدريجيًا بسرعة هادية وثابتة،
//    من غير ما يعتمد على سرعة الشبكة. بطاقة الكود بتتحط دفعة واحدة جوه مكانها، مش حرف حرف ──
function typewriterReveal(container, html, onDone){
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const ops = [];
  (function walk(node){
    const kids = node.childNodes;
    for (let i=0;i<kids.length;i++){
      const child = kids[i];
      if (child.nodeType === 3){
        const t = child.nodeValue;
        for (let c=0;c<t.length;c++) ops.push({ type:'char', ch:t[c] });
      } else if (child.nodeType === 1){
        if (child.classList && child.classList.contains('code-file-card')){
          ops.push({ type:'block', node: child.cloneNode(true) });
        } else {
          ops.push({ type:'open', tag: child.tagName.toLowerCase(), attrs: child.attributes });
          walk(child);
          ops.push({ type:'close' });
        }
      }
    }
  })(temp);

  container.innerHTML = '';
  const caret = document.createElement('span');
  caret.className = 'cosmos-stream-cursor';
  caret.textContent = '▍';
  container.appendChild(caret);

  const stack = [container];
  let idx = 0;
  function tick(){
    const wasNearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 120;
    let n = 3;
    while (n-- > 0 && idx < ops.length){
      const op = ops[idx++];
      const top = stack[stack.length-1];
      if (op.type === 'char'){
        if (top.lastChild && top.lastChild.nodeType === 3) top.lastChild.nodeValue += op.ch;
        else top.insertBefore(document.createTextNode(op.ch), top===container?caret:null);
      } else if (op.type === 'open'){
        const el = document.createElement(op.tag);
        if (op.attrs) for (let a=0;a<op.attrs.length;a++) el.setAttribute(op.attrs[a].name, op.attrs[a].value);
        top.insertBefore(el, top===container?caret:null);
        stack.push(el);
      } else if (op.type === 'block'){
        top.insertBefore(op.node, top===container?caret:null);
        if (window.hljs) op.node.querySelectorAll('pre code').forEach(el=>{ try{ window.hljs.highlightElement(el); }catch(e){} });
      } else {
        stack.pop();
      }
    }
    if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    if (idx < ops.length) setTimeout(tick, 10);
    else { caret.remove(); if (onDone) onDone(); }
  }
  tick();
}

// ── بتحوّل صندوق "بيفكر/بيتكتب حي" لنفس الرسالة النهائية، وتعمل عليها أنيميشن الكتابة
//    التدريجي فوق النص المنسّق والملوّن الكامل (مش النص الخام) — دي الخطوة اللي كانت ناقصة ──
function renderFinalAssistantMessage(wrap, msg){
  wrap.querySelector('.thinking-steps')?.remove();
  wrap.querySelector('.cosmos-deep-think-live')?.remove();
  wrap.querySelector('.code-building-row')?.remove();
  wrap.querySelector('.cosmos-live-stream')?.remove();

  if (msg.reasoning) wrap.appendChild(buildDeepThinkBox(msg.reasoning));

  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  wrap.appendChild(bubble);

  typewriterReveal(bubble, formatAnswer(msg.text), ()=>{
    wrap.appendChild(buildActionBar(msg.question || '', msg.text));
    maybeAddZipAllButton(wrap);
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.ts);
    wrap.appendChild(time);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function appendMessageBubble(msg){
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + (msg.role==='user' ? 'user' : 'assistant');

  if(msg.role !== 'user'){
    const header = document.createElement('div');
    header.className = 'msg-header';
    header.innerHTML = '<span class="msg-avatar">✦</span><span class="msg-sender-name">'+AI_DISPLAY_NAME+'</span>';
    wrap.appendChild(header);
  }

  // ── صور الرسالة: بنستحمل رسائل قديمة كانت بتخزّن صورة واحدة (msg.image) وكمان
  //    الشكل الجديد اللي بيدعم أكتر من صورة مع بعض (msg.images) ──
  const msgImages = msg.images && msg.images.length ? msg.images : (msg.image ? [msg.image] : []);
  if(msgImages.length){
    const grid = document.createElement('div');
    grid.className = 'msg-images-grid';
    msgImages.forEach(src=>{
      const imgEl = document.createElement('img');
      imgEl.className = 'msg-image';
      imgEl.src = src;
      imgEl.loading = 'lazy';
      grid.appendChild(imgEl);
    });
    wrap.appendChild(grid);
  }

  // ── نفس الفكرة لملفات الرسالة: msg.files (جديد، أكتر من ملف) أو msg.fileName (قديم) ──
  const msgFiles = msg.files && msg.files.length ? msg.files : (msg.fileName ? [{ name: msg.fileName, kind: msg.fileKind, note: msg.fileNote }] : []);
  if(msgFiles.length){
    const filesWrap = document.createElement('div');
    filesWrap.className = 'msg-files-row';
    msgFiles.forEach(f=>{
      const chip = document.createElement('div');
      chip.className = 'attach-file-chip';
      const icon = FILE_KIND_ICON[f.kind] || 'fa-file';
      chip.innerHTML = '<div class="attach-file-icon"><i class="fas '+icon+'"></i></div>'+
        '<div class="attach-file-meta"><div class="attach-file-name">'+escapeHtml(f.name)+'</div>'+
        '<div class="attach-file-status">'+escapeHtml(f.note||'')+'</div></div>';
      filesWrap.appendChild(chip);
    });
    wrap.appendChild(filesWrap);
  }

  if(msg.role !== 'user' && msg.reasoning){
    wrap.appendChild(buildDeepThinkBox(msg.reasoning));
  }

  if(msg.text){
    const bubble = document.createElement('div');
    bubble.className = 'msg ' + (msg.role==='user' ? 'user' : 'assistant');
    if (msg.role==='user'){
      bubble.textContent = msg.text;
    } else {
      bubble.innerHTML = formatAnswer(msg.text);
      if (window.hljs){
        bubble.querySelectorAll('pre code').forEach(el=>{ try{ window.hljs.highlightElement(el); }catch(e){} });
      }
    }
    wrap.appendChild(bubble);
  }

  if(msg.role !== 'user' && msg.text){
    wrap.appendChild(buildActionBar(msg.question || '', msg.text));
    maybeAddZipAllButton(wrap);
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.ts);
  wrap.appendChild(time);

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ============ مؤشر "بيشتغل دلوقتي" — خطوات حقيقية بتتحدّث لحظة بلحظة، مش نصوص وهمية بتلف ============
   قبل كده كان في نصوص جاهزة بتتلف كل 1.4 ثانية من غير أي علاقة باللي بيحصل فعليًا.
   دلوقتي كل خطوة بتتضاف هنا هي خطوة حقيقية حصلت فعلاً في المنطق (getAIResponse،
   processAttachedFile، analyzeImagesWithGemini...): الخطوة اللي قبلها بتتعلّم
   "خلصت" (✓) والخطوة الجديدة بتتحط "شغالة دلوقتي" (نقط متحركة)، بالظبط زي أي
   نظام خطوات شفاف بيوضح للمستخدم النظام بيعمل إيه لحظة بلحظة. */
/* ============ مؤشر "بيشتغل دلوقتي" — خطوات حقيقية بتتحدّث لحظة بلحظة، مش نصوص وهمية بتلف ============
   قبل كده كان في نصوص جاهزة بتتلف كل 1.4 ثانية من غير أي علاقة باللي بيحصل فعليًا.
   دلوقتي كل خطوة بتتضاف هنا هي خطوة حقيقية حصلت فعلاً في المنطق (getAIResponse،
   processAttachedFile، analyzeImagesWithGemini...): الخطوة اللي قبلها بتاخد
   أيقونة "✓ خلصت"، والخطوة الشغالة دلوقتي بتاخد أيقونة تعبّر عن نوعها (بحث،
   رابط، مزوّد ذكاء اصطناعي...) بحلقة نابضة حواليها، بدل نقطة بسيطة واحدة
   لكل الأنواع — عشان الشكل يبان احترافي ومفهوم مش مجرد تحميل عام. */
function stepIconClass(text){
  if (/🔎|الإنترنت/.test(text)) return 'fa-magnifying-glass';
  if (/رابط/.test(text)) return 'fa-link';
  if (/كود/.test(text)) return 'fa-code';
  if (/مردّش/.test(text)) return 'fa-rotate';
  if (/عن طريق/.test(text)) return 'fa-bolt';
  if (/صور/.test(text)) return 'fa-image';
  if (/ملفات|ملف/.test(text)) return 'fa-file-lines';
  return 'fa-circle-notch';
}
function appendThinkingIndicator(firstStepLabel){
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap assistant';
  wrap.innerHTML =
    '<div class="msg-header"><span class="msg-avatar">✦</span><span class="msg-sender-name">'+AI_DISPLAY_NAME+'</span></div>'+
    '<div class="thinking-steps"></div>';
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const stepsEl = wrap.querySelector('.thinking-steps');

  function renderStep(text){
    const prevActive = stepsEl.querySelector('.thinking-step.active');
    if (prevActive){
      prevActive.classList.replace('active','done');
      prevActive.querySelector('.thinking-step-icon i').className = 'fas fa-check';
    }
    const step = document.createElement('div');
    step.className = 'thinking-step active';
    step.innerHTML = '<span class="thinking-step-icon"><i class="fas '+stepIconClass(text)+'"></i></span><span class="thinking-step-text"></span>';
    step.querySelector('.thinking-step-text').textContent = text;
    stepsEl.appendChild(step);
    if (wrap.isConnected) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  renderStep(firstStepLabel || 'بيقرا رسالتك...');
  // ── دالة عامة: أي جزء من المنطق يقدر يضيف خطوة جديدة حقيقية بيها ──
  wrap._addStep = (text)=>{ if (stepsEl.isConnected) renderStep(text); };
  wrap._clearStage = ()=>{
    const lastActive = stepsEl.querySelector('.thinking-step.active');
    if (lastActive){
      lastActive.classList.replace('active','done');
      lastActive.querySelector('.thinking-step-icon i').className = 'fas fa-check';
    }
  };
  return wrap;
}

/* ============ ATTACHMENT (صور / PDF / Word / Excel / صوت / ZIP / أكواد) ============ */
const FILE_KIND_ICON = { image:'fa-image', audio:'fa-microphone', pdf:'fa-file-pdf', docx:'fa-file-word', excel:'fa-file-excel', zip:'fa-file-zipper', text:'fa-file-code', other:'fa-file' };

function clearAttachPreview(){
  pendingAttachments = [];
  attachPreview.style.display = 'none';
  attachPreview.innerHTML = '';
}

function removeAttachmentById(id){
  pendingAttachments = pendingAttachments.filter(a => a.id !== id);
  renderAttachPreview();
}

// ── بتعيد رسم كل المرفقات المعلّقة، كل واحد في صندوقه الخاص وزرار الإكس جواه هو نفسه،
//    وكلهم جنب بعض في صف واحد (flex-wrap) مش فوق بعض ──
function renderAttachPreview(){
  if (!pendingAttachments.length){
    attachPreview.style.display = 'none';
    attachPreview.innerHTML = '';
    return;
  }
  attachPreview.innerHTML = pendingAttachments.map(a=>{
    const removeBtn = '<button type="button" class="attach-remove-btn" data-remove-id="'+a.id+'"><i class="fas fa-xmark"></i></button>';
    if (a.type === 'image'){
      return '<div class="attach-item" data-attach-id="'+a.id+'"><img src="'+a.dataUrl+'">'+removeBtn+'</div>';
    }
    const icon = FILE_KIND_ICON[a.kind] || 'fa-file';
    return '<div class="attach-item" data-attach-id="'+a.id+'">'+
      '<div class="attach-file-chip'+(a.processing?' processing':'')+'">'+
      '<div class="attach-file-icon"><i class="fas '+icon+'"></i></div>'+
      '<div class="attach-file-meta"><div class="attach-file-name">'+escapeHtml(a.name)+'</div>'+
      '<div class="attach-file-status">'+escapeHtml(a.processing ? 'بيتقرا...' : (a.note||'جاهز'))+'</div></div></div>'+
      removeBtn+'</div>';
  }).join('');
  attachPreview.style.display = 'flex';
  attachPreview.querySelectorAll('.attach-remove-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> removeAttachmentById(btn.dataset.removeId));
  });
}

attachBtn.addEventListener('click', ()=> attachInput.click());
attachInput.addEventListener('change', async ()=>{
  const files = Array.from(attachInput.files || []);
  attachInput.value = '';
  if(!files.length) return;

  // ── بنعالج كل ملف على حدة وبنضيفه لصف المرفقات من غير ما نمسح اللي قبله ──
  for (const file of files){
    const kind = getFileKind(file);
    const id = 'a' + (++attachSeq);

    // ── الصور بتتحلل بـ Gemini Vision زي ما هي بالظبط ──
    if (kind === 'image'){
      try{
        const dataUrl = await compressImage(file);
        pendingAttachments.push({ id, type:'image', dataUrl });
        renderAttachPreview();
      } catch(e){ console.error(e); showToast('⚠️ مقدرتش أقرا الصورة دي'); }
      continue;
    }

    // ── ZIP: نسأل المستخدم الأول يفك ولا يسيبه مضغوط، قبل ما نعالج الملف ──
    let extractZip = true;
    if (kind === 'zip'){
      extractZip = confirm('عايز أفك الضغط وأقرا اللي جوه ملف "'+file.name+'"؟\n"موافق" = هفكه وأحلل محتواه\n"إلغاء" = هسيبه مضغوط زي ما هو');
    }

    pendingAttachments.push({ id, type:'file', name:file.name, kind, processing:true });
    renderAttachPreview();

    try{
      const result = await processAttachedFile(file, { extractZip });
      const item = pendingAttachments.find(a=>a.id===id);
      if (item){
        item.processing = false;
        item.note = result.note || 'جاهز';
        item.extractedText = result.extractedText;
      }
      renderAttachPreview();
    } catch(e){
      console.error(e);
      showToast('⚠️ مقدرتش أقرا الملف ده: ' + (e.message || ''));
      removeAttachmentById(id);
    }
  }
});

/* ============ SEND ============ */
composerInput.addEventListener('input', ()=>{
  composerInput.style.height='auto';
  composerInput.style.height = Math.min(140, composerInput.scrollHeight)+'px';
});

composer.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = composerInput.value.trim();
  const attachmentsSnapshot = pendingAttachments.slice();
  const images = attachmentsSnapshot.filter(a=>a.type==='image');
  const files = attachmentsSnapshot.filter(a=>a.type==='file');
  if((!text && !images.length && !files.length) || !currentConvId) return;
  composerInput.value='';
  composerInput.style.height='auto';
  clearAttachPreview();
  sendBtn.disabled = true;
  sendBtn.classList.add('sending');
  const sendBtnIcon = document.getElementById('send-btn-icon');
  sendBtnIcon.className = 'fas fa-circle-notch';
  // مؤقت أمان: لو لأي سبب غير متوقع الرد اتعلّق (شبكة واقفة، تبويب اتجمّد،
  // إلخ) ومكملش لحد الـ finally بتاعت الطلب، الزرار برضه هيرجع شغّال بعد
  // 45 ثانية بدل ما يفضل عالق "بيبعت" للأبد.
  clearTimeout(window.__sendWatchdog);
  window.__sendWatchdog = setTimeout(()=>{
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
    sendBtnIcon.className = 'fas fa-arrow-up';
  }, 45000);
  refreshGeoContext(); // مجرد محاولة تحديث في الخلفية لو لسه معندناش بيانات موقع/صلاة اليوم

  const convRef = db.ref('users/'+currentUser.uid+'/conversations/'+currentConvId);
  const userMsg = { role:'user', ts: Date.now() };
  if(text) userMsg.text = text;
  if(images.length) userMsg.images = images.map(i=>i.dataUrl);
  if(files.length){
    userMsg.files = files.map(f=>{
      const entry = { name: f.name, kind: f.kind, note: f.note || '' };
      if (f.extractedText) entry.fileContext = f.extractedText.slice(0, 8000);
      return entry;
    });
  }
  await convRef.child('messages').push(userMsg);
  await convRef.update({ updatedAt: Date.now() });

  // First message of a conversation becomes its title.
  const snap = await convRef.once('value');
  const conv = snap.val();
  if(conv && (!conv.title || conv.title==='محادثة جديدة')){
    await convRef.update({ title: (text || (files[0] && files[0].name) || (images.length ? 'صورة' : '')).slice(0,40) });
  }

  const thinkingEl = appendThinkingIndicator(images.length
    ? 'بيفتح الصور ويحللها...'
    : (files.length ? 'بيقرا محتوى الملفات المرفقة...' : 'بيقرا رسالتك...'));

  try{
    if(images.length){
      const replyText = await analyzeImagesWithGemini(images.map(i=>i.dataUrl), text);
      thinkingEl._clearStage();
      const replyTs = Date.now();
      const assistantMsg = { role:'assistant', text: replyText, provider:'Gemini Vision', ts: replyTs };
      window.__locallyRendered = window.__locallyRendered || new Set();
      window.__locallyRendered.add(replyTs);
      renderFinalAssistantMessage(thinkingEl, assistantMsg);
      await convRef.child('messages').push(assistantMsg);
      await convRef.update({ updatedAt: replyTs });
    } else {
      const historySnap = await convRef.child('messages').once('value');
      // ── لو فيه ملفات مرفقة (PDF/Word/Excel/صوت/ZIP/كود)، بنضيف محتواها المستخرج
      //    كسياق جوه نفس رسالة المستخدم اللي بتتبعت للذكاء، من غير ما يتحط
      //    جوه فقاعة الرسالة اللي المستخدم شايفها (اللي فضلت بس النص اللي كتبه) ──
      const history = Object.values(historySnap.val() || {})
        .filter(m=>m.text || (m.files && m.files.some(f=>f.fileContext)) || m.fileContext)
        .map(m=>{
          let content = m.text || '';
          if (m.files && m.files.length){
            m.files.forEach(f=>{
              if (f.fileContext){
                content += '\n\n--- محتوى ملف مرفق (' + (f.name||'ملف') + (f.note?' — '+f.note:'') + ') ---\n' + f.fileContext + '\n---';
              }
            });
          } else if (m.fileContext){
            content += '\n\n--- محتوى ملف مرفق (' + (m.fileName||'ملف') + (m.fileNote?' — '+m.fileNote:'') + ') ---\n' + m.fileContext + '\n---';
          }
          return { role: m.role, text: content };
        });

      // ── التفكير وكتابة الرد بيحصلوا في الخلفية بالكامل — من غير ما نعرض أي نص خام
      //    للمستخدم وهو لسه بيتكتب. كل خطوة حقيقية بتحصل جوه getAIResponse (قراءة
      //    رابط، قرار البحث، البحث نفسه، محاولة كل مزوّد) بتتضاف فورًا لمؤشر
      //    الخطوات عن طريق onStep، وأول ما فيه كود جوه الرد بنضيف خطوة "بيجهّز
      //    الكود..." كمان، وبعدين الرد الكامل النظيف بيظهر مرة واحدة مع صندوق
      //    "غرفة التفكير العميق" القابل للفتح جواه ──
      const onReasoningDelta = ()=>{};
      const onStep = (text)=> thinkingEl._addStep(text);
      let codeStageShown = false;
      const onContentDelta = (fullText)=>{
        if (!codeStageShown && fullText.indexOf('```') > -1){
          codeStageShown = true;
          thinkingEl._addStep('بيجهّز الكود...');
        }
      };

      const reply = await getAIResponse(history, onReasoningDelta, onStep, onContentDelta);
      thinkingEl._clearStage();
      const replyTs = Date.now();
      const assistantMsg = { role:'assistant', text: reply.text, provider: reply.provider, ts: replyTs, question: text };
      if (reply.reasoning) assistantMsg.reasoning = reply.reasoning;
      window.__locallyRendered = window.__locallyRendered || new Set();
      window.__locallyRendered.add(replyTs);
      renderFinalAssistantMessage(thinkingEl, assistantMsg);
      await convRef.child('messages').push(assistantMsg);
      await convRef.update({ updatedAt: replyTs });
    }
  } catch(err){
    thinkingEl._clearStage();
    thinkingEl.querySelector('.thinking-steps')?.replaceWith(
      Object.assign(document.createElement('div'), { className:'msg assistant error-msg', textContent:'حصل خطأ في الرد، جرب تاني.' })
    );
    console.error(err);
  } finally {
    clearTimeout(window.__sendWatchdog);
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
    document.getElementById('send-btn-icon').className = 'fas fa-arrow-up';
  }
});

/* ============ SIDEBAR TOGGLE (mobile) ============ */
sidebarToggle.addEventListener('click', ()=> sidebar.classList.toggle('collapsed'));

})();
