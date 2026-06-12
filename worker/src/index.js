/**
 * eMANDEVAL Future - Policy Assistant backend (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Holds the Gemini API key as a Worker SECRET (GEMINI_API_KEY) and calls the
 * Gemini REST API server side. The browser only ever talks to this Worker, so
 * the key is never exposed in frontend code, HTML, CSS, or the GitHub repo.
 *
 *   GitHub Pages frontend  ->  this Worker  ->  Gemini API  ->  answer
 *
 * Endpoint:  POST /api/emandeval-chat
 *
 * FREE TIER NOTE: this is built to run at no direct cost for prototype and
 * low usage using Cloudflare Workers Free and the Gemini API free tier. Free
 * tier quotas, model availability and provider terms may change, and public
 * or high traffic use may require paid hosting or paid model access later.
 *
 * Secrets / vars (set with wrangler, see README_DEPLOY_CHATBOT.md):
 *   GEMINI_API_KEY   (secret, required)
 *   GEMINI_MODEL     (var, optional, default "gemini-2.5-flash")
 *   ALLOWED_ORIGINS  (var, optional, comma separated; default is the GitHub
 *                     Pages origin plus localhost for development)
 */

const DEFAULT_MODEL = 'gemini-2.5-flash';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://drgenie.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5173'
];

/* Limits to protect the free tier and prevent abuse. */
const MAX_QUESTION_CHARS = 1500;
const MAX_TOOLSTATE_CHARS = 20000;
const MAX_ANSWER_CHARS = 8000;

/* Lightweight per IP rate limit. NOTE: this lives in the memory of a single
   Worker isolate, so it is best effort only and resets when the isolate
   recycles. For robust limiting on heavier traffic, use Cloudflare KV or a
   Durable Object. This is sufficient for free tier prototype protection. */
const RATE_MAX = 15;            /* requests ... */
const RATE_WINDOW_MS = 60000;   /* ... per minute per IP */
const rateMap = new Map();

const SYSTEM_PROMPT = [
  'You are the eMANDEVAL Future Policy Assistant embedded in a vaccine mandate decision aid tool.',
  '',
  'Your role is to help users interpret model-predicted public support, class-share-weighted latent-class model results, class breakdowns, benefit-cost outputs, saved policy comparisons, assumptions, limitations and policy risks.',
  '',
  'The tool estimates predicted public support for a selected vaccine mandate policy using a two-class latent-class choice model.',
  '',
  'The predicted support formula is:',
  'P(support) = sum over classes c of [ pi_c * exp(V_policy,c) / ( exp(V_policy,c) + exp(V_no_mandate,c) ) ]',
  '',
  'The estimate is predicted policy support from stated-preference data. It is not actual vaccine uptake, actual compliance, a causal effect, legal advice, medical advice, or an instruction to implement a mandate.',
  '',
  'Use only the current tool state provided by the application. Do not invent values. If a value is missing, say it is missing.',
  '',
  'When interpreting results, explain: what the predicted support means; what drives the result; how the class breakdown affects interpretation; which assumptions matter; what limitations apply; and what practical next step the user could consider.',
  '',
  'When asked for recommendations, provide policy options, not commands. Use language such as "consider", "compare", "test", "review", or "assess".',
  '',
  'Never say a mandate should definitely be implemented. Never provide legal advice or medical advice. Never claim that predicted support is actual uptake or compliance. Always remind users that legal, ethical, operational and equity review is required before any real policy decision.',
  '',
  'Keep responses concise, clear and policy-relevant. Use bullets when helpful. Avoid unnecessary academic jargon unless the user asks for technical detail.',
  '',
  'If asked to draft text, produce polished policy-ready wording but include appropriate caution about stated-preference evidence and assumptions.'
].join('\n');

const SAFETY_NOTE = 'Interpretation support only. Not legal or medical advice. Predicted support is stated-preference policy support, not actual uptake or compliance.';

