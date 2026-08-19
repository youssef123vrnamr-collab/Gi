/* =========================================================
   سيرفر "العقل الصغير" - Firebase Cloud Functions
   -----------------------------------------------------------
   كل التدريب والحسابات التقيلة (الشبكة العصبية + نظام التشابه)
   شغالة هنا بس، جوه سيرفرات جوجل. المتصفح (index.html) مبقاش
   فيه ولا سطر تدريب - هو بس بيبعت "علّمني كذا" أو "صنّف كذا"
   ويستنى الرد. لو حد فتح 10 أجهزة مع بعض، كلهم بيكلموا نفس
   السيرفر ونفس الشبكة - مفيش نسخة محلية منفصلة تتكرر ولا تهنج.

   =========================================================
   طبقة جديدة: AI Agent + تنفيذ ديناميكي للأكواد (VM Sandbox)
   -----------------------------------------------------------
   لو نظام التشابه والشبكة العصبية مالقوش رد واثق للسؤال، السيرفر
   بيدوّر في مجموعة "dynamic_tools" على دالة JS اتخزنت قبل كده
   وشبيهة بالسؤال (بنفس منطق التشابه اللي بيستخدمه الرد العادي).
   لو لقى واحدة، بيشغلها جوه بيئة معزولة (vm.createContext) بحد
   أقصى ثانية واحدة، وممنوع فيها الوصول لـ process/require/global.
   أي خطأ أو Timeout بيتلقط وبيترجع كرد نصي عادي - عمره ما بيوقّف
   أو يهنج السيرفر. تفاصيل الأخطاء بتتسجل في مجموعة "tool_errors"
   للمراجعة، والأداة اللي بتفشل كتير بتتوقف تلقائياً (self-healing).
   ========================================================= */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const vm = require('node:vm');
admin.initializeApp();
const db = admin.firestore();

const STATE_REF  = () => db.collection('miniBrain').doc('sharedState');
const MODEL_REF  = () => db.collection('miniBrain').doc('trainedModel');
const TOOLS_COL  = () => db.collection('dynamic_tools');
const TOOL_ERRORS_COL = () => db.collection('tool_errors');

/* ================= إعدادات بصمة الصوت (Voice Cloning) =================
   مفتاح ElevenLabs بيتخزن كـ Secret على مستوى Firebase (مش هارد كودد
   في الملف ولا في المتصفح) - تتحطه مرة واحدة بالأمر:
   firebase functions:secrets:set ELEVENLABS_API_KEY */
const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const SETTINGS_COL = () => db.collection('system_settings');
const VOICE_DOC = () => SETTINGS_COL().doc('voice');

/* ================= طبقة التعلم المستمر من الويب =================
   pending_knowledge : "غرفة التصفية" - مسودات إجابات جاية من البحث
   على النت، لسه مستنية تأكيد أو تصحيح من المستخدم.
   learned_knowledge : القاعدة "المعمّدة" - إجابات اتأكدت (يدوي أو
   من المستخدم) وبقى الموديل يقرا منها مباشرة من غير ما يبحث تاني. */
const PENDING_COL = () => db.collection('pending_knowledge');
const LEARNED_COL = () => db.collection('learned_knowledge');
const UNRESOLVED_COL = () => db.collection('unresolved_queries');

/* ================= إعدادات الشبكة =================
   بما إن التدريب بقى على السيرفر مش على الموبايل، مفيش داعي
   نقلل الحجم عشان نراعي بطارية أو رام الهاتف - كبّرناها شوية
   (96 خلية مخفية بدل 64) عشان دقة أعلى، والتدريب برضه بياخد
   أجزاء من الثانية لأن سيرفرات جوجل أسرع بكتير من الموبايل. */
const HIDDEN_DIM = 96;
const EPOCHS = 220;
const LR = 0.3;
const CONFIDENCE_THRESHOLD = 0.55;
/* رفعناها من 0.42 لـ 0.55: مع عدد فئات محدود (زي 24 فئة) كان بيحصل
   تطابقات وهمية على أسئلة جديدة تماماً (يلقى تشابه ضعيف عشوائي مع
   مثال متدرّب غير متعلّق ويعتبره "واثق")، وده كان بيمنع دورة البحث
   والتعلم من الويب من التفعيل أصلاً لأن result.confident بيبقى true
   غلط. رفع العتبة بيخلي النظام أكتر تحفظاً - أي تشابه ضعيف بيدخل
   تلقائي لمسار البحث في الويب بدل ما يرد برد قديم مش له علاقة. */

/* ================= إعدادات طبقة الـ Agent ================= */
const TOOL_SIM_THRESHOLD = 0.5;   // الحد الأدنى للتشابه عشان نثق في أداة ونشغّلها
const TOOL_TIMEOUT_MS = 1000;     // أقصى وقت تنفيذ لأي دالة ديناميكية جوه الـ VM
const TOOL_ERROR_LIMIT = 3;       // عدد الأخطاء المتتالية قبل ما نوقف الأداة تلقائياً
const TOOL_SEARCH_LIMIT = 300;    // أقصى عدد أدوات نجيبها من Firestore للمقارنة

/* ================= إعدادات دورة التعلم من الويب ================= */
const LEARNED_SIM_THRESHOLD = 0.55;  // الحد الأدنى للتشابه عشان نستخدم معلومة اتعلمناها قبل كده من غير بحث تاني
const LEARNED_SEARCH_LIMIT  = 400;   // أقصى عدد وثائق learned_knowledge نجيبها للمقارنة
const WEB_SEARCH_RESULTS    = 6;     // عدد نتائج DuckDuckGo المطلوبة
const WEB_SNIPPET_MIN_LEN   = 20;    // أقل طول لأي مقتطف عشان نعتبره مفيد (مش حشو)
const WEB_MAX_SNIPPETS_USED = 3;     // أقصى عدد مقتطفات نركّب منها الرد المقترح
const WEB_ANSWER_MAX_CHARS  = 900;   // أقصى طول للرد المقترح المركّب
const WEB_SEARCH_TIMEOUT_MS = 8000;  // أقصى وقت ننتظره لرد DuckDuckGo قبل ما نعتبره فشل ونكمّل عادي (منع التعليق/الـ hang)
// دومينات بترجّع غالبًا ميتاداتا فيديو/كلمات أغاني بدل إجابة حقيقية - بنستبعدها من الأساس
const WEB_BLOCKED_DOMAINS = [
  'youtube.com','youtu.be','dailymotion.com','vimeo.com','tiktok.com',
  'soundcloud.com','spotify.com','anghami.com','genius.com',
  'mp3quran.net','elmazika.com','music.apple.com'
];
// أنماط نصية شكلها ميتاداتا فيديو/أغنية اتلزقت جوه المقتطف مش رد فعلي
const WEB_METADATA_PATTERNS = [
  /released on\s*:/i,
  /auto-?generated by/i,
  /official (lyrics?|music) video/i,
  /provided to youtube/i,
  /\d+\s*(views|مشاهدة)/i,
  /subscribe|اشترك في القناة/i,
  /\bproduction\b.*(dailymotion|youtube)/i
];

/* ================= طبقة الكلام الدارج (Small Talk) =================
   تحيات وعبارات محادثة عادية (سلام، ازيك، صباح الخير...) مش أسئلة
   معرفية، وميتفعّلش لها بحث في النت أبداً - بيتفحص الأول قبل أي حاجة
   تانية (حتى قبل قاعدة البيانات) عشان يشتغل حتى لو العقل صفر فئات. */
const SMALL_TALK_RULES = [
  {
    // تحية إسلامية - لازم رد شرعي محدد، مش أي كلام عام
    pattern: /السلام\s*عليكم/i,
    responses: ['وعليكم السلام ورحمة الله وبركاته 🌸']
  },
  {
    pattern: /^(هاي|هالو|hello|hi|hey)\b/i,
    responses: ['هاي! 👋 عامل إيه؟', 'أهلاً بيك 👋']
  },
  {
    pattern: /(صباح\s*الخير|صباح\s*النور)/i,
    responses: ['صباح النور والسرور ☀️', 'صباح الخير عليك 🌤️']
  },
  {
    pattern: /(مساء\s*الخير|مساء\s*النور)/i,
    responses: ['مساء النور والسرور 🌙', 'مساء الخير عليك ✨']
  },
  {
    pattern: /(ازيك|إزيك|عامل\s*ايه|عاملة\s*ايه|عامل\s*إيه|كيفك|شلونك|إزيكم|ازيكم)/i,
    responses: ['تمام الحمد لله، وانت عامل إيه؟ 😄', 'الحمد لله بخير، إنت عامل إيه؟']
  },
  {
    pattern: /^(مرحبا|أهلا|اهلا|أهلين|اهلين)\b/i,
    responses: ['أهلاً بيك 👋', 'أهلين، اتفضل']
  },
  {
    pattern: /^(شكرا|شكراً|متشكر|تسلم|تسلم ايدك)\b/i,
    responses: ['العفو 🙏', 'تحت أمرك في أي وقت']
  },
  {
    pattern: /^(باي|مع السلامة|تصبح على خير)\b/i,
    responses: ['مع السلامة 👋', 'تصبح على خير 🌙']
  }
];
function detectSmallTalk(text){
  const trimmed = (text || '').trim();
  for(const rule of SMALL_TALK_RULES){
    if(rule.pattern.test(trimmed)){
      const options = rule.responses;
      return options[Math.floor(Math.random() * options.length)];
    }
  }
  return null;
}

