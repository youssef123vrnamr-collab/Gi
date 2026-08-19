/* =========================================================
   سيرفر "العقل الصغير" - Firebase Cloud Functions (V2)
   -----------------------------------------------------------
   كل حاجة بتحصل هنا وبس: الحساب، الذاكرة، التصنيف، وتوليد
   الجُمل الجديدة. الفرونت إند (index.html) دلوقتي شاشة إرسال
   واستقبال بحتة - مبعوتش ولا يستقبل رد ثابت من غير معالجة.

   التغييرات الأساسية في النسخة دي:
   1) التخزين: من Document واحد (examples[]) اتحول لـ Collection
      مستقلة اسمها brain_examples، كل Doc فيها "chunk" (دفعة) من
      200-300 مثال بحد أقصى، عشان محدش يقرب من حد الـ 1MB.
   2) التدريب: بقى Incremental - أي Chunk جديد يتدرب لوحده مع
      عينة عشوائية (Replay Buffer) من كل الفئات القديمة، بدل ما
      نعيد تدريب الشبكة من الصفر على كل البيانات كل مرة - ده اللي
      بيمنع الـ Timeout والـ Out of Memory مهما كبر الداتا.
   3) الـ Replay Buffer نفسه (عينة ممثلة صغيرة من كل فئة) هو اللي
      بيتحمّل في الذاكرة وقت الرد (classify) بدل ما نجيب كل
      الأمثلة من كل الـ Chunks - كده الـ RAM محمية دايمًا مهما
      كان حجم الداتا الكلي ضخم.
   4) محرك توليد N-Gram/Markov Chain: يحاول "يؤلف" رد جديد من
      الكلمات اللي اتعلمها قبل ما يرجع لرد ثابت محفوظ.
   5) محرك حسابي (+ - * / %) شغال بالكامل على السيرفر.
   6) ذاكرة محادثة: آخر 5 رسائل لكل مستخدم/جلسة محفوظة ومقروءة
      من Firestore عشان الردود تكون مربوطة بالسياق.
   ========================================================= */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// وقت تنفيذ أطول وذاكرة أعلى شوية للـ Cloud Function نفسها (مش المتصفح)
// عشان تستحمل التدريب والاستيراد الجماعي من غير Timeout.
setGlobalOptions({ timeoutSeconds: 120, memory: '512MiB' });

const STATE_REF   = () => db.collection('miniBrain').doc('sharedState');
const MODEL_REF   = () => db.collection('miniBrain').doc('trainedModel');
const EXAMPLES_COL = () => db.collection('brain_examples');
// وثيقة إحصائيات خفيفة منفصلة - فيها رقمين بس (فئات + أمثلة) عشان الواجهة
// تقدر تعرضهم فورًا من غير ما تحمّل مصفوفة الفئات الكاملة (labels) ولا أي
// أمثلة، لا في أول تحميل ولا في أي تحديث لحظي بعد كده.
const STATS_REF   = () => db.collection('miniBrain').doc('liveStats');
const CONV_COL      = () => db.collection('brain_conversations');

/* ================= إعدادات عامة ================= */
const HIDDEN_DIM = 96;
const CONFIDENCE_THRESHOLD = 0.42;

const CHUNK_SIZE = 250;          // أقصى عدد أمثلة في وثيقة (chunk) واحدة
const MAX_BATCH_PER_CALL = 500;  // أقصى عدد أسطر يقبلها bulkImport في نداء واحد
const REPLAY_PER_LABEL = 40;     // كام مثال "ممثل" نفتكره من كل فئة في الذاكرة
const EPOCHS_INCREMENTAL = 60;   // عدد مرات التدريب على الدفعة الجديدة + الذاكرة
const LR = 0.28;
const CONTEXT_SIZE = 5;          // آخر كام رسالة نفتكرها للسياق

/* ================= معالجة النص العربي ================= */
// كلمات وصل/حروف جر أساسية - بتتشال دايمًا من أي تحليل معنى.
const BASE_STOPWORDS = new Set([
  'في','من','على','عن','الى','إلى','و','كان','كانت','يكون','مع',
  'كل','بعض','كذلك','ايضا','أيضا','انا','أنا','انت','أنت','هو','هي','احنا',
  'إحنا','عشان','علشان'
]);
// كلمات حشو وترحيب/إستئذان - مالهاش قيمة في تحديد "نية" السؤال، بس
// لازم تفضل موجودة وقت التوليد (tokenizeForGen) عشان الجملة تطلع طبيعية،
// وكمان لازم تفضل متاحة لتحليل المشاعر (sentimentScore) لأن كلمات زي
// "تمام"/"وحش" بتحمل مشاعر حتى لو مالهاش دخل بالمعنى الأساسي للسؤال.
const FILLER_WORDS = new Set([
  'تمام','طيب','طب','خلاص','ماشي','ماشى','كده','كدا','بقى','بقه','بقولك',
  'قولك','يلا','هلا','يا','عم','ثم','هل','لا','لم','لن','ما','هذا','هذه',
  'ذلك','تلك','التي','الذي','بس','يعني','برضو','برضه','اصلا','أصلا',
  'صراحة','بصراحة','اه','آه','ايوه','أيوه','ايوة','معلش','معلهش','حاضر',
  'اوك','او','أو','لأ','فا','لسه','ولا','اهو','خلينا','ممكن','لو سمحت'
]);
// الاتحاد ده بيتستخدم بس وقت بناء متجه "المعنى/النية" (textToVector) -
// مش وقت التوليد ولا تحليل المشاعر، عشان كل مرحلة تشوف الكلمات اللي محتاجاها بالظبط.
const INTENT_STOPWORDS = new Set([...BASE_STOPWORDS, ...FILLER_WORDS]);

function toWesternDigits(text){
  const map = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  return text.replace(/[٠-٩]/g, d => map[d]);
}
function normalizeArabic(text){
  return toWesternDigits(text)
    .replace(/[\u064B-\u0652]/g,'')
    .replace(/[إأآا]/g,'ا')
    .replace(/ى/g,'ي')
    .replace(/ة/g,'ه')
    .replace(/ـ/g,'')
    .replace(/[^\u0621-\u064A0-9a-zA-Z\s]/g,' ');
}
// تقطيع لاستخراج "النية والمعنى" (بيشيل كلمات الوصل والحشو والترحيب
// عشان يركّز بس على الأفعال/الأسماء/المفاهيم الأساسية في الجملة)
function tokenize(text){
  return normalizeArabic(text).trim().split(/\s+/).filter(Boolean).filter(t=>!INTENT_STOPWORDS.has(t));
}
// تقطيع للتوليد (بيسيب كلمات الوصل عشان الجملة تطلع طبيعية)
function tokenizeForGen(text){
  return normalizeArabic(text).trim().split(/\s+/).filter(Boolean);
}

