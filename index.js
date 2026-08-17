const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const INPUT_DIM = 192;
const HIDDEN_DIM = 64;
const CONFIDENCE_THRESHOLD = 0.42;
const STOPWORDS = new Set([...]);

// دوال الشبكة العصبية ونظام التشابه (مأخوذة من الكود الأصلي)
// ... (سيتم نسخها)
// سنحتاج لتنفيذ دوال matMul, sigmoid, textToVector, cosineSim, إلخ.

// متغير cache للأوزان
let cachedWeights = null;
let cachedLabels = null;
let cachedExamples = null;

// دالة لتحميل الحالة من Firestore
async function loadState() {
    const snap = await db.doc('miniBrain/sharedState').get();
    if (!snap.exists) return null;
    const data = snap.data();
    return data;
}

// دالة لتحويل الأوزان المخزنة إلى كائنات DenseLayer (للاستخدام)
function restoreNetwork(weightsData) {
    // weightsData: { layers: [ {weights: [...], bias: [...]} ] }
    const layers = weightsData.layers.map(layerData => {
        const layer = new DenseLayer(0, 0); // dummy
        layer.weights = layerData.weights;
        layer.bias = layerData.bias;
        return layer;
    });
    const net = new NeuralNetwork([]);
    net.layers = layers;
    return net;
}

// دالة لحفظ الأوزان بعد التدريب
async function saveWeights(weights, labels, examples) {
    const weightsData = {
        layers: weights.map(layer => ({
            weights: layer.weights,
            bias: layer.bias
        }))
    };
    await db.doc('miniBrain/sharedState').set({
        weights: weightsData,
        labels: labels,
        examples: examples.map(e => ({...e})), // مع إزالة vec
        updatedAt: Date.now()
    }, { merge: true });
}

// دالة تدريب
async function trainModel(examples, labels) {
    // نستخدم الكود الأصلي لبناء شبكة جديدة وتدريبها
    // ثم نعيد الأوزان
    // ملاحظة: يجب استبعاد الأمثلة ذات trust=0
    const trainable = examples.filter(ex => ex.trust !== 0);
    if (labels.length === 0 || trainable.length === 0) return null;
    const net = new NeuralNetwork([INPUT_DIM, HIDDEN_DIM, labels.length]);
    // تدريب...
    // نعيد net.layers (الأوزان)
    return net.layers;
}

// دالة تصنيف
async function classifyText(text) {
    const state = await loadState();
    if (!state) return { confident: false, confidence: 0 };
    // إذا لم توجد أوزان، نعيد false
    if (!state.weights) {
        return { confident: false, confidence: 0 };
    }
    // بناء الشبكة من الأوزان
    const layers = state.weights.layers.map(layerData => {
        const layer = new DenseLayer(0, 0);
        layer.weights = layerData.weights;
        layer.bias = layerData.bias;
        return layer;
    });
    const net = new NeuralNetwork([]);
    net.layers = layers;
    // تحضير البيانات
    const labels = state.labels;
    const examples = state.examples;
    // نضيف vec لكل مثال (إن لم يكن موجوداً)
    examples.forEach(ex => {
        if (!ex.vec) ex.vec = textToVector(ex.text);
    });
    // تطبيق منطق التصنيف (نظام التشابه + الشبكة)
    // ...
    return result;
}

// دالة Cloud Function لمعالجة الرسالة
exports.processMessage = functions.https.onCall(async (data, context) => {
    const text = data.text;
    const result = await classifyText(text);
    return result;
});

// دالة لتعليم مثال جديد (إضافة + تدريب)
exports.train = functions.https.onCall(async (data, context) => {
    const { text, labelIndex, trust, labelName, response } = data;
    // تحميل الحالة الحالية
    const state = await loadState();
    let labels = state.labels || [];
    let examples = state.examples || [];
    // إذا كان labelName موجوداً، نبحث عن labelIndex أو نضيف فئة جديدة
    let label = null;
    if (labelName) {
        label = labels.find(l => l.name === labelName);
        if (!label) {
            label = { index: labels.length, name: labelName, responses: [] };
            labels.push(label);
        }
    } else if (labelIndex !== undefined) {
        label = labels.find(l => l.index === labelIndex);
    }
    if (!label) return { error: 'Label not found or invalid' };
    if (response && !label.responses.includes(response)) {
        label.responses.push(response);
    }
    // إضافة المثال
    const newExample = {
        id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8),
        text: text,
        labelIndex: label.index,
        trust: trust !== undefined ? trust : 0.75,
        vec: textToVector(text) // نضيف المتجه لتجنب حسابه لاحقاً
    };
    examples.push(newExample);
    // تدريب النموذج
    const layers = await trainModel(examples, labels);
    const weightsData = { layers: layers.map(l => ({ weights: l.weights, bias: l.bias })) };
    // حفظ الحالة
    await saveWeights(weightsData, labels, examples);
    return { success: true };
});

// دالة لاستيراد دفعة
exports.bulkImport = functions.https.onCall(async (data, context) => {
    const { lines } = data; // مصفوفة من السلاسل
    // مشابه للكود الأصلي
    // بعد الانتهاء، نعيد تدريب النموذج وحفظه
    return { added, skipped };
});

// عند التحديث، يمكننا استخدام onUpdate لإعادة التدريب تلقائياً، لكننا نفضل أن تتم إعادة التدريب فقط عند الطلب.