/* ================= معالجة النص (نفس منطق المتصفح القديم) ================= */
const STOPWORDS = new Set([
  'في','من','على','عن','الى','إلى','يا','او','أو','ثم','هل','لا','لم','لن',
  'ما','هذا','هذه','ذلك','تلك','التي','الذي','و','كان','كانت','يكون','مع',
  'كل','بعض','كذلك','ايضا','أيضا','انا','أنا','انت','أنت','هو','هي','احنا',
  'إحنا','بس','يعني','عشان','علشان',
  /* ==== كلمات حشو وترحيب زودناها عشان محرك النية ====
     دي كلمات بتتكرر كتير في بداية الجمل العامية (تمام، طيب، بقولك،
     يا عم...) ومالهاش علاقة بمضمون السؤال نفسه - لو سبناها في
     المتجه بتشتت التشابه عن الكلمات المهمة زي "حنفية"/"إصلاح". */
  'تمام','طيب','بقولك','هقولك','قولتلك','بصراحه','الصراحه','بص','يابا',
  'عم','ياعم','يابني','يابنتي','حبيبي','حبيبتي','لو','سمحت','سمحتي',
  'ممكن','ممكن','ياريت','حابب','حابه','عايز','عايزه','محتاج','محتاجه',
  'اقولك','هقول','قصدي','يعني','والله','فعلا','اصلا','خالص','جدا',
  'شوي','شويه','دلوقتي','النهارده','امبارح','بكره','اهو','كده','كدا',
  'برضو','برضه','فقط','فقد','اه','ايوه','ايوة','لأ','مين','فين','امتى',
  'ازاي','ليه','اومال','خلاص','يلا','هيا','ماشي','اوك','اوكي'
]);

function normalizeArabic(text){
  return text
    .replace(/[\u064B-\u0652]/g,'')
    .replace(/[إأآا]/g,'ا')
    .replace(/ى/g,'ي')
    .replace(/ة/g,'ه')
    .replace(/ـ/g,'')
    .replace(/[^\u0621-\u064A0-9a-zA-Z\s]/g,' ');
}
function tokenize(text){
  return normalizeArabic(text).trim().split(/\s+/).filter(Boolean).filter(t=>!STOPWORDS.has(t));
}
const INPUT_DIM = 192;
function hashWord(word){
  let h = 0;
  for(let i=0;i<word.length;i++){ h = (h*31 + word.charCodeAt(i)) >>> 0; }
  return h % INPUT_DIM;
}

/* ================= قاموس "إحساس" بسيط (sentiment) =================
   ده مش نموذج ذكاء اصطناعي جاهز (مفيش خدمة إحساس عربي موثوقة نقدر
   نضمن شغلها من غير ما تحتاج مفتاح API خارجي)، لكنه بعد إضافي في
   المتجه بيدّي الشبكة "حاسة" عامة عن نبرة الجملة (إيجابي/سلبي)
   غير الكلمات نفسها - وده بيوسّع بمرور الوقت من غير كود إضافي،
   لأن أي كلمة مش موجودة فيه ببساطة مالهاش تأثير (صفر) بدل ما تكسر
   الحساب. تقدر تزوّد الكلمات دي زي ما تحب.
   ========================================================= */
const SENTIMENT_LEXICON = {
  'حلو':1,'جميل':1,'رائع':1,'ممتاز':1,'كويس':1,'تمام':1,'حبيبي':0.6,'شكرا':0.8,
  'مبسوط':1,'فرحان':1,'عظيم':1,'جامد':1,'حلوة':1,'برافو':1,'يارب':0.4,
  'وحش':-1,'زفت':-1,'سيء':-1,'سيئ':-1,'غلط':-0.6,'زعلان':-1,'حزين':-1,
  'تعبان':-0.7,'غاضب':-1,'مكسوف':-0.5,'خايف':-0.8,'مش كويس':-1,'مضايق':-0.8
};
function sentimentScore(tokens){
  let sum=0, count=0;
  for(const t of tokens){ if(SENTIMENT_LEXICON.hasOwnProperty(t)){ sum+=SENTIMENT_LEXICON[t]; count++; } }
  return count>0 ? sum/count : 0;
}

const VECTOR_DIM = INPUT_DIM + 1; // +1 لبعد الإحساس

/**
 * textToVector: نفس المتجه الأصلي بالظبط (متوافق مع أوزان الشبكة
 * العصبية المتدرّبة قبل كده) - لكن دلوقتي بياخد باراميتر اختياري
 * "idf" (وزن كل خانة/bucket جوه المتجه). لو اتبعت، بيضاعف كل خانة
 * بوزنها قبل التطبيع، فالكلمات المميزة/النادرة زي "حنفية" أو
 * "إصلاح" بتاخد صوت أعلى من كلمات بتتكرر في كل مكان (زي "بقولك"
 * أو "اسألك") حتى لو مش في قايمة الـ Stopwords الثابتة. من غير
 * idf السلوك زي القديم بالظبط - عشان الشبكة العصبية (اللي اتدرّبت
 * على المتجه الخام) تفضل شغالة صح.
 */
function textToVector(text, idf){
  const vec = new Array(INPUT_DIM).fill(0);
  const tokens = tokenize(text);
  for(const t of tokens){ vec[hashWord(t)] += 1; }
  for(let i=0;i<tokens.length-1;i++){ vec[hashWord(tokens[i]+'_'+tokens[i+1])] += 1.4; }
  if(idf){ for(let i=0;i<vec.length;i++) vec[i] *= idf[i]; }
  const norm = Math.sqrt(vec.reduce((s,v)=>s+v*v,0));
  const normalized = norm>0 ? vec.map(v=>v/norm) : vec;
  normalized.push(sentimentScore(tokens));
  return normalized;
}
function cosineSim(a,b){ let dot=0; for(let i=0;i<a.length;i++) dot += a[i]*b[i]; return dot; }

/* =========================================================
   محرك فهم النية: وزن IDF محلي (Local TF-IDF) - بدون أي API
   -----------------------------------------------------------
   بنحسب لكل "خانة" (bucket) من الـ 192 خانة في المتجه، في كام
   مثال مختلف ظهرت الكلمة اللي بتوصّل لها - لو ظهرت في أمثلة كتير
   جداً (يعني كلمة شائعة عابرة زي "بقولك") وزنها بيقرب من صفر،
   ولو ظهرت في أمثلة قليلة بس (يعني كلمة مميزة ومحدّدة للمضمون
   زي "حنفية") وزنها بيبقى عالي. ده اللي بيخلي البحث يركّز على
   "معنى" السؤال مش مجرد تطابق حروف عشوائي.
   ========================================================= */
function buildIdfTable(examples){
  const df = new Array(INPUT_DIM).fill(0);
  for(const ex of examples){
    const tokens = tokenize(ex.text);
    const seenBuckets = new Set(tokens.map(hashWord));
    for(const b of seenBuckets) df[b]++;
  }
  const N = examples.length;
  // smoothed idf: بيفضل دايماً رقم موجب حتى لو الكلمة موجودة في كل الأمثلة
  return df.map(d => Math.log((N + 1) / (d + 1)) + 1);
}

/* ================= الشبكة العصبية (backprop حقيقي) ================= */
function zeros(rows, cols){ const m=[]; for(let i=0;i<rows;i++) m.push(new Array(cols).fill(0)); return m; }
function randomMatrix(rows, cols, scale){ const m=[]; for(let i=0;i<rows;i++){ const row=[]; for(let j=0;j<cols;j++) row.push((Math.random()*2-1)*scale); m.push(row);} return m; }
function matMul(a,b){ const rA=a.length,cA=a[0].length,cB=b[0].length; const r=zeros(rA,cB); for(let i=0;i<rA;i++) for(let j=0;j<cB;j++){ let s=0; for(let k=0;k<cA;k++) s+=a[i][k]*b[k][j]; r[i][j]=s; } return r; }
function matAdd(a,b){ return a.map((row,i)=>row.map((v,j)=>v+b[i][j])); }
function matSub(a,b){ return a.map((row,i)=>row.map((v,j)=>v-b[i][j])); }
function matHad(a,b){ return a.map((row,i)=>row.map((v,j)=>v*b[i][j])); }
function matT(a){ const rows=a.length,cols=a[0].length; const r=zeros(cols,rows); for(let i=0;i<rows;i++) for(let j=0;j<cols;j++) r[j][i]=a[i][j]; return r; }
function matMap(a,fn){ return a.map(row=>row.map(fn)); }
const sigmoid = x=>1/(1+Math.exp(-x));
const sigmoidDeriv = y=>y*(1-y);

class DenseLayer{
  constructor(inputSize, outputSize, weights, bias){
    this.weights = weights || randomMatrix(inputSize, outputSize, Math.sqrt(1/inputSize));
    this.bias = bias || zeros(1, outputSize);
  }
  forward(input){ this.lastInput=input; this.lastOutput = matMap(matAdd(matMul(input, this.weights), this.bias), sigmoid); return this.lastOutput; }
  backward(outputGradient, lr){
    const delta = matHad(outputGradient, matMap(this.lastOutput, sigmoidDeriv));
    const wGrad = matMul(matT(this.lastInput), delta);
    const inGrad = matMul(delta, matT(this.weights));
    for(let i=0;i<this.weights.length;i++) for(let j=0;j<this.weights[0].length;j++) this.weights[i][j]-=lr*wGrad[i][j];
    for(let j=0;j<this.bias[0].length;j++) this.bias[0][j]-=lr*delta[0][j];
    return inGrad;
  }
}
class NeuralNetwork{
  constructor(sizes, savedLayers){
    this.layers=[];
    for(let i=0;i<sizes.length-1;i++){
      const saved = savedLayers && savedLayers[i];
      this.layers.push(new DenseLayer(sizes[i], sizes[i+1], saved && saved.w, saved && saved.b));
    }
  }
  predict(input){ let o=input; for(const l of this.layers) o=l.forward(o); return o; }
  trainStep(input, target, lr){
    let grad = matSub(this.predict(input), target);
    for(let i=this.layers.length-1;i>=0;i--) grad = this.layers[i].backward(grad, lr);
  }
}
function oneHot(index, size){ const v=new Array(size).fill(0); v[index]=1; return [v]; }