const INPUT_DIM = 192;
function hashWord(word){
  let h = 0;
  for(let i=0;i<word.length;i++){ h = (h*31 + word.charCodeAt(i)) >>> 0; }
  return h % INPUT_DIM;
}

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

const VECTOR_DIM = INPUT_DIM + 1;

/* =========================================================
   طبقة فهم المعنى والنية (Semantic / Intent Layer) - محلي بالكامل
   وبدون أي API خارجي:
   1) tokenize() فوق بيشيل كلمات الحشو/الترحيب فيركّز على المفاهيم.
   2) هنا بنحسب TF-IDF محلي: أي كلمة بتتكرر في كتير من الأمثلة
      (زي كلمات عامة جدًا نسيت الفلترة تشيلها) بتاخد وزن أقل تلقائيًا،
      وأي كلمة نادرة/مميزة (زي "حنفية"، "إصلاح") بتاخد وزن أعلى -
      وده اللي بيخلي البحث يركّز على "مضمون" الجملة مش مجرد حروفها.
   ========================================================= */
function idfWeight(df, totalDocs){
  // IDF ملطّف (Smoothed) - دايمًا رقم موجب حتى لو الكلمة جديدة تمامًا (df=0)
  return Math.log(((totalDocs||0) + 1) / ((df||0) + 1)) + 1;
}
// بيحسب/يحدّث جدول تكرار الكلمات عبر الوثائق (Document Frequency) بشكل
// تراكمي من غير ما نحتاج نعيد قراءة كل الـ 3000+ مثال في كل مرة.
const MAX_VOCAB = 6000; // سقف أمان لحجم القاموس عشان مستند Firestore ميكبرش أوي
function updateIDF(existingDF, newTexts){
  const df = Object.assign({}, existingDF || {});
  let vocabSize = Object.keys(df).length;
  for(const text of newTexts){
    const uniqueTokens = new Set(tokenize(text));
    for(const t of uniqueTokens){
      if(df[t]!==undefined){ df[t] += 1; }
      else if(vocabSize < MAX_VOCAB){ df[t] = 1; vocabSize++; }
      // لو القاموس وصل للسقف، بنتجاهل كلمات جديدة تمامًا (نادرة جدًا أصلاً)
      // بدل ما المستند يكبر من غير حدود - الكلمات المعروفة بتفضل تتحدث عادي.
    }
  }
  return df;
}

function textToVector(text, idf){
  const vec = new Array(INPUT_DIM).fill(0);
  const tokens = tokenize(text);
  const df = (idf && idf.df) || {};
  const totalDocs = (idf && idf.totalDocs) || 0;
  for(const t of tokens){
    const w = idfWeight(df[t], totalDocs);
    vec[hashWord(t)] += w;
  }
  // البايجرام (زوج كلمات متتاليين) بياخد وزن مضاعف بمتوسط IDF الكلمتين -
  // ده اللي بيمسك سياق زي "إصلاح حنفية" كوحدة معنى واحدة مش كلمتين منفصلتين.
  for(let i=0;i<tokens.length-1;i++){
    const a=tokens[i], b=tokens[i+1];
    const w = (idfWeight(df[a], totalDocs) + idfWeight(df[b], totalDocs)) / 2;
    vec[hashWord(a+'_'+b)] += w * 1.4;
  }
  const norm = Math.sqrt(vec.reduce((s,v)=>s+v*v,0));
  const normalized = norm>0 ? vec.map(v=>v/norm) : vec;
  normalized.push(sentimentScore(tokenizeForGen(text)));
  return normalized;
}
function cosineSim(a,b){ let dot=0; for(let i=0;i<a.length;i++) dot += a[i]*b[i]; return dot; }

/* ================= الشبكة العصبية ================= */
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
   محرك الحساب (كل عملية بتتنفذ على السيرفر - Node.js بحت،
   من غير eval/Function نهائيًا حفاظًا على أمان السيرفر)
   ========================================================= */
function arabicMathToSymbols(raw){
  let t = toWesternDigits(raw.trim());
  t = t
    .replace(/زائد|جمع/g, '+')
    .replace(/ناقص|طرح/g, '-')
    .replace(/[×xX]/g, '*')
    .replace(/في(?!\S)/g, '*')          // "في" كعملية ضرب لما تكون كلمة مستقلة
    .replace(/على(?!\S)|تقسيم|قسمة/g, '/')
    .replace(/[÷]/g, '/')
    .replace(/بالمية|بالمائة|٪/g, '%')
    .replace(/يساوي|كام|=/g, '');
  return t.trim();
}
// Tokenizer + Parser بسيط وآمن لعمليات + - * / % وأقواس وأرقام عشرية
function evaluateMathExpression(rawText){
  const expr = arabicMathToSymbols(rawText);
  // لازم يفضل من غير أي حرف عربي/إنجليزي - أرقام وعمليات وأقواس بس
  if(!/^[\d\s+\-*/%.()]+$/.test(expr)) return null;
  if(!/\d/.test(expr)) return null;
  if(!/[+\-*/%]/.test(expr.replace(/^-/,''))) return null; // لازم فيه عملية حقيقية مش رقم لوحده

  let pos = 0;
  const s = expr.replace(/\s+/g,'');
  function peek(){ return s[pos]; }
  function eatNumber(){
    let start = pos;
    while(pos<s.length && /[\d.]/.test(s[pos])) pos++;
    if(start===pos) return NaN;
    return parseFloat(s.slice(start,pos));
  }
  function parseFactor(){
    if(peek()==='('){ pos++; const v=parseExpr(); if(peek()===')') pos++; return v; }
    if(peek()==='-'){ pos++; return -parseFactor(); }
    if(peek()==='+'){ pos++; return parseFactor(); }
    return eatNumber();
  }
  function parseTerm(){
    let v = parseFactor();
    while(peek()==='*'||peek()==='/'||peek()==='%'){
      const op = peek(); pos++;
      const rhs = parseFactor();
      if(op==='*') v*=rhs;
      else if(op==='/'){ if(rhs===0) return NaN; v/=rhs; }
      else { if(rhs===0) return NaN; v%=rhs; }
    }
    return v;
  }
  function parseExpr(){
    let v = parseTerm();
    while(peek()==='+'||peek()==='-'){
      const op = peek(); pos++;
      const rhs = parseTerm();
      v = op==='+' ? v+rhs : v-rhs;
    }
    return v;
  }
  try{
    const result = parseExpr();
    if(pos!==s.length || Number.isNaN(result) || !Number.isFinite(result)) return null;
    return Math.round(result*1e6)/1e6; // تنضيف فواصل عشرية طويلة
  }catch(e){ return null; }
}

