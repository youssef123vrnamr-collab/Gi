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
const MODEL_OPTIONS = [
  { id: 'auto', label: 'الاختيار التلقائي' },
  { id: 'groq', label: 'Groq · gpt-oss-120b' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'openrouter', label: 'OpenRouter (مجاني)' },
  { id: 'vercel', label: 'Vercel AI Gateway' }
];
let selectedModel = localStorage.getItem('mahfoozat_model') || 'auto';

/* ============ غرفة 1: التفكير العميق — نفس تعليمات فلك بالظبط ============ */
function buildReasoningRoomBlock(){
  return '\n\n--- غرفة التفكير العميق (Deep Thinking Room) — تفكيرك الداخلي الحقيقي، منفصل عن الرد النهائي ---\n' +
    'ملاحظة مهمة: النظام بيفصل تفكيرك (reasoning) عن ردك النهائي (content) تلقائيًا ويعرض تفكيرك في صندوق منفصل قابل للفتح للمستخدم — يعني اكتب تفكيرك بحرية وبالتفصيل هنا، ومتقلقش إنه هيظهر في الرد النهائي لأنه مش هيظهر فيه.\n---';
}

/* ============ قاعدة تلوين النص + منع اللاتكس الخام (نفس فلك بالظبط) ============ */
function buildColorPolicyBlock(){
  return '\n\nقاعدة تلوين النص: عندك إمكانية تلوّن أجزاء من ردك النصي (مش الكود) بنفسك وقت ما تحس إن اللون هيفيد فعلاً — زي تحذير مهم بالأحمر، أو نقطة إيجابية/نجاح بالأخضر، أو معلومة مميزة بلون مختلف. استخدم الصيغة دي بالظبط حوالين الجزء اللي عايز تلوّنه: [[color:الاسم]]النص هنا[[/color]] — والاسم لازم يكون واحد من دول بالظبط: red, green, blue, yellow, orange, purple, pink, cyan, teal, gold. متستخدمش الصيغة دي إلا لو فعلاً محتاجها، ومتلوّنش الرد كله ولا كل سطر.';
}
function buildNoRawLatexBlock(){
  return '\n\nقاعدة إلزامية: ممنوع تستخدم صيغة LaTeX الخام (زي \\frac{}{} أو \\sqrt{} أو \\gamma أو \\times) في أي معادلة رياضية، لأن واجهة المحادثة دي مفيهاش عارض LaTeX وهتظهر للمستخدم كرموز خام غريبة بدل معادلة واضحة. اكتب المعادلات بصيغة نصية عادية ومقروءة بس (زي x^2 أو (a+b)/c أو √x أو a/b أو γ = 1/√(1-v²/c²)).';
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
  const filename = (CODE_NAME_MAP[l] || 'file') + '.' + ext;
  const hljsLang = CODE_HLJS_MAP[l] || l || 'plaintext';
  const lineCount = (code.match(/\n/g) || []).length + 1;
  return '<div class="code-file-card" data-gid="'+gid+'">'
    + '<div class="code-file-header" onclick="toggleCodeFileBody(\''+gid+'\')">'
    + '<div class="code-file-icon code-lang-'+ext+'"><i class="fas fa-code"></i></div>'
    + '<div class="code-file-meta"><div class="code-file-name" dir="ltr">'+filename+'</div>'
    + '<div class="code-file-sub">'+label+' · '+lineCount+' سطر</div></div>'
    + '</div>'
    + '<div class="code-file-actions">'
    + '<button type="button" class="code-file-btn" title="نسخ" onclick="copyCodeFile(\''+gid+'\',this)"><i class="fas fa-copy"></i></button>'
    + '<button type="button" class="code-file-btn" title="تنزيل" onclick="downloadCodeFile(\''+gid+'\',\''+filename+'\')"><i class="fas fa-download"></i></button>'
    + '<button type="button" class="code-rate-btn code-rate-good" onclick="rateCodeGood(\''+gid+'\',this)"><i class="fas fa-thumbs-up"></i></button>'
    + '<button type="button" class="code-rate-btn code-rate-bad" onclick="rateCodeBad(\''+gid+'\',this)"><i class="fas fa-thumbs-down"></i></button>'
    + '</div>'
    + '<div class="code-file-body"><pre><code class="hljs language-'+hljsLang+'">'+escapeHtml(code)+'</code></pre></div>'
    + '</div>';
}