/* =========================================================
   محرك المعادلات الرياضية (Math Engine) - بدون eval() خالص
   -----------------------------------------------------------
   بيتشغّل قبل أي بحث تشابه: لو الرسالة كلها/معظمها معادلة حسابية
   (حتى لو مكتوبة بكلمات عربية زي "5 زائد 3")، بنحوّلها لرموز
   حسابية وبعدين بنفسّرها بـ parser يدوي (Recursive Descent) بيدعم
   + - * / ^ والأقواس - من غير أي استدعاء لـ eval أو Function خالص،
   فمفيش أي مخاطرة أمنية حتى لو حد بعت نص غريب.
   ========================================================= */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function convertArabicDigits(s){
  return s.replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)));
}
function arabicMathWordsToSymbols(s){
  return s
    .replace(/زائد|جمع/g, '+')
    .replace(/ناقص|طرح/g, '-')
    .replace(/مضروب في|ضرب|×|في(?=\s|\d)/g, '*')
    .replace(/مقسوم على|قسمة|÷|على(?=\s|\d)/g, '/')
    .replace(/تربيع/g, '^2')
    .replace(/يساوي|كام|بكام|\?|؟/g, '');
}

/** parser رياضي آمن يدوي - بيدعم + - * / ^ والأقواس والأعداد العشرية فقط */
function safeMathEval(expr){
  let pos = 0;
  const peek = () => expr[pos];
  const skipSpace = () => { while(pos<expr.length && expr[pos]===' ') pos++; };

  function parseNumber(){
    skipSpace();
    const start = pos;
    while(pos<expr.length && /[\d.]/.test(expr[pos])) pos++;
    if(pos===start) throw new Error('رقم متوقع');
    const n = parseFloat(expr.slice(start,pos));
    if(Number.isNaN(n)) throw new Error('رقم غير صالح');
    return n;
  }
  function parseFactor(){
    skipSpace();
    if(peek()==='('){
      pos++; const v = parseExpr(); skipSpace();
      if(peek()!==')') throw new Error('قوس ناقص');
      pos++; return v;
    }
    if(peek()==='-'){ pos++; return -parseFactor(); }
    if(peek()==='+'){ pos++; return parseFactor(); }
    return parseNumber();
  }
  function parsePower(){
    const base = parseFactor(); skipSpace();
    if(peek()==='^'){ pos++; return Math.pow(base, parsePower()); }
    return base;
  }
  function parseTerm(){
    let v = parsePower(); skipSpace();
    while(peek()==='*' || peek()==='/'){
      const op = peek(); pos++;
      const rhs = parsePower();
      v = op==='*' ? v*rhs : v/rhs;
      skipSpace();
    }
    return v;
  }
  function parseExpr(){
    let v = parseTerm(); skipSpace();
    while(peek()==='+' || peek()==='-'){
      const op = peek(); pos++;
      const rhs = parseTerm();
      v = op==='+' ? v+rhs : v-rhs;
      skipSpace();
    }
    return v;
  }

  const result = parseExpr();
  skipSpace();
  if(pos !== expr.length) throw new Error('رموز زيادة غير متوقعة في المعادلة');
  return result;
}

/**
 * تجربة اكتشاف وحل معادلة رياضية من نص المستخدم. بترجع رقم لو
 * نجحت، أو null لو الرسالة مش معادلة أصلاً (مش خطأ - يبقى نكمّل
 * على باقي الـ pipeline العادي).
 */
function tryEvalMathExpression(rawText){
  let s = convertArabicDigits(rawText.trim());
  s = arabicMathWordsToSymbols(s);
  s = s.trim();
  if(!s) return null;
  if(!/\d/.test(s)) return null;              // لازم فيه رقم
  if(!/[+\-*/^]/.test(s)) return null;        // لازم فيه عملية حسابية
  if(/[^\d+\-*/^().\s]/.test(s)) return null; // لو فيه أي حروف متبقية، مش معادلة نقية

  try{
    const result = safeMathEval(s);
    if(typeof result !== 'number' || !isFinite(result)) return null;
    return Math.round(result * 1e8) / 1e8; // تقريب بسيط لتفادي أخطاء الفاصلة العشرية
  }catch(e){ return null; }
}

/* =========================================================
   محرك N-Gram توليدي محلي (بدون أي API خارجي)
   -----------------------------------------------------------
   لو الفئة اللي اتطابقت معاها الرسالة عندها أكتر من رد واحد
   مخزّن (يعني الموديول اتعلم أكتر من صياغة لنفس المعنى)، بدل
   ما نختار رد واحد عشوائي بس، بنبني نموذج Bigram بسيط من كل
   الردود دي ونولّد جملة جديدة ممزوجة منها - صياغة "طازة" مبنية
   على نفس الأسلوب اللي اتعلمه، مش نسخة طبق الأصل من رد واحد.
   ========================================================= */
function buildBigramModel(sentences){
  const starts = [];
  const nextMap = new Map();
  for(const sent of sentences){
    const words = String(sent).trim().split(/\s+/).filter(Boolean);
    if(words.length===0) continue;
    starts.push(words[0]);
    for(let i=0;i<words.length-1;i++){
      const key = words[i];
      if(!nextMap.has(key)) nextMap.set(key, []);
      nextMap.get(key).push(words[i+1]);
    }
  }
  return { starts, nextMap };
}
function generateFromBigram(model, maxWords=22){
  if(!model.starts.length) return null;
  let word = model.starts[Math.floor(Math.random()*model.starts.length)];
  const out = [word];
  for(let i=0;i<maxWords-1;i++){
    const nexts = model.nextMap.get(word);
    if(!nexts || !nexts.length) break;
    word = nexts[Math.floor(Math.random()*nexts.length)];
    out.push(word);
    if(out.length>=6 && Math.random()<0.3) break; // وقفة طبيعية بعد ما الجملة تاخد شكل معقول
  }
  return out.join(' ');
}

/* =========================================================
   طبقة الـ VM Sandbox - قلب نظام الـ Agent
   -----------------------------------------------------------
   الهدف: تنفيذ دالة JS بيولّدها/بيخزّنها الموديول من غير ما نديها
   أي وصول لحاجة برّه نفسها. بنستخدم موديول vm الأساسي في Node
   (مفيش أي حزمة خارجية زي vm2 أو isolated-vm).

   طبقات الحماية:
   1) فحص نصي مبدئي يرفض أي كود فيه كلمات خطيرة زي process/require/
      global قبل حتى ما نوصله للـ VM.
   2) vm.createContext بخيار codeGeneration:{strings:false} - ده
      بيقفل eval() و new Function("...") تماماً جوه الكود، حتى لو
      حاول يلتف على الفحص النصي.
   3) الـ context نفسه مفيهوش غير أدوات JS الأساسية الآمنة
      (Math, JSON, Array, Object, String, Number, Boolean, Date)
      وكونسول وهمي بيسجل بس من غير ما يوصل لـ stdout الحقيقي.
   4) Timeout صارم (1000ms افتراضياً) - أي loop لا نهائي أو حساب
      تقيل بيتقفل بالقوة برمي Error، مش بيعلّق السيرفر.

   ملحوظة أمان مهمة: موديول vm الأساسي في Node مش "جدار ناري"
   كامل 100% ضد كل تقنيات الهروب المتقدمة (زي استغلال بعض سلاسل
   الـ prototype)، فهو مناسب جداً لتنفيذ دوال صغيرة الموديول نفسه
   بيولّدها لحل مسائل منطقية/حسابية بسيطة - مش مكان لتشغيل كود من
   مصدر غير موثوق فيه بالكامل. لو حبينا مستوى أمان أعلى في المستقبل،
   الخطوة التالية المنطقية هي تبديل الطبقة دي بمكتبة isolated-vm.
   ========================================================= */

// كلمات/أنماط ممنوعة تماماً - أي وجود ليها يرفض الكود فوراً من غير
// ما نحاول حتى نشغّله
const BLOCKED_PATTERN = /\b(process|require|global|globalThis|__dirname|__filename|module|exports|Buffer|import)\b|Function\s*\(|constructor\s*\.\s*constructor/;

function buildSandbox(input){
  const logs = [];
  const safeConsole = {
    log: (...args) => {
      if(logs.length < 20){
        logs.push(args.map(a => {
          try{ return typeof a === 'string' ? a : JSON.stringify(a); }
          catch{ return String(a); }
        }).join(' '));
      }
    }
  };
  return {
    input,
    output: undefined,
    Math, JSON, Array, Object, String, Number, Boolean, Date,
    console: safeConsole,
    __logs: logs
  };
}

/**
 * تشغيل كود JS جوه بيئة معزولة تماماً.
 * الكود المتوقع إما:
 *   function run(input){ ... return النتيجة ... }
 * أو تعبير بسيط بيحط قيمته في output.
 * بيرجع دايماً { ok, result | error, timedOut?, logs? }
 * وعمره ما بيرمي Exception للخارج - أي خطأ بيتلقط جوه الدالة دي.
 */
function runCodeInSandbox(code, input, timeoutMs = TOOL_TIMEOUT_MS){
  if(typeof code !== 'string' || !code.trim()){
    return { ok:false, error:'كود الأداة فاضي' };
  }
  if(BLOCKED_PATTERN.test(code)){
    return { ok:false, error:'الكود مرفوض: فيه استخدام ممنوع (process/require/global/Function...)' };
  }

  const sandboxObj = buildSandbox(input);
  let context;
  try{
    context = vm.createContext(sandboxObj, {
      codeGeneration: { strings:false, wasm:false } // يقفل eval() و new Function() من جوه الكود
    });
  }catch(e){
    return { ok:false, error:'فشل تجهيز البيئة المعزولة: ' + e.message };
  }

  const wrapped = `
    "use strict";
    ${code}
    ;(typeof run === 'function') ? run(input) : output;
  `;

  try{
    const script = new vm.Script(wrapped, { filename: 'dynamic-tool.js' });
    const result = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: true });
    return { ok:true, result, logs: sandboxObj.__logs };
  }catch(e){
    const msg = (e && e.message) ? e.message : 'خطأ غير معروف أثناء تنفيذ الأداة';
    return {
      ok:false,
      error: msg,
      timedOut: /Script execution timed out/i.test(msg)
    };
  }
}