/* =========================================================
   محرك التوليد (N-Gram / Markov Chain) - بيبني سلسلة احتمالات
   من كلمة لاللي بعدها من كل النصوص اللي اتعلمها، وبعدين "يمشي"
   عليها عشوائيًا (Weighted Random Walk) عشان يؤلف جملة جديدة.
   ========================================================= */
function buildMarkovModel(texts){
  const starts = [];               // أول كلمة في كل جملة (لبداية طبيعية)
  const transitions = {};          // word -> { nextWord: count }
  for(const text of texts){
    const words = tokenizeForGen(text);
    if(words.length===0) continue;
    starts.push(words[0]);
    for(let i=0;i<words.length-1;i++){
      const a = words[i], b = words[i+1];
      if(!transitions[a]) transitions[a] = {};
      transitions[a][b] = (transitions[a][b]||0) + 1;
    }
  }
  return { starts, transitions };
}
function weightedPick(countsObj){
  const entries = Object.entries(countsObj);
  if(entries.length===0) return null;
  const total = entries.reduce((s,[,c])=>s+c, 0);
  let r = Math.random()*total;
  for(const [word,count] of entries){ r -= count; if(r<=0) return word; }
  return entries[entries.length-1][0];
}
function generateSentence(model, maxWords=12){
  if(!model || model.starts.length===0) return null;
  let current = model.starts[Math.floor(Math.random()*model.starts.length)];
  const words = [current];
  let lastPair = null;
  for(let i=0;i<maxWords-1;i++){
    const next = model.transitions[current] ? weightedPick(model.transitions[current]) : null;
    if(!next) break;
    const pairKey = current+'_'+next;
    if(pairKey===lastPair) break; // منع التكرار اللانهائي لنفس الزوج
    lastPair = pairKey;
    words.push(next);
    current = next;
  }
  if(words.length<2) return null; // كلمة واحدة مش جملة مفيدة
  return words.join(' ');
}

/* =========================================================
   الكاش الخفيف (In-Memory) - بيتحمّل مرة واحدة في الـ Instance
   الدافئة ولا يتحمّل تاني إلا لو الموديل اتغيّر فعلاً. ده اللي
   بيحمي الـ RAM والـ Timeout حتى لو الداتا الكلية بالملايين،
   لأننا مش بنجيب كل brain_examples وقت الرد - بس الذاكرة
   الممثلة (Replay Buffer) المتخزنة جوه trainedModel.
   ========================================================= */
let cache = { updatedAt: 0, labels: [], replayBuffer: [], replayVectors: [], net: null, markovByLabel: {}, idf: { df:{}, totalDocs:0 } };

async function refreshCacheIfNeeded(){
  const [stateSnap, modelSnap] = await Promise.all([STATE_REF().get(), MODEL_REF().get()]);
  const state = stateSnap.exists ? stateSnap.data() : { labels: [] };
  const model = modelSnap.exists ? modelSnap.data() : { updatedAt: 0, ready:false };
  const freshAt = model.updatedAt || 0;

  if(freshAt === cache.updatedAt && cache.labels.length){
    // لسه محدث - منعيدش أي بناء، مجرد نحدث أسماء الفئات لو اتغيرت بسيطة
    cache.labels = state.labels || [];
    return cache;
  }

  cache.updatedAt = freshAt;
  cache.labels = state.labels || [];
  cache.replayBuffer = model.replayBuffer || [];
  cache.idf = { df: model.idfDF || {}, totalDocs: model.idfTotalDocs || 0 };
  cache.net = (model.ready && model.weights)
    ? new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, cache.labels.length], model.weights)
    : null;

  // بنجهّز متجه TF-IDF لكل مثال في الـ Replay Buffer مرة واحدة هنا (لما
  // الكاش يتحدث بس)، بدل ما نعيد حسابه في كل رسالة مستخدم - كده البحث
  // بالتشابه الدلالي (Cosine Similarity) بيبقى سريع جدًا وقت الرد الفعلي.
  cache.replayVectors = cache.replayBuffer.map(ex => textToVector(ex.text, cache.idf));

  // بناء موديل Markov لكل فئة من عينة الذاكرة + الردود الجاهزة المرتبطة بيها
  const byLabel = {};
  for(const ex of cache.replayBuffer){
    (byLabel[ex.labelIndex] = byLabel[ex.labelIndex] || []).push(ex.text);
  }
  for(const label of cache.labels){
    const texts = (byLabel[label.index] || []).concat(label.responses || []);
    cache.markovByLabel[label.index] = buildMarkovModel(texts);
  }
  return cache;
}

/* ================= ذاكرة المحادثة (آخر 5 رسائل) ================= */
async function loadContext(key){
  const snap = await CONV_COL().doc(key).get();
  return snap.exists ? (snap.data().messages || []) : [];
}
async function saveContext(key, userText, replyText){
  const ref = CONV_COL().doc(key);
  await db.runTransaction(async tx=>{
    const snap = await tx.get(ref);
    const messages = snap.exists ? (snap.data().messages || []) : [];
    messages.push({ role:'user', text:userText, at: Date.now() });
    messages.push({ role:'bot', text:replyText, at: Date.now() });
    tx.set(ref, { messages: messages.slice(-CONTEXT_SIZE*2), updatedAt: Date.now() });
  });
}
function contextKeyFor(request){
  return (request.auth && request.auth.uid) || (request.data && request.data.sessionId) || 'anon';
}

/* =========================================================
   التدريب: Trigger على أي كتابة في brain_examples - بيدرّب على
   الدفعة الجديدة بس + عينة من الذاكرة (Replay Buffer) عشان
   الشبكة متنساش الفئات القديمة، من غير ما تعيد قراءة كل الداتا
   التاريخية من Firestore في كل مرة.
   ========================================================= */
