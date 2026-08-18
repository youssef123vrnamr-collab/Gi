/* =========================================================
   تكامل الفرونت إند مع النسخة الجديدة من functions/index.js
   -----------------------------------------------------------
   ده مش ملف مستقل هيشتغل لوحده - ده الأجزاء اللي لازم تستبدلها
   جوه index.html بتاعك. حددت مكان كل جزء تحت.
   ========================================================= */

/* =========================================================
   1) تقسيم الملفات الكبيرة لدفعات آمنة (Batches of 200)
   -----------------------------------------------------------
   استبدل دالة importLines القديمة في index.html بالنسخة دي.
   السيرفر بيقبل لحد 500 سطر في النداء الواحد (MAX_BATCH_PER_CALL)
   لكن إحنا هنا بنبعت 200 بس في كل نداء عشان نسيب مساحة أمان
   ونقدر نعرض progress bar حقيقي للمستخدم وهو بيستورد.
   ========================================================= */
const BATCH_SIZE = 200;

function splitIntoBatches(lines, size = BATCH_SIZE){
  const batches = [];
  for(let i=0; i<lines.length; i+=size){
    batches.push(lines.slice(i, i+size));
  }
  return batches;
}

/**
 * يبعت الأسطر على دفعات متتالية للسيرفر، مع إعادة محاولة تلقائية
 * (مرة واحدة) لو دفعة معينة فشلت، وبيستدعي onProgress بعد كل دفعة
 * عشان تحدّث progress bar في الواجهة.
 */
async function importLinesInBatches(lines, onProgress){
  const batches = splitIntoBatches(lines);
  let totalAdded = 0, totalSkipped = 0;

  for(let i=0; i<batches.length; i++){
    const batch = batches[i];
    let result;
    try{
      result = await callBulkImport()({ lines: batch });
    }catch(err){
      console.warn('فشلت الدفعة رقم ' + (i+1) + '، بيحاول تاني...', err);
      try{
        result = await callBulkImport()({ lines: batch }); // محاولة ثانية
      }catch(err2){
        console.error('فشلت الدفعة رقم ' + (i+1) + ' نهائيًا', err2);
        throw new Error('حصل خطأ عند إرسال دفعة ' + (i+1) + ' من ' + batches.length);
      }
    }
    totalAdded += result.data.added;
    totalSkipped += result.data.skipped;
    if(typeof onProgress === 'function'){
      onProgress({
        batchIndex: i+1,
        totalBatches: batches.length,
        percent: Math.round(((i+1)/batches.length)*100),
        added: totalAdded,
        skipped: totalSkipped
      });
    }
  }
  return { added: totalAdded, skipped: totalSkipped };
}

/* =========================================================
   استخدامها جوه showBulkImportCard: استبدل استدعاء importLines
   القديم بالسطور دي (في المكانين: فيه ملف .txt وفي الكتابة اليدوية)
   ========================================================= */
/*
  showBusy('بيبعت ' + lines.length + ' سطر للسيرفر على دفعات...');
  const { added, skipped } = await importLinesInBatches(lines, (progress) => {
    card.querySelector('.bulk-progress-fill').style.width = progress.percent + '%';
    card.querySelector('.bulk-progress-pct').textContent = progress.percent + '%';
    card.querySelector('.bulk-progress-label').textContent =
      'دفعة ' + progress.batchIndex + ' من ' + progress.totalBatches + ' (' + progress.added + ' مثال لحد دلوقتي)';
  });
  card.remove();
  addSystem('اتستوردت ' + added + ' مثال ' + (skipped>0 ? ('(اتجاهل ' + skipped + ' سطر بصيغة غلط) ') : '') + 'وبيتدرب على السيرفر دلوقتي ✓');
*/


/* =========================================================
   2) جلسة ثابتة لكل جهاز عشان السيرفر يقدر "يفتكر" آخر 5 رسائل
   حتى لو المستخدم مش مسجل دخول. استدعي getOrCreateSessionId()
   مرة واحدة عند تحميل الصفحة واستخدم الناتج مع كل نداء classify.
   ========================================================= */
function getOrCreateSessionId(){
  const KEY = 'miniBrainSessionId';
  let id = localStorage.getItem(KEY);
  if(!id){
    id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
    localStorage.setItem(KEY, id);
  }
  return id;
}
const SESSION_ID = getOrCreateSessionId();

/* =========================================================
   3) استبدل نداء classify القديم بده - لازم يبعت sessionId عشان
   الذاكرة (آخر 5 رسائل) تتربط بالجهاز/المستخدم الصحيح
   ========================================================= */
async function sendMessageToBrain(text){
  const res = await callClassify()({ text, sessionId: SESSION_ID });
  return res.data;
  // res.data ممكن يرجع:
  // { type:'math', reply, result }                         -> رد حسابي فوري
  // { confident:true, reply, generated, label, confidence,
  //   matchedExampleId, matchedExampleChunkId, feeling }    -> رد تصنيف/توليد
  // { confident:false, reply, confidence }                 -> طلب توضيح
}

/* =========================================================
   4) submitFeedback لازم يبعت دلوقتي chunkId كمان (رجع من
   classify كـ matchedExampleChunkId) عشان السيرفر يعرف يعدّل
   المثال الصحيح جوه brain_examples. خزّن الاتنين مع كل رسالة رد
   في الواجهة (زي data-example-id و data-chunk-id على العنصر).
   ========================================================= */
async function applyFeedback(exampleId, chunkId, score, targetDiv){
  await callSubmitFeedback()({ exampleId, chunkId, score });
  // ... باقي منطق تحديث الواجهة زي ما هو
}