/* =========================================================
   تسجيل نتيجة تشغيل أداة ديناميكية + التصحيح الذاتي (Self-Healing)
   -----------------------------------------------------------
   نجاح: بنصفّر عداد الأخطاء ونزوّد عداد الاستخدام.
   فشل: بنسجّل الخطأ في tool_errors للمراجعة، ونزوّد عداد الأخطاء
   المتتالية، ولو عدّى الحد (TOOL_ERROR_LIMIT) بنوقف الأداة تلقائياً
   (disabled:true) عشان متتسببش في فشل متكرر لمستخدمين تانيين.
   ========================================================= */
async function handleToolOutcome(toolRef, toolData, outcome, input){
  try{
    if(outcome.ok){
      await toolRef.update({
        usageCount: admin.firestore.FieldValue.increment(1),
        errorCount: 0,
        lastUsedAt: Date.now()
      });
    } else {
      await TOOL_ERRORS_COL().add({
        toolId: toolRef.id,
        toolName: toolData.name || null,
        error: outcome.error,
        timedOut: !!outcome.timedOut,
        input: typeof input === 'string' ? input.slice(0,500) : JSON.stringify(input).slice(0,500),
        createdAt: Date.now()
      });
      const newErrCount = (toolData.errorCount || 0) + 1;
      const update = { errorCount: newErrCount, lastError: outcome.error, lastErrorAt: Date.now() };
      if(newErrCount >= TOOL_ERROR_LIMIT){ update.disabled = true; }
      await toolRef.update(update);
    }
  }catch(logErr){
    // حتى لو فشل تسجيل النتيجة نفسه، ميوقفش الرد للمستخدم
    console.error('handleToolOutcome logging failed:', logErr);
  }
}

/**
 * الدوران على مجموعة dynamic_tools (غير الموقوفة) ولقاء أقرب أداة
 * لمتجه السؤال الحالي، بنفس منطق cosineSim المستخدم في التشابه
 * العادي بين الأمثلة.
 */
async function findBestTool(vec){
  const snap = await TOOLS_COL().where('disabled','==', false).limit(TOOL_SEARCH_LIMIT).get();
  let best = null, bestSim = -1;
  snap.forEach(doc => {
    const t = doc.data();
    if(!Array.isArray(t.vector) || t.vector.length !== vec.length) return;
    const sim = cosineSim(vec, t.vector);
    if(sim > bestSim){ bestSim = sim; best = { id: doc.id, ...t }; }
  });
  return { tool: best, sim: bestSim };
}

/* =========================================================
   ========= Continuous Web Learning & Verification Pipeline =========
   -----------------------------------------------------------
   الفكرة: لو الموديل (الأمثلة + الشبكة العصبية + الأدوات الديناميكية)
   مالقاش رد واثق، ممنوع يرجّع اعتذار زي "معرفش" - بدل كده:
     1) يدوّر في learned_knowledge (حاجات اتأكدت قبل كده) - لو لقى
        حاجة قريبة كفاية، يردّ بيها فوراً من غير ما يبحث في النت تاني.
     2) لو مفيش، يبحث فعلياً في DuckDuckGo (من غير API Key).
     3) نتائج البحث الخام بتتصفّى من الحشو/الإعلانات، ويتركّب منها
        رد مقترح، ويتخزن مؤقتاً في "غرفة التصفية" pending_knowledge،
        ويترجع للمستخدم مع علامة استفهام (needsConfirmation:true).
     4) لما المستخدم يرد (👍/صح/تمام أو 👎 + تصحيح)، الفرونت إند
        بيبعت نفس الرسالة الجاية مع pendingId، فبنرقّي المعلومة أو
        نستبدلها بتصحيح المستخدم جوه learned_knowledge المعمّدة.
   ========================================================= */

/* -------- أ) البحث عن معلومة "معمّدة" اتعلمناها قبل كده -------- */
async function findBestLearned(vec){
  const snap = await LEARNED_COL().limit(LEARNED_SEARCH_LIMIT).get();
  let best=null, bestSim=-1;
  snap.forEach(doc=>{
    const d = doc.data();
    if(!Array.isArray(d.vector) || d.vector.length!==vec.length) return;
    const sim = cosineSim(vec, d.vector);
    if(sim>bestSim){ bestSim=sim; best = { id: doc.id, ...d }; }
  });
  return { learned:best, sim:bestSim };
}

/* -------- ب) البحث الحي في DuckDuckGo (بدون مفتاح API) --------
   بنستخدم واجهة duckduckgo.com/html اللي بترجع HTML بسيط (مفيش
   JS)، وبنستخرج منها العنوان + المقتطف + الرابط بـ regex خفيف
   من غير أي مكتبة تحليل HTML خارجية. */
function stripHtmlTags(s){
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
}
function decodeDuckDuckGoUrl(href){
  try{
    const m = String(href||'').match(/uddg=([^&]+)/);
    if(m) return decodeURIComponent(m[1]);
    if(/^https?:\/\//i.test(href)) return href;
    if(href && href.startsWith('//')) return 'https:' + href;
    return href;
  }catch(e){ return href; }
}
function parseDuckDuckGoHtml(html){
  const results = [];
  const blockRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while((m = blockRegex.exec(html)) !== null){
    const url = decodeDuckDuckGoUrl(m[1]);
    const title = stripHtmlTags(m[2]);
    const snippet = stripHtmlTags(m[3]);
    if(title || snippet) results.push({ url, title, snippet });
  }
  return results;
}
async function searchDuckDuckGo(query, maxResults = WEB_SEARCH_RESULTS){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try{
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=xa-ar';
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MiniBrainLearner/1.0; +server-side)',
        'Accept-Language': 'ar,en;q=0.7'
      }
    });
    if(!res.ok) return [];
    const html = await res.text();
    return parseDuckDuckGoHtml(html).slice(0, maxResults);
  }catch(e){
    // بما فيها AbortError لو البحث أخد وقت أطول من WEB_SEARCH_TIMEOUT_MS -
    // مفيش داعي نفرّق نوع الخطأ، المهم السيرفر يكمّل ومايتعلقش أبداً
    console.error('DuckDuckGo search failed:', e && e.message || e);
    return [];
  }finally{
    clearTimeout(timeoutId);
  }
}

/* -------- ب-١) Fallback على Bing (لو DuckDuckGo محظور على IP السيرفر) --------
   نفس فكرة الـ regex الخفيف من غير مكتبة تحليل HTML - هيكل صفحة نتايج
   Bing مختلف عن DuckDuckGo فبنفسره بـ pattern منفصل. */
function parseBingHtml(html){
  const results = [];
  const blockRegex = /<li class="b_algo"[\s\S]*?<h2>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>[\s\S]*?<p>([\s\S]*?)<\/p>/g;
  let m;
  while((m = blockRegex.exec(html)) !== null){
    const url = stripHtmlTags(m[1]);
    const title = stripHtmlTags(m[2]);
    const snippet = stripHtmlTags(m[3]);
    if(title || snippet) results.push({ url, title, snippet });
  }
  return results;
}
async function searchBing(query, maxResults = WEB_SEARCH_RESULTS){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try{
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=ar&cc=EG';
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'ar,en;q=0.7'
      }
    });
    if(!res.ok) return [];
    const html = await res.text();
    return parseBingHtml(html).slice(0, maxResults);
  }catch(e){
    console.error('Bing fallback search failed:', e && e.message || e);
    return [];
  }finally{
    clearTimeout(timeoutId);
  }
}

/* -------- ب-٢) طبقة البحث الموحّدة: تجرّب DuckDuckGo، ولو رجّعت فاضية
   (سواء بسبب حظر الـ IP بتاع السيرفر أو أي مشكلة تانية) بتلجأ فوراً
   لـ Bing من غير ما المستخدم يحس بأي فرق - نفس شكل النتيجة بالظبط
   ومفيش أي حاجة محتاجة مفتاح API. -------- */
async function searchWebWithFallback(query, maxResults = WEB_SEARCH_RESULTS){
  const primary = await searchDuckDuckGo(query, maxResults);
  if(primary.length > 0) return { results: primary, provider: 'duckduckgo' };
  const secondary = await searchBing(query, maxResults);
  if(secondary.length > 0) return { results: secondary, provider: 'bing' };
  return { results: [], provider: null };
}

/* -------- ج) غرفة التصفية: تنظيف النتائج الخام وتركيب رد مقترح --------
   بنشيل: المقتطفات القصيرة جداً (حشو)، التكرار، وأي حاجة شكلها
   إعلان صريح. وبنركّب رد واحد مقروء من أفضل المقتطفات المتبقية. */
function cleanAndComposeAnswer(results){
  const seen = new Set();
  const cleaned = [];
  for(const r of (results || [])){
    const snippet = (r.snippet || '').trim();
    if(!snippet || snippet.length < WEB_SNIPPET_MIN_LEN) continue;
    if(/(^|\s)(اعلان|إعلان|ads?|sponsored|promoted)(\s|$)/i.test(snippet)) continue;
    // استبعاد نتائج جايه من مواقع فيديو/أغاني/ستريمينج - ميتاداتا مش إجابة
    const host = (r.url || '').replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0].toLowerCase();
    if(WEB_BLOCKED_DOMAINS.some(d => host === d || host.endsWith('.' + d))) continue;
    // استبعاد مقتطفات شكلها ميتاداتا فيديو حتى لو جايه من دومين تاني (نسخ/تجميع)
    if(WEB_METADATA_PATTERNS.some(p => p.test(snippet))) continue;
    const key = snippet.slice(0, 60);
    if(seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ title: r.title || '', snippet, url: r.url || '' });
    if(cleaned.length >= WEB_MAX_SNIPPETS_USED) break;
  }
  if(cleaned.length === 0) return null;
  const composedAnswer = cleaned.map(c => c.snippet).join(' ').replace(/\s+/g,' ').trim().slice(0, WEB_ANSWER_MAX_CHARS);
  return { composedAnswer, sources: cleaned.map(c => ({ title: c.title, url: c.url })) };
}