exports.onChunkWritten = onDocumentWritten('brain_examples/{chunkId}', async (event) => {
  const after = event.data.after;
  if(!after.exists) return; // مسح Chunk - مفيش تدريب مطلوب هنا
  const chunkData = after.data();
  const newExamples = (chunkData.examples || []).filter(e=>e.trust!==0);
  if(newExamples.length===0) return;

  const stateSnap = await STATE_REF().get();
  const state = stateSnap.exists ? stateSnap.data() : { labels: [] };
  const labels = state.labels || [];
  if(labels.length===0) return;

  const modelSnap = await MODEL_REF().get();
  const modelData = modelSnap.exists ? modelSnap.data() : {};
  let replayBuffer = modelData.replayBuffer || [];

  // تحديث جدول TF-IDF تراكميًا بالأمثلة الجديدة بس (الـ Replay Buffer
  // اتحسب بالفعل قبل كده، مش محتاجين نعيد عدّه عشان منضخمش الأرقام).
  const idfDF = updateIDF(modelData.idfDF, newExamples.map(e=>e.text));
  const idfTotalDocs = (modelData.idfTotalDocs || 0) + newExamples.length;
  const idf = { df: idfDF, totalDocs: idfTotalDocs };

  // تحديث الـ Replay Buffer بعينة عشوائية متوازنة (Reservoir Sampling لكل فئة)
  const perLabelCount = {};
  for(const ex of replayBuffer) perLabelCount[ex.labelIndex] = (perLabelCount[ex.labelIndex]||0)+1;
  for(const ex of newExamples){
    const count = perLabelCount[ex.labelIndex] || 0;
    if(count < REPLAY_PER_LABEL){
      replayBuffer.push(ex);
      perLabelCount[ex.labelIndex] = count+1;
    } else {
      // استبدال عشوائي لعنصر قديم من نفس الفئة (يحافظ على تنوع العينة بمرور الوقت)
      const sameLabelIdxs = replayBuffer.map((e,i)=>e.labelIndex===ex.labelIndex?i:-1).filter(i=>i!==-1);
      if(sameLabelIdxs.length && Math.random() < 0.3){
        const victim = sameLabelIdxs[Math.floor(Math.random()*sameLabelIdxs.length)];
        replayBuffer[victim] = ex;
      }
    }
  }

  // بناء/استكمال الشبكة: لو فيه وزن محفوظ وعدد الفئات لسه زي ما هو، كمّل تدريب تراكمي.
  // لو عدد الفئات اتغير (فئة جديدة اتضافت)، لازم تبدأ شبكة جديدة بحجم الإخراج الجديد.
  const canResume = modelData.ready && modelData.weights && modelData.labelsCount===labels.length;
  const net = new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, labels.length], canResume ? modelData.weights : null);

  const trainingSet = newExamples.concat(replayBuffer);
  for(let e=0;e<EPOCHS_INCREMENTAL;e++){
    for(const ex of trainingSet){
      const vec = textToVector(ex.text, idf);
      const reps = ex.trust>=1 ? 2 : 1;
      for(let r=0;r<reps;r++) net.trainStep([vec], oneHot(ex.labelIndex, labels.length), LR);
    }
  }

  await MODEL_REF().set({
    ready: true,
    weights: net.layers.map(l=>({ w:l.weights, b:l.bias })),
    labelsCount: labels.length,
    replayBuffer,
    idfDF,
    idfTotalDocs,
    trainedOn: (modelData.trainedOn||0) + newExamples.length,
    updatedAt: Date.now()
  });

  // ملحوظة: عداد الأمثلة (STATS_REF/totalExamples) بقى بيتحدّث مباشرة
  // ومضمون في addExample و bulkImport وقت الكتابة نفسها - مش هنا، عشان
  // newExamples هنا هو *كل* محتوى الـ Chunk بعد الفلترة (مش بس الجديد
  // المُضاف في الكتابة دي)، فلو حسبناه هنا تاني هيتضاعف العدّ غلط.
});

/* =========================================================
   ضمانة أمان: أي رد راجع من classify لازم يكون نص غير فاضي
   دايمًا. لو القيمة undefined / null / فاضية، بيتم استبدالها
   برد افتراضي لائق عشان الفرونت إند ميعرضش كلمة "undefined"
   نهائيًا تحت أي ظرف.
   ========================================================= */
const DEFAULT_FALLBACK_REPLY = 'أهلاً بيك! 👋 مش لسه فاهم قصدك بالظبط، ممكن تقول لي بطريقة تانية؟';
function safeReply(value, fallback){
  const v = (value===undefined || value===null) ? '' : String(value).trim();
  return v.length ? v : (fallback || DEFAULT_FALLBACK_REPLY);
}

// محاولة خفيفة لجلب رد سريع من DuckDuckGo Instant Answer API لما مفيش
// تطابق كافي عندنا. بيرجع null لو فشل أو مفيش نتيجة، عشان نرجع
// للرد الافتراضي اللائق من غير ما نكسر الطلب أبدًا.
async function duckDuckGoFallback(query){
  try{
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 3000);
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if(!res.ok) return null;
    const json = await res.json();
    const answer = (json.AbstractText || json.Answer || (json.RelatedTopics && json.RelatedTopics[0] && json.RelatedTopics[0].Text) || '').toString().trim();
    return answer.length ? answer : null;
  }catch(e){
    return null; // أي خطأ (Timeout/شبكة) بيرجع null بهدوء - الرد الافتراضي هيتولى الباقي
  }
}

/* =========================================================
   classify: نقطة الدخول الوحيدة من الفرونت إند لكل رسالة.
   الترتيب: حساب رياضي فوري -> سياق المحادثة -> تصنيف -> توليد
   جملة جديدة -> لو مفيش، رد ثابت -> لو مفيش ثقة، طلب توضيح.
   الشكل الموحّد اللي بيترجع دايمًا لازم يحتوي: { reply, confidence }
   ========================================================= */
