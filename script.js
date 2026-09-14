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

/* ============ SHARED AI KEYS (من نفس Firestore بتاع منصة فلك) ============
   منصة فلك (مشروع Firebase: planning-with-ai-390af) بتخزّن كل مفاتيح
   الذكاء الاصطناعي (Groq / Gemini / OpenRouter / Vercel AI Gateway) في
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

falakDb.collection("system").doc("ai_settings").onSnapshot(
  snap => {
    const d = snap.exists ? (snap.data() || {}) : {};
    const soloGroq = (d.groqApiKey && String(d.groqApiKey).trim()) || "";
    const soloGemini = (d.geminiApiKey && String(d.geminiApiKey).trim()) || "";
    globalAiInstructions = (d.globalAiInstructions && String(d.globalAiInstructions).trim()) || "";
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

const AI_DISPLAY_NAME = "AlalaGyGyAgha V1.6";
const MODEL_OPTIONS = [
  { id: 'auto', label: 'الاختيار التلقائي' },
  { id: 'groq', label: 'Groq · gpt-oss-120b' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'openrouter', label: 'OpenRouter (مجاني)' },
  { id: 'vercel', label: 'Vercel AI Gateway' }
];
let selectedModel = localStorage.getItem('mahfoozat_model') || 'auto';
function buildSystemPrompt(){
  return 'اسمك "' + AI_DISPLAY_NAME + '". جاوب بالعربية بوضوح واحترافية. لو حد سألك مين انت، قول إنك مساعد ذكاء اصطناعي بس، من غير ما تحدد اسم شركة أو موديل معيّن (لأن الردود بتتوزّع تلقائيًا على أكتر من نموذج في الخلفية). ممنوع تقول إنك Claude أو ChatGPT أو أي هوية مختلفة عن دي.'
    + (globalAiInstructions ? ('\n\nتعليمات إضافية:\n' + globalAiInstructions) : '');
}

/* ============ خط الدفاع 1: Groq ============ */
async function callGroqChat(historyMsgs){
  if (!GroqKeyPool.count()) return null;
  const maxAttempts = Math.min(GroqKeyPool.count(), 3);
  const messages = [{ role:'system', content: buildSystemPrompt() }].concat(historyMsgs);
  for (let i=0;i<maxAttempts;i++){
    const key = GroqKeyPool.next();
    if (!key) break;
    try{
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-oss-120b", messages, max_tokens: 1500, temperature: 0.4 })
      });
      const data = await res.json();
      const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      GroqKeyPool.report(key, res.ok || res.status !== 429);
      if (txt) return txt;
      if (res.status !== 429) return null; // فشل مش بسبب كوتا، مفيش فايدة نبدّل مفتاح
    } catch(e){ console.warn("Groq call failed", e); }
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
        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: buildSystemPrompt() }] }, generationConfig: { temperature: 0.4, maxOutputTokens: 1500 } })
      });
      const data = await res.json();
      const txt = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      GeminiKeyPool.report(key, res.status !== 429);
      if (txt) return txt;
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
          body: JSON.stringify({ model, messages, max_tokens: 1200, temperature: 0.4 })
        });
        const d = await r.json();
        const txt = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        OpenRouterKeyPool.report(key, r.status !== 429);
        if (txt) return txt;
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
          body: JSON.stringify({ model, messages, max_tokens: 1200, temperature: 0.4, stream: false })
        });
        const d = await r.json();
        const txt = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        VercelGatewayKeyPool.report(key, r.status !== 429);
        if (txt) return txt;
        if (r.status === 429){ keyFailed429 = true; continue; }
      } catch(e){ console.warn("Vercel Gateway call failed", e); }
    }
    if (!keyFailed429) break;
  }
  return null;
}

/* ============ الموزّع الرئيسي: بيجرب كل خط دفاع بالترتيب (أو يبدأ من الموديل المختار يدويًا) ============ */
async function getAIResponse(messageHistory){
  const messages = messageHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));

  const providers = [
    { id:'groq', label:'Groq', fn: callGroqChat },
    { id:'gemini', label:'Gemini', fn: callGeminiChat },
    { id:'openrouter', label:'OpenRouter', fn: callOpenRouterChat },
    { id:'vercel', label:'Vercel Gateway', fn: callVercelChat }
  ];
  // لو المستخدم مختار موديل معيّن، نبدأ بيه، وبعدين نكمل باقي السلسلة تلقائيًا لو هو فشل
  const ordered = selectedModel === 'auto'
    ? providers
    : providers.slice().sort((a,b) => (a.id===selectedModel?-1:0) - (b.id===selectedModel?-1:0));

  for (const p of ordered){
    const txt = await p.fn(messages);
    if (txt) return { text: txt, provider: p.label };
  }

  if (!GroqKeyPool.count() && !GeminiKeyPool.count() && !OpenRouterKeyPool.count() && !VercelGatewayKeyPool.count()){
    return { text: "لسه بجيب مفاتيح الذكاء الاصطناعي... جرب تاني بعد ثانية.", provider: null };
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
    appendMessageBubble(snap.val());
  });
  document.querySelectorAll('.conv-item').forEach(el=> el.classList.remove('active'));
  if(window.innerWidth <= 760) sidebar.classList.add('collapsed');
}

/* ============ MESSAGES UI ============ */
function formatTime(ts){
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
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

  if(msg.text){
    const bubble = document.createElement('div');
    bubble.className = 'msg ' + (msg.role==='user' ? 'user' : 'assistant');
    bubble.textContent = msg.text;
    wrap.appendChild(bubble);
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.ts);
  wrap.appendChild(time);

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  const stageEl = wrap.querySelector('.thinking-stage');
  const list = (stages && stages.length) ? stages : ['بيفكر...'];
  let idx = 0;
  stageEl.textContent = list[0];
  wrap._stageTimer = setInterval(()=>{
    idx = (idx+1) % list.length;
    if (stageEl.isConnected) stageEl.textContent = list[idx];
  }, 1400);
  wrap._clearStage = ()=> clearInterval(wrap._stageTimer);
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
      thinkingEl._clearStage(); thinkingEl.remove();
      const replyTs = Date.now();
      await convRef.child('messages').push({ role:'assistant', text: replyText, provider:'Gemini Vision', ts: replyTs });
      await convRef.update({ updatedAt: replyTs });
    } else {
      const historySnap = await convRef.child('messages').once('value');
      const history = Object.values(historySnap.val() || {}).filter(m=>m.text).map(m=>({ role:m.role, text:m.text }));
      const reply = await getAIResponse(history);
      thinkingEl._clearStage(); thinkingEl.remove();
      const replyTs = Date.now();
      await convRef.child('messages').push({ role:'assistant', text: reply.text, provider: reply.provider, ts: replyTs });
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