/* -------- د) مسار "عدم الاستسلام أبداً": يتفعّل كخطوة أخيرة قبل الرد --------
   searchQuery هنا ممكن تبقى مختلفة عن text الأصلي (مركّبة من آخر رسايل
   المحادثة) عشان البحث نفسه يفهم السياق (مثلاً "وهو فين؟" لوحدها معناها
   حاجة تانية غير لما نضمّها لآخر سؤال قبلها). النص المحفوظ في الوثيقة
   المعلّقة (question) يفضل هو النص الأصلي بالظبط زي ما كتبه المستخدم. */
async function runWebLearningFallback(text, vecRaw, searchQuery){
  const { results, provider } = await searchWebWithFallback(searchQuery || text);
  const cleaned = cleanAndComposeAnswer(results);

  if(!cleaned){
    // حتى البحث في النت ملقاش حاجة مفيدة - برضو ممنوع نرجّع اعتذار
    // جاهز زي "معرفش". بدل كده بنسجّل السؤال في unresolved_queries
    // للمراجعة لاحقاً، وبنرد بطلب صريح إن المستخدم يعلّمنا هو بنفسه.
    try{
      await UNRESOLVED_COL().add({ question:text, createdAt: Date.now() });
    }catch(logErr){ console.error('unresolved log failed:', logErr); }
    return {
      confident: true,
      viaWebSearch: true,
      searchFoundNothing: true,
      needsTeaching: true,
      proposedAnswer: null
    };
  }

  const pendingDoc = {
    question: text,
    normalizedQuestion: normalizeArabic(text),
    vector: vecRaw,
    proposedAnswer: cleaned.composedAnswer,
    sources: cleaned.sources,
    status: 'pending',
    createdAt: Date.now()
  };
  const ref = await PENDING_COL().add(pendingDoc);
  return {
    confident: true,
    viaWebSearch: true,
    needsConfirmation: true,
    pendingId: ref.id,
    proposedAnswer: cleaned.composedAnswer,
    sources: cleaned.sources
  };
}

/* -------- ه) ترقية/تصحيح معلومة معلّقة إلى القاعدة المعمّدة -------- */
async function promotePendingToLearned(pendRef, pend, finalAnswer, origin){
  const vector = Array.isArray(pend.vector) && pend.vector.length === VECTOR_DIM
    ? pend.vector
    : textToVector(pend.question);
  const learnedDoc = {
    question: pend.question,
    normalizedQuestion: pend.normalizedQuestion || normalizeArabic(pend.question),
    answer: finalAnswer,
    vector,
    sources: origin === 'web_confirmed' ? (pend.sources || []) : [],
    trust: 1,
    origin,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const batch = db.batch();
  const learnedRef = LEARNED_COL().doc();
  batch.set(learnedRef, learnedDoc);
  batch.delete(pendRef);
  await batch.commit();
  return learnedRef.id;
}

/* -------- و) اكتشاف تأكيد/اعتراض بسيط (👍/صح/تمام مقابل 👎/غلط) -------- */
const AFFIRM_WORDS = ['صح','صحيح','تمام','مظبوط','ايوه','ايوة','اه','نعم','اكيد','كده تمام','اوك','اوكي','ok','okay','yes'];
const NEGATE_WORDS = ['غلط','خطا','خطأ','لا','لأ','مش صح','مش مظبوط','no','wrong'];
function isAffirmative(text){
  if(/👍|✅/.test(text)) return true;
  const norm = normalizeArabic(text).trim();
  return AFFIRM_WORDS.some(w => norm === normalizeArabic(w) || norm.startsWith(normalizeArabic(w) + ' '));
}
function isNegativeOnly(text){
  if(/👎|❌/.test(text)) return true;
  const norm = normalizeArabic(text).trim();
  return NEGATE_WORDS.some(w => norm === normalizeArabic(w));
}

/* -------- ز) حلقة التأكيد: بتتفعّل لو المستخدم بيرد على سؤال معلّق -------- */
async function resolvePendingFeedback(pendingId, text, feeling){
  const pendRef = PENDING_COL().doc(pendingId);
  const pendSnap = await pendRef.get();
  if(!pendSnap.exists) return null; // مفيش سؤال معلّق بالـ id ده - نكمّل بالتصنيف العادي
  const pend = pendSnap.data();

  if(isAffirmative(text)){
    const learnedId = await promotePendingToLearned(pendRef, pend, pend.proposedAnswer, 'web_confirmed');
    return { confident:true, confirmed:true, learnedId, answer: pend.proposedAnswer, feeling };
  }

  if(isNegativeOnly(text)){
    // 👎 لوحدها من غير تصحيح - بنسيب المسودة معلّقة ونطلب التصحيح صراحة
    return {
      confident: true,
      needsCorrection: true,
      pendingId,
      message: 'تمام، قولّي الإجابة الصح وأنا هتعلمها فوراً 🙏',
      feeling
    };
  }

  // أي رسالة تانية بعد سؤال معلّق = المستخدم بيبعت التصحيح/الإجابة الصح نفسها
  const learnedId = await promotePendingToLearned(pendRef, pend, text.trim(), 'user_corrected');
  return { confident:true, corrected:true, learnedId, answer: text.trim(), feeling };
}

/* =========================================================
   التدريب: بيتنادى تلقائي (Firestore trigger) أي وقت حد يضيف
   مثال أو يستورد ملف أو يصحّح بإيموجي - يعني مفيش زرار "درّب"
   يدوي، السيرفر بيحس بالتغيير ويدرّب نفسه لوحده وبيحفظ النتيجة
   في وثيقة trainedModel، والمتصفح بيقرا منها بس وقت الرد.
   ========================================================= */
exports.onBrainStateChange = onDocumentWritten('miniBrain/sharedState', async (event) => {
  const after = event.data.after;
  if(!after.exists) return;
  const data = after.data();
  const labels = data.labels || [];
  const trainable = (data.examples || []).filter(e=>e.trust!==0);

  if(labels.length===0 || trainable.length===0){
    await MODEL_REF().set({ ready:false, updatedAt: Date.now() });
    return;
  }

  const net = new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, labels.length]);
  for(let e=0;e<EPOCHS;e++){
    for(const ex of trainable){
      const vec = textToVector(ex.text);
      const reps = ex.trust>=1 ? 2 : 1;
      for(let r=0;r<reps;r++) net.trainStep([vec], oneHot(ex.labelIndex, labels.length), LR);
    }
  }

  await MODEL_REF().set({
    ready:true,
    weights: net.layers.map(l=>({ w:l.weights, b:l.bias })),
    labelsCount: labels.length,
    trainedOn: trainable.length,
    updatedAt: Date.now()
  });
});

/* =========================================================
   classify: المتصفح بينادي عليها بس ويبعت النص، والسيرفر يرجّع
   الرد. المتصفح مش شايل ولا سطر شبكة عصبية خالص.

   لو نظام التشابه والشبكة العصبية (الطبقتين الأصليتين) مالقوش رد
   واثق، بتتفعّل طبقة الـ Agent تلقائياً كخطوة أخيرة: بتدوّر على
   أقرب "أداة" ديناميكية مخزّنة في dynamic_tools وتشغّلها جوه الـ
   Sandbox. لو الأداة فشلت أو مفيش أداة قريبة كفاية، الرد بيرجع
   عادي (confident:false) زي ما كان بالظبط قبل الإضافة دي.
   ========================================================= */
exports.classify = onCall({ timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
  const text = (request.data && request.data.text || '').toString();
  if(!text.trim()) throw new HttpsError('invalid-argument', 'الرسالة فاضية');

  const feeling = sentimentScore(tokenize(text)); // نبرة الجملة -1..1، بترجع للواجهة لو حابب تعرضها

  /* ============ دعم سياق المحادثة (History) ============
     الفرونت إند بيبعت آخر 3 رسايل من المحادثة (المستخدم + البوت
     بالتبادل) عشان أسئلة المتابعة القصيرة (زي "طيب وهو فين؟" أو
     "ليه بقى؟") تتفهم صح لما نلجأ للبحث في النت - من غير ما نلمس
     منطق التشابه/الشبكة العصبية نفسه اللي فاضل شغال على النص الخام
     زي ما اتدرّب بالظبط. */
  const history = Array.isArray(request.data && request.data.history)
    ? request.data.history.slice(-3).filter(h => h && typeof h.text === 'string' && h.text.trim())
    : [];

  try{
    return await runClassifyPipeline(text, feeling, request, history);
  }catch(fatalErr){
    // آخر خط دفاع: أي خطأ غير متوقع (Firestore، شبكة، إلخ) في أي
    // مرحلة من المراحل - عمره ما يوصل للفرونت إند كـ Exception يوقّف
    // الرد بالكامل. بدل كده بنسجّله ونرجّع رد آمن يطلب من المستخدم
    // يعلّمنا هو بنفسه، بنفس روح "عدم الاستسلام أبداً".
    console.error('classify fatal error:', fatalErr);
    try{ await UNRESOLVED_COL().add({ question:text, error:String(fatalErr && fatalErr.message||fatalErr), createdAt: Date.now() }); }catch(_){}
    return { confident:true, viaWebSearch:true, searchFoundNothing:true, needsTeaching:true, proposedAnswer:null, feeling };
  }
});

/**
 * runClassifyPipeline: نفس منطق التصنيف بالظبط كان قبل كده جوه
 * exports.classify مباشرة - اتفصل بس في دالة منفصلة عشان نقدر نلفه
 * بـ try/catch شامل واحد فوق من غير ما نكرر نفس الكود جوه كل try.
 */
/**
 * buildContextualQuery: بتركّب نص بحث واحد من آخر رسالة/رسالتين
 * حقيقيين من المستخدم في السجل + الرسالة الحالية - مفيد بس لمسار
 * البحث في النت (مش بيأثر على متجه التصنيف/الشبكة العصبية خالص).
 * بنحد الطول عشان محرك البحث ميرفضش استعلام طويل جداً.
 */
