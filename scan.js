// /api/scan.js
// Serverless function (Vercel auto-detects this as an API route).
// Takes a table/text image from the browser and asks Claude to read it accurately,
// including Arabic text/handwriting, and return clean structured JSON.
//
// Setup required in the Vercel project (one-time):
//   Project Settings -> Environment Variables -> add ANTHROPIC_API_KEY
//   (get a key from the Claude Platform console: https://platform.claude.com)

// Cost note: Haiku 4.5 is the cheapest current Claude model and is plenty accurate for this job -
// a typical single-table scan costs a small fraction of a cent. If a document is unusually messy
// (heavy handwriting, low light) and Haiku struggles, switch MODEL to 'claude-sonnet-5' for a
// noticeably more careful (and slightly pricier) read.
const MODEL = 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY غير مضبوط في إعدادات Vercel' });
  }

  const { mode, image, mediaType, rows, cols, count } = req.body || {};

  if (!image) {
    return res.status(400).json({ error: 'الصورة مفقودة' });
  }

  let prompt;
  if (mode === 'grid') {
    const r = parseInt(rows, 10), c = parseInt(cols, 10);
    if (!r || !c) return res.status(400).json({ error: 'عدد الصفوف/الأعمدة مفقود' });
    prompt =
      'هذه صورة جدول مقسم إلى ' + r + ' صف و ' + c + ' عمود بالضبط.\n' +
      'اقرأ محتوى كل خلية بأقصى دقة ممكنة، سواء كان نص عربي مطبوع، خط يد، أو أرقام (عربية أو هندية).\n' +
      'قواعد مهمة:\n' +
      '- اكتب النص كما هو تمامًا بدون ترجمة أو تصحيح إملائي أو إعادة صياغة.\n' +
      '- إذا كانت الخلية فارغة أو غير واضحة تمامًا، اجعل قيمتها سلسلة نصية فارغة "".\n' +
      '- لا تدمج محتوى خليتين مع بعض، ولا تكرر نفس القيمة في خلايا فارغة مجاورة.\n' +
      '- حافظ على ترتيب الصفوف من أعلى لأسفل والأعمدة من اليمين لليسار كما تظهر في الصورة.\n' +
      'رد فقط بـ JSON صالح بدون أي نص إضافي أو Markdown أو علامات ```، بالشكل التالي بالضبط:\n' +
      '{"cells": [["...", "..."], ["...", "..."]]}\n' +
      'يجب أن تحتوي المصفوفة الخارجية على ' + r + ' عنصرًا بالضبط (صف لكل عنصر)، ' +
      'وكل صف داخلي يحتوي على ' + c + ' عنصرًا بالضبط (عمود لكل عنصر). لا تضف أو تحذف صفوف أو أعمدة.';
  } else if (mode === 'lines') {
    const n = parseInt(count, 10);
    if (!n) return res.status(400).json({ error: 'عدد الأسطر مفقود' });
    prompt =
      'هذه صورة تحتوي على ' + n + ' سطر نص بالضبط، مرتبة من أعلى لأسفل.\n' +
      'اقرأ كل سطر بأقصى دقة ممكنة (نص عربي مطبوع أو خط يد أو أرقام)، بدون ترجمة أو تصحيح إملائي.\n' +
      'إذا كان السطر يبدأ برقم ترتيبي، اتركه كما هو ضمن نص السطر - لا تحذفه.\n' +
      'رد فقط بـ JSON صالح بدون أي نص إضافي أو Markdown، بالشكل التالي بالضبط:\n' +
      '{"lines": ["نص السطر الأول", "نص السطر الثاني"]}\n' +
      'يجب أن تحتوي المصفوفة على ' + n + ' عنصرًا بالضبط بنفس الترتيب من أعلى لأسفل.';
  } else if (mode === 'structure') {
    prompt =
      'انظر إلى صورة الجدول التالية، وحدد كام صف بيانات فيه وكام عمود، بافتراض إننا هنحول الجدول لجدول بيانات (spreadsheet).\n' +
      'قواعد مهمة:\n' +
      '- اعتبر كل صف بيانات مستقل صف واحد، حتى لو كان مائل أو فيه ظل أو انعكاس ضوء عليه.\n' +
      '- لو فيه صف عناوين (هيدر) منفصل عن باقي الصفوف، اعتبره صف زيادة.\n' +
      '- عدد الأعمدة = عدد الحقول المختلفة المتكررة في كل صف من حيث المعنى، مش عدد الخطوط الرأسية المرسومة فعليًا - بعض الجداول مالهاش خطوط واضحة بين كل عمودين، وبعضها فيه خطوط زيادة عن الأعمدة الحقيقية (زي رموز أو علامات متكررة).\n' +
      '- تجاهل تمامًا أي ظل، يد، انعكاس، أو تشويه في الصورة نفسها، وركز بس على المحتوى الفعلي للجدول.\n' +
      'رد فقط بـ JSON صالح بدون أي نص إضافي أو Markdown، بالشكل التالي بالضبط:\n' +
      '{"rows": عدد_صحيح, "cols": عدد_صحيح}';
  } else {
    return res.status(400).json({ error: 'mode غير معروف (المتوقع: grid أو lines)' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + response.status);
      return res.status(response.status).json({ error: msg });
    }

    const text = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'تعذر تحليل رد النموذج كـ JSON', raw: text });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) ? err.message : 'خطأ غير متوقع' });
  }
}