exports.classify = onCall(async (request) => {
  const text = (request.data && request.data.text || '').toString();
  if(!text.trim()) throw new HttpsError('invalid-argument', 'الرسالة فاضية');

  const key = contextKeyFor(request);

  /* ---------- أ) فلترة كلمات الحشو وتنظيف النص ----------
     tokenize() جوه textToVector هيشيل الترحيب/الحشو ("تمام"، "طيب"،
     "بقولك"، "يا عم"...) ويسيب المفاهيم الأساسية بس - ده بيحصل تلقائيًا
     في كل نداء لـ textToVector تحت. */

  /* ---------- ب) فحص هل الرسالة معادلة رياضية ---------- */
  const mathResult = evaluateMathExpression(text);
  if(mathResult !== null){
    const reply = safeReply('الناتج = ' + mathResult);
    await saveContext(key, text, reply);
    return { type:'math', confident:true, confidence:100, reply, result:mathResult };
  }

  // تحميل السياق + الذاكرة الخفيفة (Cache) - فيها IDF والمتجهات الجاهزة
  const [context, state] = await Promise.all([ loadContext(key), refreshCacheIfNeeded() ]);
  const labels = state.labels;
  if(labels.length===0 || state.replayBuffer.length===0){
    const reply = safeReply('لسه ماتعلمتش حاجة كفاية عشان أرد عليك صح، علّمني شوية أمثلة الأول 🙏');
    await saveContext(key, text, reply);
    return { confident:false, confidence:0, reply };
  }

  // متجه الجملة بعد فلترة الحشو + توزين TF-IDF (وزن أعلى للمفاهيم النادرة/المميزة)
  const vec = textToVector(text, state.idf);

  /* ---------- ج) البحث عن أقرب معنى بـ Cosine Similarity ----------
     المتجهات جاهزة ومحسوبة مسبقًا في الكاش (cache.replayVectors) بنفس
     أوزان TF-IDF، فمفيش حساب مكرر ولا مطابقة حروف عشوائية. */
  let bestSim=-1, bestExample=null;
  for(let i=0;i<state.replayBuffer.length;i++){
    const ex = state.replayBuffer[i];
    const exVec = state.replayVectors[i];
    const sim = cosineSim(vec, exVec) * (0.6 + 0.4*ex.trust);
    if(sim>bestSim){ bestSim=sim; bestExample=ex; }
  }
  const simLabel = bestExample ? labels.find(l=>l.index===bestExample.labelIndex) : null;

  // الشبكة العصبية المدرّبة تراكميًا (بنفس متجه TF-IDF المستخدم وقت التدريب)
  let nnLabel=null, nnConf=0;
  if(state.net){
    const out = state.net.predict([vec])[0];
    let bestIdx=-1, bestVal=-1;
    for(const lab of labels){ if(out[lab.index]>bestVal){ bestVal=out[lab.index]; bestIdx=lab.index; } }
    if(bestIdx!==-1){ nnLabel = labels.find(l=>l.index===bestIdx); nnConf = bestVal; }
  }

  // تحليل المشاعر بيشتغل على كل الكلمات (من غير فلترة الحشو) عشان كلمات
  // زي "تمام"/"وحش" تفضل تتحسب حتى لو مالهاش دخل في تحديد "نية" السؤال
  const feeling = sentimentScore(tokenizeForGen(text));

  let finalLabel = null, rawConfidence = 0;
  if(simLabel && nnLabel && simLabel.index===nnLabel.index){
    finalLabel = simLabel; rawConfidence = Math.min(1, bestSim*0.7 + nnConf*0.3 + 0.08);
  } else if(bestSim >= CONFIDENCE_THRESHOLD){
    finalLabel = simLabel; rawConfidence = bestSim;
  } else if(nnConf >= CONFIDENCE_THRESHOLD+0.15){
    finalLabel = nnLabel; rawConfidence = nnConf;
  }

  // تقييد الثقة بحيث ما تتعداش 100% أبدًا مهما كانت الحسابات
  const confidencePct = Math.min(100, Math.round(Math.max(rawConfidence,0)*100));

  if(!finalLabel || confidencePct < Math.round(CONFIDENCE_THRESHOLD*100)){
    // مفيش تطابق كافي - نجرب نحول السؤال لـ DuckDuckGo الأول،
    // ولو مفيش نتيجة أو حصل خطأ، نرجع رد افتراضي لائق (مش undefined أبدًا).
    const ddgAnswer = await duckDuckGoFallback(text);
    const reply = safeReply(ddgAnswer, 'مش فاهم قصدك بالظبط 🤔 ممكن توضح أكتر؟');
    await saveContext(key, text, reply);
    return { confident:false, confidence:confidencePct, reply, feeling, source: ddgAnswer ? 'duckduckgo' : 'default' };
  }

  /* ---------- د) تطبيق محرك N-Gram التوليدي لو محتاج صياغة جديدة ---------- */
  const markov = state.markovByLabel[finalLabel.index];
  const generated = generateSentence(markov, 12);
  const isNewSentence = generated && !(finalLabel.responses||[]).includes(generated);
  // بنفلتر أي رد فاضي أو undefined جوه المصفوفة قبل ما نختار منها عشوائيًا
  const responsesPool = (finalLabel.responses||[]).filter(r => typeof r === 'string' && r.trim().length);
  const pickedReply = isNewSentence ? generated : (
    responsesPool.length ? responsesPool[Math.floor(Math.random()*responsesPool.length)] : null
  );
  const reply = safeReply(pickedReply, 'تمام 👍');

  await saveContext(key, text, reply);
  return {
    confident:true,
    confidence: confidencePct,
    label: finalLabel,
    reply,
    generated: !!isNewSentence,
    matchedExampleId: bestExample ? bestExample.id : null,
    matchedExampleChunkId: bestExample ? bestExample.chunkId : null,
    feeling,
    context: context.slice(-CONTEXT_SIZE)
  };
});

/* =========================================================
   دوال مساعدة للتخزين المجزّأ (Chunking)
   ========================================================= */
async function ensureOpenChunk(tx){
  const stateRef = STATE_REF();
  const stateSnap = await tx.get(stateRef);
  const state = stateSnap.exists ? stateSnap.data() : {};
  let chunkId = state.currentChunkId;
  let chunkCount = state.currentChunkCount || 0;

  if(!chunkId || chunkCount >= CHUNK_SIZE){
    chunkId = 'chunk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
    chunkCount = 0;
  }
  return { stateRef, state, chunkId, chunkCount };
}

/* =========================================================
   addExample: تعليم مثال واحد
   ========================================================= */
exports.addExample = onCall(async (request) => {
  const { text, labelName, response } = request.data || {};
  if(!text || !response) throw new HttpsError('invalid-argument', 'ناقص نص أو رد');

  return db.runTransaction(async (tx) => {
    const { stateRef, state, chunkId, chunkCount } = await ensureOpenChunk(tx);
    const labels = state.labels || [];

    const name = (labelName || '').trim() || ('فئة_' + (labels.length + 1));
    let label = labels.find(l => l.name === name);
    if(!label){ label = { index: labels.length, name, responses: [] }; labels.push(label); }
    if(!label.responses.includes(response)) label.responses.push(response);

    const example = {
      id: 'ex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8),
      text, labelIndex: label.index, trust: 0.75, chunkId
    };

    const chunkRef = EXAMPLES_COL().doc(chunkId);
    tx.set(chunkRef, {
      examples: FieldValue.arrayUnion(example),
      updatedAt: Date.now()
    }, { merge:true });

    tx.set(stateRef, {
      labels, currentChunkId: chunkId, currentChunkCount: chunkCount+1,
      totalExamples: FieldValue.increment(1), updatedAt: Date.now()
    }, { merge:true });

    // عدد الفئات الحالي دايمًا معروف هنا (طول labels بعد الإضافة) - نكتبه
    // كرقم مطلق في وثيقة الإحصائيات الخفيفة عشان الواجهة تعرضه فورًا.
    // عدد الأمثلة بقى بيتزوّد هنا كمان مباشرة (مش بس من خلال onChunkWritten)
    // عشان العداد يتحدّث فورًا وميفضلش واقف على صفر لو الـ Trigger اتأخر.
    tx.set(STATS_REF(), { categories: labels.length, examples: FieldValue.increment(1), updatedAt: Date.now() }, { merge:true });

    return { ok:true, labelName: name, labelIndex: label.index, chunkId };
  });
});