function buildContextualQuery(text, history){
  if(!history || history.length===0) return text;
  const priorUserTexts = history.filter(h => h.role === 'user').map(h => h.text.trim());
  if(priorUserTexts.length===0) return text;
  const combined = (priorUserTexts.slice(-1)[0] + ' ' + text).trim();
  return combined.length > 200 ? text : combined; // لو الدمج طلع طويل أوي منرجعش نص غريب لمحرك البحث
}

async function runClassifyPipeline(text, feeling, request, history){
  /* ============ حلقة التأكيد (Human-in-the-Loop) ============
     لو الفرونت إند بعت pendingId (معناه إن الرسالة دي رد المستخدم
     على سؤال كنا مستنيين تأكيد/تصحيح ليه)، بنعالجها هنا مباشرة
     وما بنكملش مسار التصنيف العادي خالص. */
  const pendingId = request.data && request.data.pendingId;
  if(pendingId){
    const decision = await resolvePendingFeedback(String(pendingId), text, feeling);
    if(decision) return decision;
    // decision === null: الـ pendingId ده مش موجود (اتقفل قبل كده أو
    // غلط) - نكمّل بمسار التصنيف العادي زي أي رسالة جديدة.
  }

  /* ============ أ) فلترة الحشو وتنظيف النص ============
     tokenize() جوه textToVector بيشيل كلمات الحشو والترحيب
     (تمام/طيب/بقولك/يا عم...) تلقائياً قبل أي حساب - مفيش خطوة
     منفصلة هنا لأنها متضمّنة جوه بناء المتجه نفسه. */

  /* ============ ب) فحص لو الرسالة معادلة رياضية ============
     بيتشغّل قبل أي بحث في قاعدة البيانات - لو الرسالة معادلة
     حسابية صافية بنحلها فوراً بمحرك آمن (من غير eval) ونرجّع
     الناتج، من غير ما نضيّع وقت في البحث عن تشابه أو تشغيل شبكة. */
  const mathAnswer = tryEvalMathExpression(text);
  if(mathAnswer !== null){
    return { confident:true, isMath:true, mathAnswer, confidence:1, feeling };
  }

  /* ============ ب-١) فحص لو الرسالة كلام دارج/تحية ============
     بيتفحص قبل أي بحث في قاعدة البيانات أو النت - عشان تحية زي
     "السلام عليكم" أو "عامل ايه" ترجع رد محادثة طبيعي فورًا، وميحصلش
     بحث في النت يجيب نتايج مش مناسبة (فتاوى، كلمات أغاني...). */
  const smallTalkAnswer = detectSmallTalk(text);
  if(smallTalkAnswer !== null){
    return { confident:true, viaSmallTalk:true, answer: smallTalkAnswer, confidence:1, feeling };
  }

  const [stateSnap, modelSnap] = await Promise.all([STATE_REF().get(), MODEL_REF().get()]);
  if(!stateSnap.exists) return { confident:false, confidence:0, feeling };
  const state = stateSnap.data();
  const labels = state.labels || [];
  const usable = (state.examples || []).filter(e=>e.trust!==0);
  if(usable.length===0) return { confident:false, confidence:0, feeling };

  /* ============ ج) البحث عن أقرب معنى بالـ Cosine Similarity ============
     بنحسب جدول IDF من كل الأمثلة المتاحة (كلمة نادرة/مميزة زي
     "حنفية" وزنها عالي، كلمة شائعة عابرة زي "اسألك" وزنها بيقرب
     من صفر) وبنستخدمه بس في خطوة التشابه - الشبكة العصبية تحت
     فضلت شغالة بالمتجه الخام العادي عشان متبقاش أوزانها المدرّبة
     قبل كده متسقة مع مساحة متجه مختلفة. */
  const idf = buildIdfTable(usable);
  const vec = textToVector(text, idf);       // للتشابه (موزون بالنية)
  const vecRaw = textToVector(text);         // للشبكة العصبية (خام، زي التدريب بالظبط)

  let bestSim=-1, bestExample=null;
  for(const ex of usable){
    const exVec = textToVector(ex.text, idf);
    const sim = cosineSim(vec, exVec) * (0.6 + 0.4*ex.trust);
    if(sim>bestSim){ bestSim=sim; bestExample=ex; }
  }
  const simLabel = bestExample ? labels.find(l=>l.index===bestExample.labelIndex) : null;

  // الشبكة العصبية المدرّبة (محفوظة من الـ trigger فوق) - بالمتجه الخام
  let nnLabel=null, nnConf=0;
  if(modelSnap.exists && modelSnap.data().ready){
    const net = new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, labels.length], modelSnap.data().weights);
    const out = net.predict([vecRaw])[0];
    let bestIdx=-1, bestVal=-1;
    for(const lab of labels){ if(out[lab.index]>bestVal){ bestVal=out[lab.index]; bestIdx=lab.index; } }
    if(bestIdx!==-1){ nnLabel = labels.find(l=>l.index===bestIdx); nnConf = bestVal; }
  }

  // نفس منطق القرار الأصلي بالظبط، بس بدل ما نعمل return فوري
  // بنحفظه في result عشان نقدر نكمّل بمحرك التوليد وطبقة الـ Agent
  let result;
  if(simLabel && nnLabel && simLabel.index===nnLabel.index){
    const combined = Math.min(1, bestSim*0.7 + nnConf*0.3 + 0.08);
    result = combined < CONFIDENCE_THRESHOLD
      ? { confident:false, confidence:combined, feeling }
      : { confident:true, confidence:combined, label:simLabel, matchedExampleId: bestExample.id, feeling };
  } else if(bestSim >= CONFIDENCE_THRESHOLD){
    result = { confident:true, confidence:bestSim, label:simLabel, matchedExampleId: bestExample.id, feeling };
  } else if(nnConf >= CONFIDENCE_THRESHOLD+0.15){
    result = { confident:true, confidence:nnConf, label:nnLabel, matchedExampleId:null, feeling };
  } else {
    result = { confident:false, confidence:Math.max(bestSim,0), feeling };
  }

  /* ============ د-١) البحث في المعرفة "المعمّدة" (learned_knowledge) ============
     لو الطبقتين الأصليتين (الأمثلة + الشبكة العصبية) مالقوش رد واثق،
     قبل ما نروح نبحث في النت، بنشوف الأول لو إحنا اتعلمنا إجابة
     لسؤال شبيه قبل كده واتأكدت من المستخدم - لو لقينا، بنردّ بيها
     فوراً من غير أي بحث جديد. */
  if(!result.confident){
    try{
      const { learned, sim } = await findBestLearned(vecRaw);
      if(learned && sim >= LEARNED_SIM_THRESHOLD){
        result = {
          confident: true,
          viaLearnedKnowledge: true,
          learnedId: learned.id,
          answer: learned.answer,
          confidence: sim,
          feeling
        };
      }
    }catch(learnedErr){
      console.error('learned_knowledge lookup error:', learnedErr);
    }
  }

  /* ============ د) محرك الـ N-Gram التوليدي ============
     لو الفئة اللي اتطابقت معاها عندها أكتر من رد واحد مخزّن،
     يبقى محتاجة "صياغة جديدة" بدل ما نختار رد ثابت عشوائي - بنولّد
     جملة ممزوجة من كل الصياغات المتعلّمة بنموذج Bigram محلي. لو
     التوليد طلع قصير جداً أو فاشل، بنسيب الفرونت إند يختار من
     الردود الجاهزة زي ما كان (fallback آمن). */
  if(result.confident && result.label && Array.isArray(result.label.responses) && result.label.responses.length>1){
    const bigram = buildBigramModel(result.label.responses);
    const generated = generateFromBigram(bigram);
    if(generated && generated.trim().split(/\s+/).length>=3){
      result.generatedResponse = generated;
    }
  }

  // ه) طبقة الـ Agent: تتفعّل بس لو كل الطبقات فوق مالقتش رد واثق
  if(!result.confident){
    try{
      const { tool, sim } = await findBestTool(vecRaw);
      if(tool && sim >= TOOL_SIM_THRESHOLD){
        const toolRef = TOOLS_COL().doc(tool.id);
        const outcome = runCodeInSandbox(tool.code, text);
        await handleToolOutcome(toolRef, tool, outcome, text);
        if(outcome.ok){
          result = {
            confident: true,
            viaTool: true,
            toolId: tool.id,
            toolName: tool.name,
            toolResult: outcome.result,
            confidence: sim,
            feeling
          };
        }
        // لو outcome.ok كانت false: الخطأ اتسجل في tool_errors والأداة
        // اتصحّحت ذاتياً (عداد أخطاء/إيقاف)، ونسيب result زي ما هي
        // (confident:false) عشان الرد يرجع نص عادي من غير ما يهنج حد.
      }
    }catch(toolErr){
      // أي خطأ غير متوقع في طبقة الأدوات نفسها (زي مشكلة اتصال
      // بـ Firestore) لازم منقفلش السيرفر - بنسجّله ونكمّل برد عادي
      console.error('agent tool layer error:', toolErr);
    }
  }

  /* ============ و) مسار "عدم الاستسلام أبداً" (Zero-Failure Fallback) ============
     دي آخر محطة قبل الرد. لو كل الطبقات فوق (أمثلة + شبكة عصبية +
     معرفة معمّدة + أدوات ديناميكية) فشلت تلاقي رد واثق، ممنوع نرجّع
     confident:false زي الأول - بدل كده بندخل دورة البحث والتصفية
     والتعلم من النت مباشرة. */
  if(!result.confident){
    try{
      const searchQuery = buildContextualQuery(text, history);
      result = await runWebLearningFallback(text, vecRaw, searchQuery);
    }catch(webErr){
      // حتى لو دورة البحث نفسها فشلت (مشكلة شبكة مثلاً)، برضو ممنوع
      // نرجّع اعتذار جاهز - بنسجّل السؤال للمراجعة ونطلب من المستخدم
      // يعلّمنا هو بنفسه بدل ما نتوقف.
      console.error('web learning fallback error:', webErr);
      try{ await UNRESOLVED_COL().add({ question:text, error:String(webErr && webErr.message||webErr), createdAt: Date.now() }); }catch(_){}
      result = { confident:true, viaWebSearch:true, searchFoundNothing:true, needsTeaching:true, proposedAnswer:null, feeling };
    }
  }

  return result;
}