window.toggleCodeFileBody = function(gid){
  const card = document.querySelector('.code-file-card[data-gid="'+gid+'"]');
  if (card) card.classList.toggle('open');
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

function buildSystemPrompt(searchResultsBlock){
  return 'اسمك "' + AI_DISPLAY_NAME + '". جاوب بالعربية بوضوح واحترافية. لو حد سألك مين انت، قول إنك مساعد ذكاء اصطناعي بس، من غير ما تحدد اسم شركة أو موديل معيّن (لأن الردود بتتوزّع تلقائيًا على أكتر من نموذج في الخلفية). ممنوع تقول إنك Claude أو ChatGPT أو أي هوية مختلفة عن دي.'
    + buildReasoningRoomBlock()
    + buildColorPolicyBlock()
    + buildNoRawLatexBlock()
    + buildLessonsBlock()
    + buildGoodAnswersBlock()
    + buildGoodCodeBlock()
    + buildBadCodeBlock()
    + (searchResultsBlock || '')
    + (globalAiInstructions ? ('\n\nتعليمات إضافية:\n' + globalAiInstructions) : '');
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

function buildSearchResultsBlock(results){
  if (!results || !results.results || !results.results.length) return '';
  const list = results.results.slice(0,5).map((r,i) => (i+1)+'. '+(r.title||'')+'\n   '+(r.url||'')+'\n   '+(r.content||'').slice(0,300)).join('\n');
  return '\n\n--- نتائج بحث حقيقية من الإنترنت الآن (استخدمها في ردك، وممنوع تتجاهلها أو تجاوب من معلوماتك العامة القديمة لو فيها تعارض) ---\n' + list + '\n---';
}

/* ============ خط الدفاع 1: Groq — Streaming + غرفة التفكير العميق الحية ============ */
async function callGroqChat(historyMsgs, onReasoningDelta, searchResultsBlock, onContentDelta){
  if (!GroqKeyPool.count()) return null;
  const maxAttempts = Math.min(GroqKeyPool.count(), 3);
  const sys = buildSystemPrompt(searchResultsBlock || '');
  const messages = [{ role:'system', content: sys }].concat(historyMsgs);
  for (let i=0;i<maxAttempts;i++){
    const key = GroqKeyPool.next();
    if (!key) break;
    try{
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b", messages, max_tokens: 8000, temperature: 0.4,
          stream: true, reasoning_effort: 'high', reasoning_format: 'parsed'
        })
      });
      if (!res.ok || !res.body){
        GroqKeyPool.report(key, res.status !== 429);
        if (res.status !== 429) return null;
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', full = '', fullReasoning = '';
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
            const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
            if (!delta) continue;
            if (delta.content){ full += delta.content; if (onContentDelta) onContentDelta(full); }
            const reasoningPiece = delta.reasoning || delta.reasoning_content;
            if (reasoningPiece){ fullReasoning += reasoningPiece; if (onReasoningDelta) onReasoningDelta(fullReasoning); }
          } catch(e){ /* سطر ناقص، هيكمل في القراءة الجاية */ }
        }
      }
      GroqKeyPool.report(key, true);
      if (full) return { text: full, reasoning: fullReasoning };
    } catch(e){ console.warn("Groq call failed", e); GroqKeyPool.report(key, false); }
  }
  return null;
}