function allowedOrigins(env) {
  if (env && env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  const ok = origin && list.indexOf(origin) !== -1;
  const headers = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
  if (ok) headers['Access-Control-Allow-Origin'] = origin;
  return { headers, ok };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (rateMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rateMap.set(ip, arr); return true; }
  arr.push(now);
  rateMap.set(ip, arr);
  /* opportunistic cleanup to bound memory */
  if (rateMap.size > 5000) { for (const k of rateMap.keys()) { if (k !== ip) { rateMap.delete(k); break; } } }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    /* Preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed. Use POST.' }, 405, cors.headers);
    }

    /* Only allow configured origins. */
    if (!cors.ok) {
      return json({ error: 'Origin not allowed.' }, 403, cors.headers);
    }

    /* Best effort per IP throttle. */
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'Too many requests. Please wait a moment and try again.' }, 429, cors.headers);
    }

    /* Parse body */
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON body.' }, 400, cors.headers);
    }

    const question = (body && typeof body.question === 'string') ? body.question : '';
    if (!question || !question.trim()) {
      return json({ error: 'A question is required.' }, 400, cors.headers);
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return json({ error: 'Question is too long. Limit is ' + MAX_QUESTION_CHARS + ' characters.' }, 400, cors.headers);
    }

    const toolState = (body && body.toolState && typeof body.toolState === 'object') ? body.toolState : {};
    let toolStateStr;
    try {
      toolStateStr = JSON.stringify(toolState);
    } catch (e) {
      return json({ error: 'Tool state could not be read.' }, 400, cors.headers);
    }
    if (toolStateStr.length > MAX_TOOLSTATE_CHARS) {
      return json({ error: 'Tool state is too large.' }, 400, cors.headers);
    }

    const apiKey = env && env.GEMINI_API_KEY;
    if (!apiKey) {
      return json({ error: 'The assistant is not configured on the server. Set the GEMINI_API_KEY secret.' }, 500, cors.headers);
    }
    const model = (env && env.GEMINI_MODEL) ? env.GEMINI_MODEL : DEFAULT_MODEL;

    const userContent =
      'Current eMANDEVAL tool state:\n' +
      JSON.stringify(toolState, null, 2) +
      '\n\nUser question:\n' + question +
      '\n\nPlease answer using the system instructions. Use only the tool state and do not invent unsupported values.';

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.9,
        /* Large enough for full briefings and technical explanations so replies
           are not cut off. */
        maxOutputTokens: 2048,
        /* gemini-2.5 models "think" by default, and that thinking is charged
           against maxOutputTokens. With a small budget the visible answer gets
           truncated or comes back empty. Disable thinking for fast, complete,
           consistent policy responses. */
        thinkingConfig: { thinkingBudget: 0 }
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
      ]
    };

    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

    let gResp;
    try {
      gResp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return json({ error: 'The AI service could not be reached. Please try again later.' }, 502, cors.headers);
    }

    if (!gResp.ok) {
      let msg = 'The AI service returned an error.';
      if (gResp.status === 429) msg = 'The free tier quota has been reached. Please try again later.';
      else if (gResp.status === 401 || gResp.status === 403) msg = 'The AI service rejected the request. Check the API key.';
      else if (gResp.status >= 500) msg = 'The AI service is temporarily unavailable. Please try again later.';
      return json({ error: msg }, gResp.status === 429 ? 429 : 502, cors.headers);
    }

    let data;
    try {
      data = await gResp.json();
    } catch (e) {
      return json({ error: 'The AI service returned an unreadable response.' }, 502, cors.headers);
    }

    /* Prompt level safety block */
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return json({ error: 'The request was blocked by the AI safety filter. Please rephrase your question.' }, 422, cors.headers);
    }

    const cand = data.candidates && data.candidates[0];
    if (cand && cand.finishReason === 'SAFETY') {
      return json({ error: 'The response was blocked by the AI safety filter. Please rephrase your question.' }, 422, cors.headers);
    }

    let answer = '';
    if (cand && cand.content && Array.isArray(cand.content.parts)) {
      answer = cand.content.parts.map(p => (p && p.text) ? p.text : '').join('').trim();
    }

    if (!answer) {
      /* No text came back. Give a specific, useful message by finish reason. */
      const fr = cand && cand.finishReason;
      if (fr === 'MAX_TOKENS') {
        return json({ error: 'The response was longer than the limit. Please ask for a shorter answer or a specific part.' }, 502, cors.headers);
      }
      return json({ error: 'No answer was produced. Please try rephrasing your question.' }, 502, cors.headers);
    }

    /* If the model hit the token ceiling mid sentence, add a small note rather
       than failing, so the user still gets the useful part. */
    if (cand && cand.finishReason === 'MAX_TOKENS') {
      answer += '\n\n(Response reached the length limit. Ask me to continue or focus on one part for more detail.)';
    }

    if (answer.length > MAX_ANSWER_CHARS) {
      answer = answer.slice(0, MAX_ANSWER_CHARS) + '\n\n(Response trimmed for length.)';
    }

    /* We do not log or store the question, the tool state, or the answer. */
    return json({ answer: answer, model: model, safetyNote: SAFETY_NOTE }, 200, cors.headers);
  }
};
