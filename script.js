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

/* ============ SHARED AI KEY (من نفس Firestore بتاع منصة فلك) ============
   منصة فلك (مشروع Firebase: planning-with-ai-390af) بتخزّن مفاتيح
   الذكاء الاصطناعي في Firestore هنا: system/ai_settings
   وأي مستخدم بياخدها أوتوماتيك من غير ما يحط حاجة بنفسه — بنفس الطريقة
   دي بالظبط، المنصة الجديدة دي بتتصل بنفس المشروع (كـ "secondary app"،
   من غير ما تلمس أو تعدل حاجة في فلك نفسها) وتقرا نفس المفتاح لحظة
   بلحظة، وتستخدمه تكلم Groq مباشرة زي فلك بالظبط. */
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

let sharedGroqKey = "";
falakDb.collection("system").doc("ai_settings").onSnapshot(
  snap => {
    const d = snap.exists ? (snap.data() || {}) : {};
    sharedGroqKey = (d.groqApiKey && String(d.groqApiKey).trim()) || "";
  },
  err => {
    // الأغلب لو ده ظهر: صلاحيات Firestore بتاعة فلك مش سامحة بالقراءة من
    // مشروع تاني. الحل: من إعدادات Firestore Rules في مشروع فلك، تسمح
    // بقراءة system/ai_settings (زي ما هي مسموحة أصلاً لمستخدمي فلك نفسها).
    console.warn("مقدرش أقرا مفتاح الذكاء الاصطناعي من فلك:", err);
  }
);

async function getAIResponse(messageHistory){
  if(!sharedGroqKey){
    return "لسه بجيب مفتاح الذكاء الاصطناعي... جرب تاني بعد ثانية.";
  }
  const systemPrompt = {
    role: 'system',
    content: 'اسمك "' + AI_DISPLAY_NAME + '". لو حد سألك مين انت أو إيه الموديل بتاعك، قول بصراحة إنك موديل GPT-OSS 120B بيشتغل عن طريق Groq — متقولش إنك تابع لأي منصة تانية (زي فلك أو أي حد تاني)، ومتقولش إنك Claude أو ChatGPT أو أي موديل مختلف عن حقيقتك. جاوب بالعربية بوضوح واحترافية.'
  };
  const messages = messageHistory.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.text
  }));
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + sharedGroqKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [systemPrompt, ...messages],
      max_tokens: 1000
    })
  });
  if(!res.ok) throw new Error("AI error: " + res.status);
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
    || "معلش، مقدرتش أرد دلوقتي.";
}
const AI_DISPLAY_NAME = "المساعد";

/* ============ STATE ============ */
let currentUser = null;
let currentConvId = null;
let conversationsRef = null;

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
    'auth/invalid-credential': 'البريد أو كلمة المرور غلط.'
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

  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (msg.role==='user' ? 'user' : 'assistant');
  bubble.textContent = msg.text;
  wrap.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.ts);
  wrap.appendChild(time);

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendThinkingIndicator(){
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap assistant';
  wrap.innerHTML =
    '<div class="msg-header"><span class="msg-avatar">✦</span><span class="msg-sender-name">'+AI_DISPLAY_NAME+'</span></div>'+
    '<div class="thinking-dots"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

/* ============ SEND ============ */
composerInput.addEventListener('input', ()=>{
  composerInput.style.height='auto';
  composerInput.style.height = Math.min(140, composerInput.scrollHeight)+'px';
});

composer.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = composerInput.value.trim();
  if(!text || !currentConvId) return;
  composerInput.value='';
  composerInput.style.height='auto';
  sendBtn.disabled = true;

  const convRef = db.ref('users/'+currentUser.uid+'/conversations/'+currentConvId);
  await convRef.child('messages').push({ role:'user', text, ts: Date.now() });
  await convRef.update({ updatedAt: Date.now() });

  // First message of a conversation becomes its title.
  const snap = await convRef.once('value');
  const conv = snap.val();
  if(conv && (!conv.title || conv.title==='محادثة جديدة')){
    await convRef.update({ title: text.slice(0,40) });
  }

  const historySnap = await convRef.child('messages').once('value');
  const history = Object.values(historySnap.val() || {}).map(m=>({ role:m.role, text:m.text }));

  const thinkingEl = appendThinkingIndicator();

  try{
    const reply = await getAIResponse(history);
    thinkingEl.remove();
    const replyTs = Date.now();
    await convRef.child('messages').push({ role:'assistant', text: reply, ts: replyTs });
    await convRef.update({ updatedAt: replyTs });
  } catch(err){
    thinkingEl.querySelector('.thinking-dots')?.replaceWith(
      Object.assign(document.createElement('div'), { className:'msg assistant error-msg', textContent:'حصل خطأ في الرد، جرب تاني.' })
    );
    console.error(err);
  } finally {
    sendBtn.disabled = false;
  }
});

/* ============ SIDEBAR TOGGLE (mobile) ============ */
sidebarToggle.addEventListener('click', ()=> sidebar.classList.toggle('collapsed'));

})();