/* ============ خط الدفاع 2: Gemini ============ */
async function callGeminiChat(historyMsgs){
  if (!GeminiKeyPool.count()) return null;
  const maxAttempts = Math.min(GeminiKeyPool.count(), 3);
  const contents = historyMsgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  for (let i=0;i<maxAttempts;i++){
    const key = GeminiKeyPool.next();
    if (!key) break;
    try{
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: buildSystemPrompt() }] }, generationConfig: { temperature: 0.4, maxOutputTokens: 6000 } })
      });
      const data = await res.json();
      const txt = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      GeminiKeyPool.report(key, res.status !== 429);
      if (txt) return { text: txt, reasoning: '' };
      if (res.status !== 429) return null;
    } catch(e){ console.warn("Gemini call failed", e); }
  }
  return null;
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
  const messages = [{ role:'system', content: buildSystemPrompt() }].concat(historyMsgs);
  const maxAttempts = Math.min(OpenRouterKeyPool.count(), 3);
  for (let i=0;i<maxAttempts;i++){
    const key = OpenRouterKeyPool.next();
    if (!key) break;
    let models = await getFreeOpenRouterModels(key);
    if (!models.length) models = ['meta-llama/llama-3.3-70b-instruct:free','mistralai/mistral-7b-instruct:free','google/gemma-2-9b-it:free'];
    let keyFailed429 = false;
    for (const model of models){
      try{
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "Mahfoozat" },
          body: JSON.stringify({ model, messages, max_tokens: 6000, temperature: 0.4 })
        });
        const d = await r.json();
        const txt = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        OpenRouterKeyPool.report(key, r.status !== 429);
        if (txt) return { text: txt, reasoning: '' };
        if (r.status === 429){ keyFailed429 = true; continue; }
      } catch(e){ console.warn("OpenRouter call failed", e); }
    }
    if (!keyFailed429) break;
  }
  return null;
}

/* ============ خط الدفاع 4: Vercel AI Gateway ============ */
async function callVercelChat(historyMsgs){
  if (!VercelGatewayKeyPool.count()) return null;
  const messages = [{ role:'system', content: buildSystemPrompt() }].concat(historyMsgs);
  const models = ['openai/gpt-4o-mini','google/gemini-2.0-flash','anthropic/claude-haiku-4-5'];
  const maxAttempts = Math.min(VercelGatewayKeyPool.count(), 3);
  for (let i=0;i<maxAttempts;i++){
    const key = VercelGatewayKeyPool.next();
    if (!key) break;
    let keyFailed429 = false;
    for (const model of models){
      try{
        const r = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, max_tokens: 6000, temperature: 0.4, stream: false })
        });
        const d = await r.json();
        const txt = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        VercelGatewayKeyPool.report(key, r.status !== 429);
        if (txt) return { text: txt, reasoning: '' };
        if (r.status === 429){ keyFailed429 = true; continue; }
      } catch(e){ console.warn("Vercel Gateway call failed", e); }
    }
    if (!keyFailed429) break;
  }
  return null;
}

