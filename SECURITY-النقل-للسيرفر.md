# 5️⃣ الأمان — نقل مفاتيح الـ API لخادم خلفي

## الوضع الحالي
مفاتيح Groq / Gemini / OpenRouter / Vercel AI Gateway مش مكتوبة **نص صريح (hardcoded)** جوه
`script.js` — إنما بتتحمّل من Firestore وقت التشغيل (`ApiKeyPool.setKeys(...)`). المشكلة الحقيقية
مش في الكود المصدري، لكن في إن الطلبات لسه بتتبعت **مباشرة من المتصفح** لـ Groq/Gemini/OpenRouter/Vercel
مع الهيدر `Authorization: Bearer <key>` — يعني أي حد يفتح تبويب Network في الـ DevTools هيشوف
المفتاح صراحةً في كل طلب، ويقدر يستخدمه هو نفسه بره التطبيق.

**الحل الجذري الوحيد:** الطلب لازم يعدّي على خادم خلفي (Serverless Function) يضيف المفتاح هو،
مش المتصفح. بما إن المشروع أصلًا مبني على Firebase (زي Falak)، أنسب حل هو **Firebase Cloud
Functions** بدل ما نضيف مزوّد استضافة جديد.

## الخطوات (خطة تنفيذ، محتاجة قرار ونشر من عندك)
1. `firebase init functions` في مجلد المشروع (لو لسه معملتوش).
2. ضيف الأسرار كمتغيرات بيئة آمنة (مش في الكود):
   `firebase functions:secrets:set GROQ_API_KEY`
3. اكتب Function واحدة بروكسي (مثال مبسّط تحت في `functions/index.js`) بتستقبل
   نفس الـ body اللي كان بيتبعت لـ Groq، وبتضيف المفتاح من `process.env` قبل ما تعمل fetch،
   وبترجّع نفس الـ stream للمتصفح (streaming proxy).
4. في `script.js`، غيّر الـ URL بس من `https://api.groq.com/...` لـ
   `https://<your-region>-<project>.cloudfunctions.net/groqProxy` — باقي منطق الـ streaming
   (auto-resume, retry, إلخ) هيفضل شغّال زي ما هو من غير أي تعديل تاني، لأنه شكل الاستجابة نفسه.
5. كرر نفس الخطوة لباقي المزوّدين (Gemini, OpenRouter, Vercel Gateway).
6. بعد النقل، احذف أي قراءة مباشرة للمفاتيح من Firestore في الفرونت إند، والقيها في الباك إند بس.

## ليه ماعملتوش أنا دلوقتي؟
نقل فعلي للـ Endpoints محتاج مشروع Firebase حقيقي (project id, region, secrets) ونشر (`firebase
deploy`) من عندك — ده قرار بنية تحتية مش تعديل كود بس. اللي عملته هنا إني جهزتلك مثال Function
جاهز (`functions/index.js`) تقدر تنشره زي ما هو أو تعدّل عليه.