/* =========================================================
   confirmPendingKnowledge / rejectPendingKnowledge:
   نفس منطق resolvePendingFeedback بالظبط، لكن كـ API صريحة لو
   الفرونت إند بيفضّل زرار 👍/👎 بدل ما يستنى رسالة نصية جديدة.
   ========================================================= */
exports.confirmPendingKnowledge = onCall(async (request) => {
  const { pendingId } = request.data || {};
  if(!pendingId) throw new HttpsError('invalid-argument', 'ناقص pendingId');
  const pendRef = PENDING_COL().doc(String(pendingId));
  const pendSnap = await pendRef.get();
  if(!pendSnap.exists) throw new HttpsError('not-found', 'مفيش سؤال معلّق بالـ id ده (يمكن اتقفل قبل كده)');
  const pend = pendSnap.data();
  const learnedId = await promotePendingToLearned(pendRef, pend, pend.proposedAnswer, 'web_confirmed');
  return { ok:true, learnedId, answer: pend.proposedAnswer };
});

exports.rejectPendingKnowledge = onCall(async (request) => {
  const { pendingId, correctedAnswer } = request.data || {};
  if(!pendingId) throw new HttpsError('invalid-argument', 'ناقص pendingId');
  if(!correctedAnswer || !String(correctedAnswer).trim()){
    throw new HttpsError('invalid-argument', 'لازم تبعت الإجابة الصح بدل المسودة المرفوضة');
  }
  const pendRef = PENDING_COL().doc(String(pendingId));
  const pendSnap = await pendRef.get();
  if(!pendSnap.exists) throw new HttpsError('not-found', 'مفيش سؤال معلّق بالـ id ده (يمكن اتقفل قبل كده)');
  const pend = pendSnap.data();
  const learnedId = await promotePendingToLearned(pendRef, pend, String(correctedAnswer).trim(), 'user_corrected');
  return { ok:true, learnedId, answer: String(correctedAnswer).trim() };
});

/* =========================================================
   addExample: تعليم مثال واحد (من كارت "علّمها")
   ========================================================= */
exports.addExample = onCall(async (request) => {
  const { text, labelName, response } = request.data || {};
  if(!text || !response) throw new HttpsError('invalid-argument', 'ناقص نص أو رد');

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(STATE_REF());
    const cur = snap.exists ? snap.data() : { labels: [], examples: [], emojiMeanings: {} };
    cur.labels = cur.labels || []; cur.examples = cur.examples || [];

    const name = (labelName || '').trim() || ('فئة_' + (cur.labels.length + 1));
    let label = cur.labels.find(l => l.name === name);
    if(!label){ label = { index: cur.labels.length, name, responses: [] }; cur.labels.push(label); }
    if(!label.responses.includes(response)) label.responses.push(response);

    cur.examples.push({
      id: 'ex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8),
      text, labelIndex: label.index, trust: 0.75
    });
    cur.updatedAt = Date.now();
    tx.set(STATE_REF(), cur);
    return { ok:true, labelName: name, labelIndex: label.index };
  });
});

/* =========================================================
   bulkImport: استيراد جماعي - نص الملف بالكامل يتبعت مرة واحدة،
   والسيرفر هو اللي بيقسّمه ويحفظه ويدرّب - المتصفح مش بيعمل أي
   حساب تقيل خالص حتى وقت الاستيراد.
   ========================================================= */
exports.bulkImport = onCall(async (request) => {
  const lines = (request.data && request.data.lines) || [];
  if(!Array.isArray(lines) || lines.length===0) throw new HttpsError('invalid-argument', 'مفيش سطور');

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(STATE_REF());
    const cur = snap.exists ? snap.data() : { labels: [], examples: [], emojiMeanings: {} };
    cur.labels = cur.labels || []; cur.examples = cur.examples || [];

    let added = 0, skipped = 0;
    for(const line of lines){
      const parts = String(line).split('|').map(p => p.trim());
      if(parts.length < 3 || !parts[0] || !parts[1] || !parts[2]){ skipped++; continue; }
      const [catName, msg, resp] = parts;
      let label = cur.labels.find(l => l.name === catName);
      if(!label){ label = { index: cur.labels.length, name: catName, responses: [] }; cur.labels.push(label); }
      if(!label.responses.includes(resp)) label.responses.push(resp);
      cur.examples.push({
        id: 'ex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8) + '_' + added,
        text: msg, labelIndex: label.index, trust: 0.75
      });
      added++;
    }
    cur.updatedAt = Date.now();
    tx.set(STATE_REF(), cur);
    return { added, skipped };
  });
});

/* =========================================================
   submitFeedback: تصحيح بالإيموجي (trust=1 صح / trust=0 غلط)
   ========================================================= */
exports.submitFeedback = onCall(async (request) => {
  const { exampleId, score } = request.data || {};
  if(!exampleId || (score!==0 && score!==1)) throw new HttpsError('invalid-argument', 'بيانات ناقصة');

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(STATE_REF());
    if(!snap.exists) throw new HttpsError('not-found', 'مفيش حالة محفوظة');
    const cur = snap.data();
    const ex = (cur.examples || []).find(e => e.id === exampleId);
    if(!ex) throw new HttpsError('not-found', 'المثال ده مش موجود');
    ex.trust = score;
    cur.updatedAt = Date.now();
    tx.set(STATE_REF(), cur);
    return { ok:true };
  });
});

/* =========================================================
   learnEmoji: حفظ معنى إيموجي جديد اتعلمه العقل
   ========================================================= */
exports.learnEmoji = onCall(async (request) => {
  const { emoji, score } = request.data || {};
  if(!emoji || (score!==0 && score!==1)) throw new HttpsError('invalid-argument', 'بيانات ناقصة');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(STATE_REF());
    const cur = snap.exists ? snap.data() : { labels: [], examples: [], emojiMeanings: {} };
    cur.emojiMeanings = cur.emojiMeanings || {};
    cur.emojiMeanings[emoji] = score;
    cur.updatedAt = Date.now();
    tx.set(STATE_REF(), cur);
    return { ok:true };
  });
});

/* =========================================================
   resetBrain: مسح كل حاجة
   ========================================================= */
exports.resetBrain = onCall(async () => {
  await STATE_REF().set({ labels: [], examples: [], emojiMeanings: {}, updatedAt: Date.now() });
  await MODEL_REF().set({ ready:false, updatedAt: Date.now() });
  return { ok:true };
});

/* =========================================================
   ============  Dynamic Tools API (طبقة الـ Agent)  ==========
   ========================================================= */

/**
 * saveDynamicTool: حفظ "مهارة" جديدة (دالة JS) اتعلمها الموديول.
 * قبل الحفظ بنجرّب الكود فعلياً جوه الـ Sandbox عشان نتأكد إنه
 * شغال ومش هيكسر حاجة وقت الاستخدام الحقيقي.
 *
 * البيانات المتوقعة: { name, keywords, description, code, testInput? }
 */
exports.saveDynamicTool = onCall(async (request) => {
  const { name, keywords, description, code, testInput } = request.data || {};
  if(!name || !code) throw new HttpsError('invalid-argument', 'ناقص اسم الأداة أو الكود');
  if(typeof code !== 'string' || code.length > 20000){
    throw new HttpsError('invalid-argument', 'الكود لازم يكون نص وأقل من 20000 حرف');
  }

  const test = runCodeInSandbox(code, testInput !== undefined ? testInput : '');
  if(!test.ok){
    throw new HttpsError('invalid-argument', 'الكود فشل في اختبار ما قبل الحفظ: ' + test.error);
  }

  const vecText = [name, keywords, description].filter(Boolean).join(' ');
  const vector = textToVector(vecText);

  const doc = {
    name: String(name).slice(0,120),
    keywords: keywords ? String(keywords).slice(0,300) : '',
    description: description ? String(description).slice(0,500) : '',
    code,
    vector,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usageCount: 0,
    errorCount: 0,
    disabled: false,
    lastError: null
  };
  const ref = await TOOLS_COL().add(doc);
  return { ok:true, toolId: ref.id, testResult: test.result };
});

/**
 * runDynamicTool: تشغيل يدوي/مباشر لأداة معروف الـ id بتاعها -
 * مفيد للاختبار من لوحة تحكم، أو لو حابب تشغّل أداة معينة بنفسك
 * من غير المرور بمنطق التشابه في classify.
 */
exports.runDynamicTool = onCall(async (request) => {
  const { toolId, input } = request.data || {};
  if(!toolId) throw new HttpsError('invalid-argument', 'ناقص toolId');

  const ref = TOOLS_COL().doc(toolId);
  const snap = await ref.get();
  if(!snap.exists) throw new HttpsError('not-found', 'الأداة دي مش موجودة');
  const tool = snap.data();
  if(tool.disabled){
    return { ok:false, disabled:true, error:'الأداة دي متوقفة تلقائياً بسبب أخطاء متكررة' };
  }

  const outcome = runCodeInSandbox(tool.code, input);
  await handleToolOutcome(ref, tool, outcome, input);

  if(!outcome.ok) return { ok:false, error: outcome.error, timedOut: !!outcome.timedOut };
  return { ok:true, result: outcome.result, logs: outcome.logs || [] };
});

/**
 * listDynamicTools: عرض الأدوات المخزّنة (للوحة تحكم/مراجعة) -
 * من غير حقل الكود الكامل عشان الحمولة تفضل خفيفة.
 */
exports.listDynamicTools = onCall(async () => {
  const snap = await TOOLS_COL().orderBy('createdAt','desc').limit(200).get();
  const tools = [];
  snap.forEach(doc => {
    const t = doc.data();
    tools.push({
      id: doc.id, name: t.name, keywords: t.keywords, description: t.description,
      usageCount: t.usageCount || 0, errorCount: t.errorCount || 0,
      disabled: !!t.disabled, lastError: t.lastError || null,
      createdAt: t.createdAt, updatedAt: t.updatedAt
    });
  });
  return { tools };
});