/* ============ الموزّع الرئيسي: بحث عبر الإنترنت لو محتاج، بعدين يجرب كل خط دفاع بالترتيب ============ */
async function getAIResponse(messageHistory, onReasoningDelta, onSearchStart, onContentDelta){
  const lastUserText = (messageHistory[messageHistory.length-1] && messageHistory[messageHistory.length-1].text) || '';
  const messages = messageHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));

  // ── قرار البحث: كلمة صريحة الأول، وإلا نسأل الموديل نفسه ──
  let searchResultsBlock = '';
  const tavilyReady = !!getTavilyApiKey();
  if (tavilyReady){
    const explicitNeed = shouldWebSearch(lastUserText);
    const needsSearch = explicitNeed || await classifyNeedsSearch(lastUserText);
    if (needsSearch){
      if (onSearchStart) onSearchStart();
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
  const ordered = selectedModel === 'auto'
    ? providers
    : providers.slice().sort((a,b) => (a.id===selectedModel?-1:0) - (b.id===selectedModel?-1:0));

  for (const p of ordered){
    const result = await p.fn(messages);
    if (result && result.text) return { text: result.text, reasoning: result.reasoning || '', provider: p.label };
  }

  if (!GroqKeyPool.count() && !GeminiKeyPool.count() && !OpenRouterKeyPool.count() && !VercelGatewayKeyPool.count()){
    return { text: "لسه بجيب مفاتيح الذكاء الاصطناعي... جرب تاني بعد ثانية.", provider: null, reasoning: '' };
  }
  throw new Error("كل مزوّدي الذكاء الاصطناعي فشلوا");
}

/* ============ تحليل الصور عبر Gemini Vision (زي فلك بالظبط) ============ */
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
async function analyzeImageWithGemini(dataUrl, promptText){
  if (!GeminiKeyPool.count()){
    return "لسه مفيش مفتاح Gemini متسجل على فلك، فمقدرش أحلل الصور دلوقتي.";
  }
  const commaIdx = dataUrl.indexOf(',');
  const base64Data = commaIdx > -1 ? dataUrl.slice(commaIdx+1) : dataUrl;
  const mimeMatch = /^data:([^;]+);base64/.exec(dataUrl);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const fullPrompt = (promptText || 'صف هذه الصورة بالتفصيل باللغة العربية.') +
    '\n\nجاوب بأسلوب احترافي منظم بنقاط عند الحاجة، من غير ماركداون خام زي ### أو --- أو جداول |.';
  const parts = [{ text: fullPrompt }, { inline_data: { mime_type: mimeType, data: base64Data } }];
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
let pendingImage = null; // { dataUrl (compressed) }

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
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');
const sendBtn = composer.querySelector('.send-btn');
const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
const attachPreview = document.getElementById('attach-preview');
const modelSelect = document.getElementById('model-select');

/* ============ MODEL SELECTOR ============ */
modelSelect.innerHTML = MODEL_OPTIONS.map(o=>'<option value="'+o.id+'">'+o.label+'</option>').join('');
modelSelect.value = selectedModel;
modelSelect.addEventListener('change', ()=>{
  selectedModel = modelSelect.value;
  localStorage.setItem('mahfoozat_model', selectedModel);
});

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
  } else {
    currentUser = null;
    currentConvId = null;
    if(conversationsRef) conversationsRef.off();
    authScreen.style.display='flex';
    appShell.style.display='none';
  }
});

