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
const STOPWORDS = new Set([
  'في','من','على','عن','الى','إلى','يا','او','أو','ثم','هل','لا','لم','لن',
  'ما','هذا','هذه','ذلك','تلك','التي','الذي','و','كان','كانت','يكون','مع',
  'كل','بعض','كذلك','ايضا','أيضا','انا','أنا','انت','أنت','هو','هي','احنا',
  'إحنا','بس','يعني','عشان','علشان'
]);

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
// تقطيع للتصنيف (بيشيل كلمات الوصل عشان يركّز على المعنى)
function tokenize(text){
  return normalizeArabic(text).trim().split(/\s+/).filter(Boolean).filter(t=>!STOPWORDS.has(t));
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
function textToVector(text){
  const vec = new Array(INPUT_DIM).fill(0);
  const tokens = tokenize(text);
  for(const t of tokens){ vec[hashWord(t)] += 1; }
  for(let i=0;i<tokens.length-1;i++){ vec[hashWord(tokens[i]+'_'+tokens[i+1])] += 1.4; }
  const norm = Math.sqrt(vec.reduce((s,v)=>s+v*v,0));
  const normalized = norm>0 ? vec.map(v=>v/norm) : vec;
  normalized.push(sentimentScore(tokens));
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
let cache = { updatedAt: 0, labels: [], replayBuffer: [], net: null, markovByLabel: {} };

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
  cache.net = (model.ready && model.weights)
    ? new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, cache.labels.length], model.weights)
    : null;

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
      const vec = textToVector(ex.text);
      const reps = ex.trust>=1 ? 2 : 1;
      for(let r=0;r<reps;r++) net.trainStep([vec], oneHot(ex.labelIndex, labels.length), LR);
    }
  }

  await MODEL_REF().set({
    ready: true,
    weights: net.layers.map(l=>({ w:l.weights, b:l.bias })),
    labelsCount: labels.length,
    replayBuffer,
    trainedOn: (modelData.trainedOn||0) + newExamples.length,
    updatedAt: Date.now()
  });

  await STATE_REF().set({
    totalExamples: FieldValue.increment(newExamples.length)
  }, { merge:true });
});

/* =========================================================
   classify: نقطة الدخول الوحيدة من الفرونت إند لكل رسالة.
   الترتيب: حساب رياضي فوري -> سياق المحادثة -> تصنيف -> توليد
   جملة جديدة -> لو مفيش، رد ثابت -> لو مفيش ثقة، طلب توضيح.
   ========================================================= */
exports.classify = onCall(async (request) => {
  const text = (request.data && request.data.text || '').toString();
  if(!text.trim()) throw new HttpsError('invalid-argument', 'الرسالة فاضية');

  const key = contextKeyFor(request);

  // 1) محرك الحساب - لو الرسالة عملية حسابية، السيرفر بيحسبها فورًا
  const mathResult = evaluateMathExpression(text);
  if(mathResult !== null){
    const reply = 'الناتج = ' + mathResult;
    await saveContext(key, text, reply);
    return { type:'math', confident:true, confidence:100, reply, result:mathResult };
  }

  // 2) تحميل السياق + الذاكرة الخفيفة (Cache)
  const [context, state] = await Promise.all([ loadContext(key), refreshCacheIfNeeded() ]);
  const labels = state.labels;
  if(labels.length===0 || state.replayBuffer.length===0){
    const reply = 'لسه ماتعلمتش حاجة كفاية عشان أرد عليك صح، علّمني شوية أمثلة الأول 🙏';
    await saveContext(key, text, reply);
    return { confident:false, confidence:0, reply };
  }

  const vec = textToVector(text);

  // 3) نظام التشابه (على عينة الذاكرة الممثلة بس - مش كل الداتا)
  let bestSim=-1, bestExample=null;
  for(const ex of state.replayBuffer){
    const exVec = textToVector(ex.text);
    const sim = cosineSim(vec, exVec) * (0.6 + 0.4*ex.trust);
    if(sim>bestSim){ bestSim=sim; bestExample=ex; }
  }
  const simLabel = bestExample ? labels.find(l=>l.index===bestExample.labelIndex) : null;

  // 4) الشبكة العصبية المدرّبة تراكميًا
  let nnLabel=null, nnConf=0;
  if(state.net){
    const out = state.net.predict([vec])[0];
    let bestIdx=-1, bestVal=-1;
    for(const lab of labels){ if(out[lab.index]>bestVal){ bestVal=out[lab.index]; bestIdx=lab.index; } }
    if(bestIdx!==-1){ nnLabel = labels.find(l=>l.index===bestIdx); nnConf = bestVal; }
  }

  const feeling = sentimentScore(tokenize(text));

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
    const reply = 'مش فاهم قصدك بالظبط 🤔 ممكن توضح أكتر؟';
    await saveContext(key, text, reply);
    return { confident:false, confidence:confidencePct, reply, feeling };
  }

  // 5) محاولة التوليد أولاً (N-Gram) قبل الرجوع لرد ثابت
  const markov = state.markovByLabel[finalLabel.index];
  const generated = generateSentence(markov, 12);
  const isNewSentence = generated && !(finalLabel.responses||[]).includes(generated);
  const reply = isNewSentence ? generated : (
    (finalLabel.responses && finalLabel.responses.length)
      ? finalLabel.responses[Math.floor(Math.random()*finalLabel.responses.length)]
      : 'تمام 👍'
  );

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
      labels, currentChunkId: chunkId, currentChunkCount: chunkCount+1, updatedAt: Date.now()
    }, { merge:true });

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

    tx.set(STATE_REF(), { labels, updatedAt: Date.now() }, { merge:true });
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
  cache = { updatedAt: 0, labels: [], replayBuffer: [], net: null, markovByLabel: {} };

  return { ok:true, chunksDeleted: deleted };
});