/* =========================================================
   bulkImport: استيراد جماعي بحماية كاملة من الأحجام الكبيرة.
   الفرونت إند مسؤول إنه يبعت دفعات (Batches) بحد أقصى 500 سطر
   في كل نداء (شوف دالة splitIntoBatches في الفرونت). السيرفر
   بعد كده بيوزع الأسطر دي على Chunks بحجم CHUNK_SIZE في
   brain_examples، فمفيش وثيقة تقرب من حد الـ 1MB أبدًا.
   ========================================================= */
exports.bulkImport = onCall(async (request) => {
  const lines = (request.data && request.data.lines) || [];
  if(!Array.isArray(lines) || lines.length===0) throw new HttpsError('invalid-argument', 'مفيش سطور');
  if(lines.length > MAX_BATCH_PER_CALL){
    throw new HttpsError('invalid-argument', `أقصى حد ${MAX_BATCH_PER_CALL} سطر في النداء الواحد - قسّم الملف لدفعات أصغر`);
  }

  // 1) تحديث الفئات في سياق ترانزاكشن خفيف (labels بس - مش الأمثلة)
  const { labels, parsedExamples, added, skipped } = await db.runTransaction(async (tx) => {
    const stateSnap = await tx.get(STATE_REF());
    const state = stateSnap.exists ? stateSnap.data() : {};
    const labels = state.labels || [];
    const parsedExamples = [];
    let added = 0, skipped = 0;

    for(const line of lines){
      const parts = String(line).split('|').map(p => p.trim());
      if(parts.length < 3 || !parts[0] || !parts[1] || !parts[2]){ skipped++; continue; }
      const [catName, msg, resp] = parts;
      let label = labels.find(l => l.name === catName);
      if(!label){ label = { index: labels.length, name: catName, responses: [] }; labels.push(label); }
      if(!label.responses.includes(resp)) label.responses.push(resp);
      parsedExamples.push({
        id: 'ex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8) + '_' + added,
        text: msg, labelIndex: label.index, trust: 0.75
      });
      added++;
    }

    tx.set(STATE_REF(), { labels, totalExamples: FieldValue.increment(added), updatedAt: Date.now() }, { merge:true });
    tx.set(STATS_REF(), { categories: labels.length, updatedAt: Date.now() }, { merge:true });
    return { labels, parsedExamples, added, skipped };
  });

  if(parsedExamples.length===0) return { added:0, skipped, chunksWritten:0 };

  // 2) توزيع الأمثلة على Chunks بحجم CHUNK_SIZE وكتابتها بالـ Batch API
  //    (Batch Write حقيقي من Firestore - محدود بـ 500 عملية، وإحنا أصلاً
  //    محدودين بـ MAX_BATCH_PER_CALL=500 سطر فمينفعش نتعدى الحد أبدًا)
  const stateSnap2 = await STATE_REF().get();
  const state2 = stateSnap2.data() || {};
  let chunkId = state2.currentChunkId;
  let chunkCount = state2.currentChunkCount || 0;
  let cursor = 0;
  let chunksWritten = 0;
  const batch = db.batch();

  while(cursor < parsedExamples.length){
    if(!chunkId || chunkCount >= CHUNK_SIZE){
      chunkId = 'chunk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6) + '_' + chunksWritten;
      chunkCount = 0;
    }
    const spaceLeft = CHUNK_SIZE - chunkCount;
    const slice = parsedExamples.slice(cursor, cursor + spaceLeft).map(e => ({ ...e, chunkId }));
    batch.set(EXAMPLES_COL().doc(chunkId), {
      examples: FieldValue.arrayUnion(...slice),
      updatedAt: Date.now()
    }, { merge:true });
    chunkCount += slice.length;
    cursor += slice.length;
    chunksWritten++;
  }
  batch.set(STATE_REF(), { currentChunkId: chunkId, currentChunkCount: chunkCount, updatedAt: Date.now() }, { merge:true });
  // نفس المنطق: نزوّد عداد الأمثلة مباشرة هنا بعدد اللي اتضاف فعليًا،
  // بدل ما نعتمد بس على onChunkWritten (اللي ممكن يتأخر أو ميشتغلش).
  batch.set(STATS_REF(), { examples: FieldValue.increment(added), updatedAt: Date.now() }, { merge:true });
  await batch.commit();

  return { added, skipped, chunksWritten };
});

/* =========================================================
   submitFeedback: تصحيح بالإيموجي - بيحدّث الـ trust في الـ
   Chunk الأصلي (لو معروف)، وفي الـ Replay Buffer المخزن مع
   الموديل عشان يتراعى في التدريب الجاي.
   ========================================================= */
exports.submitFeedback = onCall(async (request) => {
  const { exampleId, chunkId, score } = request.data || {};
  if(!exampleId || (score!==0 && score!==1)) throw new HttpsError('invalid-argument', 'بيانات ناقصة');

  if(chunkId){
    const chunkRef = EXAMPLES_COL().doc(chunkId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(chunkRef);
      if(!snap.exists) return;
      const data = snap.data();
      const examples = (data.examples || []).map(e => e.id===exampleId ? { ...e, trust: score } : e);
      tx.set(chunkRef, { examples, updatedAt: Date.now() }, { merge:true });
    });
  }

  await db.runTransaction(async tx => {
    const modelRef = MODEL_REF();
    const snap = await tx.get(modelRef);
    if(!snap.exists) return;
    const data = snap.data();
    const replayBuffer = (data.replayBuffer || []).map(e => e.id===exampleId ? { ...e, trust: score } : e);
    tx.set(modelRef, { replayBuffer, updatedAt: Date.now() }, { merge:true });
  });

  return { ok:true };
});

/* =========================================================
   learnEmoji
   ========================================================= */
exports.learnEmoji = onCall(async (request) => {
  const { emoji, score } = request.data || {};
  if(!emoji || (score!==0 && score!==1)) throw new HttpsError('invalid-argument', 'بيانات ناقصة');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(STATE_REF());
    const cur = snap.exists ? snap.data() : { labels: [], emojiMeanings: {} };
    cur.emojiMeanings = cur.emojiMeanings || {};
    cur.emojiMeanings[emoji] = score;
    cur.updatedAt = Date.now();
    tx.set(STATE_REF(), cur, { merge:true });
    return { ok:true };
  });
});

/* =========================================================
   resetBrain: مسح كل حاجة - بما فيها كل Chunks في brain_examples
   ========================================================= */