/* ============ CONVERSATIONS ============ */
function listenToConversations(){
  conversationsRef = db.ref('users/'+currentUser.uid+'/conversations');
  conversationsRef.on('value', snap=>{
    const data = snap.val() || {};
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
    const item = document.createElement('div');
    item.className = 'conv-item' + (id===currentConvId ? ' active' : '');
    item.textContent = conv.title || 'محادثة جديدة';
    item.addEventListener('click', ()=> openConversation(id));
    conversationList.appendChild(item);
  }
}

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
  conversationTitle.textContent = 'محادثة';
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
  document.querySelectorAll('.conv-item').forEach(el=> el.classList.remove('active'));
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
function formatAnswer(raw){
  if (!raw) return '';
  var s = String(raw);

  var colorBlocks = [];
  var allowedColors = /^(red|green|blue|yellow|orange|purple|pink|cyan|teal|gold)$/i;
  s = s.replace(/\[\[color:([a-zA-Z]+)\]\]([\s\S]*?)\[\[\/color\]\]/g, function(m, name, inner){
    if (!allowedColors.test(name.trim())) return inner;
    var idx = colorBlocks.length;
    colorBlocks.push({ color: name.trim().toLowerCase(), text: inner });
    return '\u0000CL' + idx + '\u0000';
  });

  var codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, function(m, lang, code){
    var idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang||'').trim(), code: code.replace(/\n$/,'') });
    return '\u0000CB' + idx + '\u0000';
  });
  // ── لو الرد اتقطع (الموديل خلّص التوكنز) وفيه ``` مفتوحة من غير ما تتقفل، نعتبر باقي
  //    النص كله كود ونحطه في كارت برضو، بدل ما يظهر كنص خام على الشاشة ──
  var openFence = s.match(/```([a-zA-Z0-9]*)\n?([\s\S]*)$/);
  if (openFence) {
    var oIdx = codeBlocks.length;
    codeBlocks.push({ lang: (openFence[1]||'').trim(), code: openFence[2] });
    s = s.slice(0, openFence.index) + '\u0000CB' + oIdx + '\u0000';
  }

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

  for (var ci=0; ci<colorBlocks.length; ci++){
    var cb = colorBlocks[ci];
    var esc = cb.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    esc = esc.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
    s = s.split('\u0000CL' + ci + '\u0000').join('<div class="note-card note-'+cb.color+'">'+esc+'</div>');
  }

  for (var bi=0; bi<codeBlocks.length; bi++){
    var blk = codeBlocks[bi];
    s = s.split('\u0000CB' + bi + '\u0000').join(buildCodeFileCard(blk.lang, blk.code));
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
  return bar;
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
// ── إصلاح باج "الرسمة العالقة": بعض متصفحات الأندرويد (غير كروم) بتسيب رسمة قديمة
//    (paint) عالقة للعناصر اللي فوق لما بنشيل/نضيف عناصر تانية جنبها بسرعة (زي قفل
//    صندوق التفكير العميق). الحل: نجبر المتصفح يعمل إعادة رسم (recomposite) للحاوية كلها ──
function kickRepaint(){
  if (!messagesEl) return;
  messagesEl.classList.add('repaint-kick');
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=> messagesEl.classList.remove('repaint-kick'));
  });
}

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
  wrap.querySelector('.thinking-dots')?.remove();
  wrap.querySelector('.thinking-stage')?.remove();
  wrap.querySelector('.cosmos-deep-think-live')?.remove();
  wrap.querySelector('.code-building-row')?.remove();
  wrap.querySelector('.cosmos-live-stream')?.remove();
  kickRepaint();

  if (msg.reasoning) wrap.appendChild(buildDeepThinkBox(msg.reasoning));

  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  wrap.appendChild(bubble);

  typewriterReveal(bubble, formatAnswer(msg.text), ()=>{
    wrap.appendChild(buildActionBar(msg.question || '', msg.text));
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.ts);
    wrap.appendChild(time);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    kickRepaint();
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

  if(msg.image){
    const imgEl = document.createElement('img');
    imgEl.className = 'msg-image';
    imgEl.src = msg.image;
    imgEl.loading = 'lazy';
    wrap.appendChild(imgEl);
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
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.ts);
  wrap.appendChild(time);

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  kickRepaint();
}

function appendThinkingIndicator(stages){
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap assistant';
  wrap.innerHTML =
    '<div class="msg-header"><span class="msg-avatar">✦</span><span class="msg-sender-name">'+AI_DISPLAY_NAME+'</span></div>'+
    '<div class="thinking-dots"><span></span><span></span><span></span></div>'+
    '<div class="thinking-stage"></div>';
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  kickRepaint();
  const stageEl = wrap.querySelector('.thinking-stage');
  const list = (stages && stages.length) ? stages : ['بيفكر...'];
  let idx = 0;
  let stageOverridden = false;
  stageEl.textContent = list[0];
  wrap._stageTimer = setInterval(()=>{
    if (stageOverridden) return;
    idx = (idx+1) % list.length;
    if (stageEl.isConnected) stageEl.textContent = list[idx];
  }, 1400);
  wrap._clearStage = ()=> clearInterval(wrap._stageTimer);
  // ── لما البحث يبدأ فعليًا ──
  wrap._setSearching = ()=>{ stageOverridden = true; if(stageEl.isConnected) stageEl.textContent = 'بيبحث عبر الإنترنت 🔎...'; };
  // ── لما غرفة التفكير العميق تبدأ تيجي حية من الموديل — بيستبدل نقط "بيفكر" بصندوق تفكير حي ──
  wrap._startLiveReasoning = ()=>{
    if (wrap._contentStarted) return null; // الرد الحقيقي بدأ يوصل، متعرضش تفكير بعد كده
    if (wrap.querySelector('.cosmos-deep-think-live')) return wrap.querySelector('.cosmos-deep-think-live-text');
    stageOverridden = true;
    clearInterval(wrap._stageTimer);
    wrap.querySelector('.thinking-dots')?.remove();
    stageEl.remove();
    kickRepaint();
    const liveBox = document.createElement('div');
    liveBox.className = 'cosmos-deep-think-live';
    liveBox.innerHTML = '<div class="cosmos-deep-think-live-label"><i class="fas fa-brain"></i> غرفة التفكير العميق — بيفكر دلوقتي...</div>'+
      '<div class="cosmos-deep-think-live-text"></div>';
    wrap.appendChild(liveBox);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return liveBox.querySelector('.cosmos-deep-think-live-text');
  };
  // ── لما الرد النهائي (content) يبدأ يوصل — بنشيل صندوق التفكير الحي ونعرض الرد وهو بيتكتب،
  //    حرف بحرف، نفس إحساس فلك بالظبط (نص حر من غير مستطيل/فقاعة، مع مؤشر كتابة نابض) ──
  wrap._startLiveContent = ()=>{
    if (wrap._contentStarted) return wrap.querySelector('.cosmos-live-stream-text');
    wrap._contentStarted = true;
    stageOverridden = true;
    clearInterval(wrap._stageTimer);
    wrap.querySelector('.thinking-dots')?.remove();
    stageEl.remove();
    wrap.querySelector('.cosmos-deep-think-live')?.remove();
    const liveMsg = document.createElement('div');
    liveMsg.className = 'msg assistant cosmos-live-stream';
    liveMsg.innerHTML = '<span class="cosmos-live-stream-text"></span><span class="cosmos-stream-cursor">▍</span>';
    wrap.appendChild(liveMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return liveMsg.querySelector('.cosmos-live-stream-text');
  };
  // ── لما الموديل يبدأ يكتب كود (```): العملية دي المفروض تحصل في الخلفية، مش قدام
  //    المستخدم — بنوقف عرض النص الخام (اللي هيبان فيه ``` وعلامات غريبة وهو لسه بيتكتب)
  //    ونستبدله بمؤشر "بيجهّز الكود..." بسيط، لحد ما بطاقة الملف الجاهزة والمنسّقة تظهر ──
  wrap._setBuildingCode = ()=>{
    if (wrap._buildingCodeShown) return;
    wrap._buildingCodeShown = true;
    const liveMsg = wrap.querySelector('.cosmos-live-stream');
    if (liveMsg) liveMsg.querySelector('.cosmos-stream-cursor')?.remove();
    if (wrap.querySelector('.code-building-row')) return;
    const row = document.createElement('div');
    row.className = 'code-building-row';
    row.innerHTML = '<i class="fas fa-code"></i><span>بيجهّز الكود...</span>';
    wrap.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  return wrap;
}

