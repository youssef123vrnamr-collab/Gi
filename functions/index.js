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
const admin = require('firebase-admin');
const vm = require('node:vm');
admin.initializeApp();
const db = admin.firestore();

const STATE_REF  = () => db.collection('miniBrain').doc('sharedState');
const MODEL_REF  = () => db.collection('miniBrain').doc('trainedModel');
const TOOLS_COL  = () => db.collection('dynamic_tools');
const TOOL_ERRORS_COL = () => db.collection('tool_errors');

/* ================= إعدادات الشبكة =================
   بما إن التدريب بقى على السيرفر مش على الموبايل، مفيش داعي
   نقلل الحجم عشان نراعي بطارية أو رام الهاتف - كبّرناها شوية
   (96 خلية مخفية بدل 64) عشان دقة أعلى، والتدريب برضه بياخد
   أجزاء من الثانية لأن سيرفرات جوجل أسرع بكتير من الموبايل. */
const HIDDEN_DIM = 96;
const EPOCHS = 220;
const LR = 0.3;
const CONFIDENCE_THRESHOLD = 0.42;

/* ================= إعدادات طبقة الـ Agent ================= */
const TOOL_SIM_THRESHOLD = 0.5;   // الحد الأدنى للتشابه عشان نثق في أداة ونشغّلها
const TOOL_TIMEOUT_MS = 1000;     // أقصى وقت تنفيذ لأي دالة ديناميكية جوه الـ VM
const TOOL_ERROR_LIMIT = 3;       // عدد الأخطاء المتتالية قبل ما نوقف الأداة تلقائياً
const TOOL_SEARCH_LIMIT = 300;    // أقصى عدد أدوات نجيبها من Firestore للمقارنة

/* ================= معالجة النص (نفس منطق المتصفح القديم) ================= */
const STOPWORDS = new Set([
  'في','من','على','عن','الى','إلى','يا','او','أو','ثم','هل','لا','لم','لن',
  'ما','هذا','هذه','ذلك','تلك','التي','الذي','و','كان','كانت','يكون','مع',
  'كل','بعض','كذلك','ايضا','أيضا','انا','أنا','انت','أنت','هو','هي','احنا',
  'إحنا','بس','يعني','عشان','علشان'
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
exports.classify = onCall(async (request) => {
  const text = (request.data && request.data.text || '').toString();
  if(!text.trim()) throw new HttpsError('invalid-argument', 'الرسالة فاضية');

  const [stateSnap, modelSnap] = await Promise.all([STATE_REF().get(), MODEL_REF().get()]);
  if(!stateSnap.exists) return { confident:false, confidence:0 };
  const state = stateSnap.data();
  const labels = state.labels || [];
  const usable = (state.examples || []).filter(e=>e.trust!==0);
  if(usable.length===0) return { confident:false, confidence:0 };

  const vec = textToVector(text);

  // 1) نظام التشابه
  let bestSim=-1, bestExample=null;
  for(const ex of usable){
    const exVec = textToVector(ex.text);
    const sim = cosineSim(vec, exVec) * (0.6 + 0.4*ex.trust);
    if(sim>bestSim){ bestSim=sim; bestExample=ex; }
  }
  const simLabel = bestExample ? labels.find(l=>l.index===bestExample.labelIndex) : null;

  // 2) الشبكة العصبية المدرّبة (محفوظة من الـ trigger فوق)
  let nnLabel=null, nnConf=0;
  if(modelSnap.exists && modelSnap.data().ready){
    const net = new NeuralNetwork([VECTOR_DIM, HIDDEN_DIM, labels.length], modelSnap.data().weights);
    const out = net.predict([vec])[0];
    let bestIdx=-1, bestVal=-1;
    for(const lab of labels){ if(out[lab.index]>bestVal){ bestVal=out[lab.index]; bestIdx=lab.index; } }
    if(bestIdx!==-1){ nnLabel = labels.find(l=>l.index===bestIdx); nnConf = bestVal; }
  }

  const feeling = sentimentScore(tokenize(text)); // نبرة الجملة -1..1، بترجع للواجهة لو حابب تعرضها

  // نفس منطق القرار الأصلي بالظبط، بس بدل ما نعمل return فوري
  // بنحفظه في result عشان نقدر نكمّل بطبقة الـ Agent لو لسه مش واثقين
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

  // 3) طبقة الـ Agent: تتفعّل بس لو الطبقتين فوق مالقوش رد واثق
  if(!result.confident){
    try{
      const { tool, sim } = await findBestTool(vec);
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

  return result;
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