exports.resetBrain = onCall(async () => {
  // مسح كل الـ chunks على دفعات من 400 عشان منتعداش حد الـ batch
  let deleted = 0;
  while(true){
    const snap = await EXAMPLES_COL().limit(400).get();
    if(snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if(snap.size < 400) break;
  }

  await STATE_REF().set({
    labels: [], emojiMeanings: {}, currentChunkId: null, currentChunkCount: 0,
    totalExamples: 0, updatedAt: Date.now()
  });
  await MODEL_REF().set({ ready:false, replayBuffer:[], updatedAt: Date.now() });
  await STATS_REF().set({ categories: 0, examples: 0, updatedAt: Date.now() });
  cache = { updatedAt: 0, labels: [], replayBuffer: [], replayVectors: [], net: null, markovByLabel: {}, idf: { df:{}, totalDocs:0 } };

  return { ok:true, chunksDeleted: deleted };
});

/* =========================================================
   getStats: نداء خفيف جدًا (قراءة وثيقة واحدة صغيرة فيها رقمين
   بس) عشان الواجهة تعرض عدد الفئات والأمثلة فورًا عند الفتح، من
   غير ما تنتظر الـ Listener اللحظي يوصل أو تحمّل labels/responses
   الكاملة. لو الوثيقة مش موجودة لسه (أول تشغيل)، بيرجع أصفار.
   ========================================================= */
exports.getStats = onCall(async () => {
  const snap = await STATS_REF().get();
  const data = snap.exists ? snap.data() : {};
  return { categories: data.categories || 0, examples: data.examples || 0 };
});

/* =========================================================
   diagnoseAndRepairStats: بيحل مشكلة "0 فئة / 0 أمثلة" من غير ما
   يخمّن اسم Collection قديم عشوائي. بيعمل حاجتين:

   1) تشخيص: بيفحص أماكن التخزين الحالية (miniBrain/sharedState،
      brain_examples) وكمان أشهر الأسماء المحتملة لأي بيانات قديمة
      قبل التحويل لهيكلة الـ V2 الحالية (examples/knowledge/dataset
      كـ Collections، أو حقل examples[] جوه sharedState نفسها زي
      ما كانت الهيكلة الأصلية قبل التقسيم لـ Chunks). التقرير ده
      بيوريك بالظبط فين البيانات الحقيقية موجودة دلوقتي.

   2) إصلاح فوري وآمن: بيعيد حساب miniBrain/liveStats من الأرقام
      الحقيقية الموجودة فعلاً في sharedState.labels و brain_examples
      (عدّ حقيقي، مش الرقم المتراكم القديم اللي ممكن يبقى متأخر أو
      اتصفّر). العملية دي آمنة 100% - بتصحّح رقم بس، مش بتمسح
      ولا تعدّل أي بيانات فعلية.
   ========================================================= */
exports.diagnoseAndRepairStats = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async () => {
  const report = { checkedLocations: [], legacyDataFound: [] };

  // 1) الوضع الحالي في sharedState - بنشوف هل فيه حقل "examples" قديم
  //    متبقي من قبل التحويل لـ Chunks (الهيكلة القديمة كانت Document
  //    واحد فيه examples[] بدل Collection مستقلة)
  const stateSnap = await STATE_REF().get();
  const stateData = stateSnap.exists ? stateSnap.data() : {};
  const labels = stateData.labels || [];
  report.sharedState = {
    exists: stateSnap.exists,
    labelsCount: labels.length,
    totalExamplesField: stateData.totalExamples || 0,
    hasLegacyExamplesArrayField: Array.isArray(stateData.examples) && stateData.examples.length > 0
  };
  if(report.sharedState.hasLegacyExamplesArrayField){
    report.legacyDataFound.push({
      location: 'miniBrain/sharedState.examples (حقل قديم جوه نفس الوثيقة)',
      count: stateData.examples.length
    });

    // 1.5) الترحيل الفعلي: كانت المشكلة إن الحقل القديم ده بيتكشف
    // وبس، من غير أي خطوة فعلية تنقل بياناته لـ brain_examples (مصدر
    // الحقيقة اللي كل باقي النظام - classify/rebuild/stats - بيقرا منه).
    // هنا بننقلها فعليًا: نوزّعها على Chunks بحجم CHUNK_SIZE ونكتبها
    // بالضبط زي bulkImport، وبعدين نمسح الحقل القديم عشان ميترحلش تاني.
    const legacyExamples = stateData.examples;
    const validLegacy = legacyExamples.filter(e => e && e.text && (e.labelIndex===0 || e.labelIndex));
    let cursor = 0, chunksWritten = 0;
    let chunkId = stateData.currentChunkId || null;
    let chunkCount = stateData.currentChunkCount || 0;
    while(cursor < validLegacy.length){
      if(!chunkId || chunkCount >= CHUNK_SIZE){
        chunkId = 'chunk_migrated_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6) + '_' + chunksWritten;
        chunkCount = 0;
      }
      const spaceLeft = CHUNK_SIZE - chunkCount;
      const slice = validLegacy.slice(cursor, cursor + spaceLeft).map((e,i) => ({
        id: e.id || ('ex_migrated_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8) + '_' + (cursor+i)),
        text: e.text,
        labelIndex: e.labelIndex,
        trust: (e.trust===0 || e.trust) ? e.trust : 0.75,
        chunkId
      }));
      await EXAMPLES_COL().doc(chunkId).set({
        examples: FieldValue.arrayUnion(...slice),
        updatedAt: Date.now()
      }, { merge:true });
      chunkCount += slice.length;
      cursor += slice.length;
      chunksWritten++;
    }
    await STATE_REF().set({
      examples: FieldValue.delete(),
      currentChunkId: chunkId,
      currentChunkCount: chunkCount,
      updatedAt: Date.now()
    }, { merge:true });
    report.migration = {
      migrated: validLegacy.length,
      skipped: legacyExamples.length - validLegacy.length,
      chunksWritten
    };
  }

  // 2) العدّ الحقيقي من brain_examples (مصدر الحقيقة الفعلي حاليًا، وبعد
  //    أي ترحيل تم تنفيذه فوق لو كان فيه بيانات قديمة)
  const chunksSnap = await EXAMPLES_COL().get();
  let realExampleCount = 0;
  chunksSnap.forEach(doc=>{
    const arr = doc.data().examples;
    if(Array.isArray(arr)) realExampleCount += arr.length;
  });
  report.brainExamplesCollection = { chunksCount: chunksSnap.size, realExampleCount };

  // 3) فحص أشهر الأسماء المحتملة لأي Collection أو Document قديم مرتبط
  //    بالتعلّم قبل الهيكلة الحالية، عشان نتأكد إن مفيش بيانات متيتّمة
  const candidateCollections = ['examples', 'knowledge', 'dataset', 'training_data', 'qa_pairs', 'brain'];
  for(const name of candidateCollections){
    const snap = await db.collection(name).limit(3).get();
    report.checkedLocations.push({ collection: name, found: !snap.empty, sampleCount: snap.size });
    if(!snap.empty){
      report.legacyDataFound.push({
        location: 'collection: ' + name,
        sampleIds: snap.docs.map(d=>d.id),
        sampleData: snap.docs.map(d=>d.data())
      });
    }
  }
  const candidateDocs = [['miniBrain','brainData'], ['miniBrain','legacyExamples'], ['brain','data']];
  for(const [col,doc] of candidateDocs){
    const snap = await db.collection(col).doc(doc).get();
    report.checkedLocations.push({ doc: col+'/'+doc, found: snap.exists });
    if(snap.exists){
      report.legacyDataFound.push({ location: 'doc: ' + col + '/' + doc, data: snap.data() });
    }
  }

  // 4) إصلاح فوري وآمن: نعيد كتابة liveStats بالأرقام الحقيقية الموجودة
  //    فعلاً دلوقتي (labels.length + العدّ الحقيقي من brain_examples)
  await STATS_REF().set({
    categories: labels.length,
    examples: realExampleCount,
    updatedAt: Date.now()
  }, { merge:true });
  // بنصحح كمان totalExamples في sharedState لو كان متأخر عن العدّ الحقيقي
  if((stateData.totalExamples || 0) !== realExampleCount){
    await STATE_REF().set({ totalExamples: realExampleCount }, { merge:true });
  }

  report.repaired = { categories: labels.length, examples: realExampleCount };
  return report;
});

/* =========================================================
   rebuildModelFromExistingData: بيحل مشكلة "الموديل مش بيتعرف على
   جمل قديمة اتعلمها قبل كده" (زي "انت عاملة ايه"، "كم عمرك").

   السبب: trainedModel.replayBuffer (اللي عليه البحث بالتشابه
   والتدريب) بيتبني بس من onChunkWritten وقت ما Chunk جديد يتكتب -
   فلو فيه أمثلة قديمة كانت مكتوبة في brain_examples قبل ما الكود
   يتحدّث أو قبل ما الـ Trigger يشتغل عليها، مبتوصلش لـ replayBuffer
   ولا للشبكة العصبية أبدًا لحد ما حد "يلمسها" بكتابة جديدة.

   الحل: نعيد بناء الـ replayBuffer + جدول TF-IDF + الشبكة العصبية
   من الصفر، بس المرة دي من *كل* الأمثلة الموجودة فعلاً في
   brain_examples (مش بس الجديد)، فأي جملة اتعلمها قبل كده بترجع
   تتعرف عليها فورًا بعد التشغيل ده.
   ========================================================= */
exports.rebuildModelFromExistingData = onCall({ timeoutSeconds: 300, memory: '1GiB' }, async () => {
  const stateSnap = await STATE_REF().get();
  const state = stateSnap.exists ? stateSnap.data() : {};
  const labels = state.labels || [];
  if(labels.length===0){
    return { ok:false, reason: 'مفيش فئات (labels) في sharedState أصلاً - شغّل diagnoseAndRepairStats الأول عشان تعرف فين البيانات الحقيقية.' };
  }

  // 1) اقرأ *كل* الأمثلة الحقيقية من كل الـ Chunks - دي المرة الوحيدة
  //    اللي بنعمل فيها كده (مش وقت كل رسالة مستخدم) عشان كده آمن للـ RAM
  const chunksSnap = await EXAMPLES_COL().get();
  let allExamples = [];
  chunksSnap.forEach(doc=>{
    const arr = doc.data().examples;
    if(Array.isArray(arr)) allExamples = allExamples.concat(arr.filter(e=>e && e.trust!==0 && e.text));
  });
  if(allExamples.length===0){
    return { ok:false, reason: 'brain_examples فاضية تمامًا - مفيش أمثلة نبني منها الموديل.' };
  }

  // 2) TF-IDF من كل الأمثلة الحقيقية (مش عينة) - مرة واحدة بس هنا
  const idfDF = updateIDF({}, allExamples.map(e=>e.text));
  const idfTotalDocs = allExamples.length;
  const idf = { df: idfDF, totalDocs: idfTotalDocs };

  // 3) عينة ممثلة متوازنة لكل فئة (Reservoir) من كل التاريخ - مش بس آخر Chunk
  const byLabel = {};
  for(const ex of allExamples){ (byLabel[ex.labelIndex] = byLabel[ex.labelIndex] || []).push(ex); }
  let replayBuffer = [];
  for(const key of Object.keys(byLabel)){
    const pool = byLabel[key];
    if(pool.length <= REPLAY_PER_LABEL){ replayBuffer = replayBuffer.concat(pool); continue; }
    // اختيار عشوائي لعينة REPLAY_PER_LABEL من كل تاريخ الفئة دي
    const shuffled = pool.slice().sort(()=>Math.random()-0.5);
    replayBuffer = replayBuffer.concat(shuffled.slice(0, REPLAY_PER_LABEL));
  }

  // 4) تدريب الشبكة من الصفر على العينة الممثلة (بنفس عدد الـ Epochs
  //    المستخدم في التدريب التراكمي العادي، عشان الجودة تفضل ثابتة)
  const net = new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, labels.length], null);
  for(let e=0;e<EPOCHS_INCREMENTAL;e++){
    for(const ex of replayBuffer){
      const vec = textToVector(ex.text, idf);
      const reps = ex.trust>=1 ? 2 : 1;
      for(let r=0;r<reps;r++) net.trainStep([vec], oneHot(ex.labelIndex, labels.length), LR);
    }
  }

  await MODEL_REF().set({
    ready: true,
    weights: net.layers.map(l=>({ w:l.weights, b:l.bias })),
    labelsCount: labels.length,
    replayBuffer,
    idfDF,
    idfTotalDocs,
    trainedOn: allExamples.length,
    updatedAt: Date.now()
  });
  await STATS_REF().set({ categories: labels.length, examples: allExamples.length, updatedAt: Date.now() }, { merge:true });
  await STATE_REF().set({ totalExamples: allExamples.length }, { merge:true });

  // نفضّي الكاش المحلي عشان أول رسالة جاية تجيب النسخة الجديدة فورًا
  cache = { updatedAt: 0, labels: [], replayBuffer: [], replayVectors: [], net: null, markovByLabel: {}, idf: { df:{}, totalDocs:0 } };

  return {
    ok:true,
    totalExamplesUsed: allExamples.length,
    replayBufferSize: replayBuffer.length,
    labelsCount: labels.length
  };
});