/* ============ ATTACHMENT (رفع صورة) ============ */
attachBtn.addEventListener('click', ()=> attachInput.click());
attachInput.addEventListener('change', async ()=>{
  const file = attachInput.files && attachInput.files[0];
  attachInput.value = '';
  if(!file) return;
  if(!file.type.startsWith('image/')){
    alert('دلوقتي بس الصور مدعومة كمرفقات.');
    return;
  }
  try{
    const dataUrl = await compressImage(file);
    pendingImage = { dataUrl };
    attachPreview.innerHTML = '<img src="'+dataUrl+'"><button type="button" id="remove-attach">×</button>';
    attachPreview.style.display = 'flex';
    document.getElementById('remove-attach').addEventListener('click', ()=>{
      pendingImage = null;
      attachPreview.style.display = 'none';
      attachPreview.innerHTML = '';
    });
  } catch(e){ console.error(e); alert('معلش، مقدرتش أقرا الصورة دي.'); }
});

/* ============ SEND ============ */
composerInput.addEventListener('input', ()=>{
  composerInput.style.height='auto';
  composerInput.style.height = Math.min(140, composerInput.scrollHeight)+'px';
});

composer.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = composerInput.value.trim();
  const image = pendingImage;
  if((!text && !image) || !currentConvId) return;
  composerInput.value='';
  composerInput.style.height='auto';
  pendingImage = null;
  attachPreview.style.display = 'none';
  attachPreview.innerHTML = '';
  sendBtn.disabled = true;

  const convRef = db.ref('users/'+currentUser.uid+'/conversations/'+currentConvId);
  const userMsg = { role:'user', ts: Date.now() };
  if(text) userMsg.text = text;
  if(image) userMsg.image = image.dataUrl;
  await convRef.child('messages').push(userMsg);
  await convRef.update({ updatedAt: Date.now() });

  // First message of a conversation becomes its title.
  const snap = await convRef.once('value');
  const conv = snap.val();
  if(conv && (!conv.title || conv.title==='محادثة جديدة')){
    await convRef.update({ title: (text || 'صورة').slice(0,40) });
  }

  const thinkingEl = appendThinkingIndicator(image
    ? ['بيفتح الصورة...', 'بيحلل التفاصيل...', 'بيصيغ الوصف...']
    : ['بيقرا رسالتك...', 'بيفكر في الرد...', 'بيصيغ الإجابة...']);

  try{
    if(image){
      const replyText = await analyzeImageWithGemini(image.dataUrl, text);
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
      const history = Object.values(historySnap.val() || {}).filter(m=>m.text).map(m=>({ role:m.role, text:m.text }));

      let liveTextEl = null;
      const onReasoningDelta = (fullReasoning)=>{
        if (!liveTextEl) liveTextEl = thinkingEl._startLiveReasoning();
        if (liveTextEl){
          const shown = fullReasoning.length > 4000 ? fullReasoning.slice(-4000) : fullReasoning;
          liveTextEl.textContent = shown;
          liveTextEl.parentElement.scrollTop = liveTextEl.parentElement.scrollHeight;
        }
      };
      const onSearchStart = ()=> thinkingEl._setSearching();
      let liveContentEl = null;
      const onContentDelta = (fullText)=>{
        const fenceIdx = fullText.indexOf('```');
        if (fenceIdx > -1){
          // ── كتابة الكود نفسها تحصل في الخلفية — نعرض بس أي نص شرح جه قبل الكود، ثم مؤشر تجهيز ──
          if (!liveContentEl) liveContentEl = thinkingEl._startLiveContent();
          if (liveContentEl) liveContentEl.textContent = fullText.slice(0, fenceIdx).trim();
          thinkingEl._setBuildingCode();
          return;
        }
        if (!liveContentEl) liveContentEl = thinkingEl._startLiveContent();
        if (liveContentEl){
          const shown = fullText.length > 6000 ? fullText.slice(-6000) : fullText;
          liveContentEl.textContent = shown; // نص خام أثناء الكتابة (بدون تنسيق) — زي فلك بالظبط
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      };

      const reply = await getAIResponse(history, onReasoningDelta, onSearchStart, onContentDelta);
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
    thinkingEl.querySelector('.thinking-dots')?.replaceWith(
      Object.assign(document.createElement('div'), { className:'msg assistant error-msg', textContent:'حصل خطأ في الرد، جرب تاني.' })
    );
    thinkingEl.querySelector('.thinking-stage')?.remove();
    console.error(err);
  } finally {
    sendBtn.disabled = false;
  }
});

/* ============ SIDEBAR TOGGLE (mobile) ============ */
sidebarToggle.addEventListener('click', ()=> sidebar.classList.toggle('collapsed'));

})();