/**
 * toggleDynamicTool: تفعيل/تعطيل يدوي لأداة (مثلاً بعد ما تتصحّح
 * يدوياً بعد ما اتوقفت تلقائياً بسبب أخطاء متكررة).
 */
exports.toggleDynamicTool = onCall(async (request) => {
  const { toolId, disabled } = request.data || {};
  if(!toolId || typeof disabled !== 'boolean') throw new HttpsError('invalid-argument', 'بيانات ناقصة');
  const ref = TOOLS_COL().doc(toolId);
  const snap = await ref.get();
  if(!snap.exists) throw new HttpsError('not-found', 'الأداة دي مش موجودة');
  const update = { disabled, updatedAt: Date.now() };
  if(disabled === false) update.errorCount = 0; // بنديها فرصة جديدة نظيفة
  await ref.update(update);
  return { ok:true };
});

/* =========================================================
   ============  لوحة الإدارة: الأسئلة المعلّقة  ==========
   ========================================================= */

/**
 * listPendingKnowledge: عرض مسودات الإجابات الجاية من البحث في
 * النت واللي لسه مستنية تأكيد/رفض - بتتستخدم في تاب "الأسئلة
 * المعلّقة" في لوحة الإدارة بالفرونت إند.
 */
exports.listPendingKnowledge = onCall(async () => {
  const snap = await PENDING_COL().orderBy('createdAt', 'desc').limit(200).get();
  const items = [];
  snap.forEach(doc => {
    const d = doc.data();
    items.push({
      id: doc.id,
      question: d.question,
      proposedAnswer: d.proposedAnswer,
      sources: d.sources || [],
      createdAt: d.createdAt
    });
  });
  return { items };
});

/* =========================================================
   ============  Scheduled Cleanup (صيانة دورية يومية)  ==========
   -----------------------------------------------------------
   شغالة تلقائياً مرة كل يوم (٣ الفجر بتوقيت القاهرة) - بتنضّف:
   - tool_errors الأقدم من ٣٠ يوم (سجلات مراجعة قديمة خلاص).
   - unresolved_queries الأقدم من ٣٠ يوم (أسئلة اتسجلت للمراجعة
     ومحدش راجعها خلال شهر كامل - بنسيبها تروح عشان القاعدة متتضخمش).
   الحذف على دفعات (batch) بحد أقصى ٤٠٠ وثيقة في كل commit عشان
   نفضل تحت حد الـ 500 اللي Firestore بيسمح بيه لكل batch.
   ========================================================= */
const CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 يوم
const CLEANUP_BATCH_SIZE = 400;

async function deleteOldDocs(colRef, cutoff){
  let totalDeleted = 0;
  while(true){
    const snap = await colRef.where('createdAt', '<', cutoff).limit(CLEANUP_BATCH_SIZE).get();
    if(snap.empty) break;
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    totalDeleted += snap.size;
    if(snap.size < CLEANUP_BATCH_SIZE) break; // مفيش أكتر من كده حالياً
  }
  return totalDeleted;
}

exports.dailyCleanup = onSchedule({
  schedule: 'every day 03:00',
  timeZone: 'Africa/Cairo',
  region: 'us-central1'
}, async () => {
  const cutoff = Date.now() - CLEANUP_MAX_AGE_MS;
  try{
    const [deletedErrors, deletedUnresolved] = await Promise.all([
      deleteOldDocs(TOOL_ERRORS_COL(), cutoff),
      deleteOldDocs(UNRESOLVED_COL(), cutoff)
    ]);
    console.log(`dailyCleanup: حُذف ${deletedErrors} من tool_errors و ${deletedUnresolved} من unresolved_queries (أقدم من 30 يوم).`);
  }catch(e){
    console.error('dailyCleanup فشلت:', e);
  }
});

/* =========================================================
   ============  بصمة صوت البوت (Voice Cloning & TTS)  ==========
   -----------------------------------------------------------
   الفكرة: أول مستخدم يسجّل مقطع صوتي قصير (10-15 ثانية) مرة واحدة
   بس، بيتبعت للسيرفر، والسيرفر (مش المتصفح) هو اللي بيكلّم ElevenLabs
   بمفتاح الـ API المخزّن كـ Secret، وبيحفظ الـ voice_id الناتج في
   system_settings/voice. بعد كده أي رد بيطلع صوت، بيتحوّل نص→صوت
   بنفس الـ voice_id ده لكل المستخدمين - يعني صوت البوت موحّد وهو
   صوت أول شخص سجّل، مهما كان بيكلمه مين.
   ========================================================= */

/**
 * getVoiceStatus: بيرجّع بس هل فيه صوت متسجّل قبل كده ولا لأ - من
 * غير ما نكشف أي تفاصيل حساسة (زي الـ voice_id الخام نفسه للمتصفح
 * لو مش لازم). الفرونت إند بيستخدمها عشان يقرر يعرض نافذة التسجيل
 * الأول مرة ولا لأ.
 */
exports.getVoiceStatus = onCall(async () => {
  const snap = await VOICE_DOC().get();
  const data = snap.exists ? snap.data() : null;
  return { hasVoice: !!(data && data.owner_voice_id), createdAt: data ? data.createdAt : null };
});

/**
 * createVoiceProfile: بتستقبل مقطع صوتي (base64) من أول مستخدم،
 * بتبعته لـ ElevenLabs عشان يبني "بصمة صوت" (Voice Clone)، وبتحفظ
 * الـ voice_id الناتج في system_settings/voice. لو فيه صوت متسجّل
 * قبل كده أصلاً، بترفض تسجّل تاني فوقه (عشان يفضل صوت واحد موحّد) -
   إلا لو overwrite:true اتبعتت صراحة (لإعادة التسجيل عمداً).
 */
exports.createVoiceProfile = onCall({ secrets: [ELEVENLABS_API_KEY], timeoutSeconds: 60 }, async (request) => {
  const { audioBase64, mimeType, overwrite } = request.data || {};
  if(!audioBase64) throw new HttpsError('invalid-argument', 'مفيش مقطع صوتي متبعوت');

  const existing = await VOICE_DOC().get();
  if(existing.exists && existing.data().owner_voice_id && !overwrite){
    throw new HttpsError('already-exists', 'فيه صوت متسجّل قبل كده - ابعت overwrite:true لو عايز تستبدله');
  }

  const apiKey = ELEVENLABS_API_KEY.value();
  if(!apiKey) throw new HttpsError('failed-precondition', 'مفتاح ElevenLabs مش متسجّل على السيرفر');

  let audioBuffer;
  try{
    audioBuffer = Buffer.from(String(audioBase64), 'base64');
  }catch(e){
    throw new HttpsError('invalid-argument', 'صيغة الصوت (base64) غلط');
  }
  if(audioBuffer.length < 1000) throw new HttpsError('invalid-argument', 'المقطع الصوتي قصير جداً أو فاضي');
  if(audioBuffer.length > 10 * 1024 * 1024) throw new HttpsError('invalid-argument', 'المقطع الصوتي أكبر من اللازم (حد أقصى 10 ميجا)');

  try{
    const form = new FormData();
    form.append('name', 'MiniBrain_Owner_Voice_' + Date.now());
    form.append('files', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), 'sample.webm');
    form.append('description', 'صوت موحّد لكل ردود العقل الصغير');

    const res = await fetch(ELEVENLABS_BASE + '/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form
    });
    const data = await res.json();
    if(!res.ok || !data.voice_id){
      console.error('ElevenLabs add voice failed:', data);
      throw new HttpsError('internal', 'فشل إنشاء بصمة الصوت عند ElevenLabs: ' + (data.detail && data.detail.message || JSON.stringify(data)));
    }
    await VOICE_DOC().set({
      owner_voice_id: data.voice_id,
      provider: 'elevenlabs',
      createdAt: Date.now()
    });
    return { ok:true, voiceId: data.voice_id };
  }catch(e){
    if(e instanceof HttpsError) throw e;
    console.error('createVoiceProfile error:', e);
    throw new HttpsError('internal', 'حصل خطأ غير متوقع أثناء إنشاء بصمة الصوت');
  }
});

/**
 * synthesizeSpeech: بتحوّل أي نص لصوت بصوت الـ owner_voice_id
 * المحفوظ (لو موجود) - وترجّع الصوت كـ base64 عشان المتصفح يشغّله
 * مباشرة. لو مفيش voice_id متسجّل أصلاً، بترجّع hasVoice:false
 * والفرونت إند وقتها بيرجع لـ Web Speech API العادي (SpeechSynthesis)
 * كـ fallback بدل ما يوقف.
 */
exports.synthesizeSpeech = onCall({ secrets: [ELEVENLABS_API_KEY], timeoutSeconds: 30 }, async (request) => {
  const { text } = request.data || {};
  if(!text || !String(text).trim()) throw new HttpsError('invalid-argument', 'مفيش نص للتحويل لصوت');

  const voiceSnap = await VOICE_DOC().get();
  const ownerVoiceId = voiceSnap.exists ? voiceSnap.data().owner_voice_id : null;
  if(!ownerVoiceId) return { ok:true, hasVoice:false };

  const apiKey = ELEVENLABS_API_KEY.value();
  if(!apiKey) return { ok:true, hasVoice:false };

  try{
    const cleanText = String(text).replace(/[*_`#>]/g, '').slice(0, 2000); // شيل رموز الماركداون قبل التحويل لصوت
    const res = await fetch(ELEVENLABS_BASE + '/text-to-speech/' + ownerVoiceId, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    });
    if(!res.ok){
      const errText = await res.text();
      console.error('ElevenLabs TTS failed:', errText);
      return { ok:true, hasVoice:true, error:'فشل توليد الصوت' };
    }
    const arrayBuf = await res.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuf).toString('base64');
    return { ok:true, hasVoice:true, audioBase64, mimeType:'audio/mpeg' };
  }catch(e){
    console.error('synthesizeSpeech error:', e);
    return { ok:true, hasVoice:true, error:'حصل خطأ غير متوقع أثناء توليد الصوت' };
  }
});
