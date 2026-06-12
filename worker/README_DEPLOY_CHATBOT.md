# Deploy the eMANDEVAL Policy Assistant (free tier)

This sets up the AI chatbot at no direct cost for prototype and low usage. The
browser never holds the API key. The frontend calls only your Cloudflare
Worker, and the Worker calls Gemini server side.

    GitHub Pages frontend  ->  Cloudflare Worker  ->  Gemini API  ->  answer

> Free tier note: this uses Cloudflare Workers Free and the Gemini API free
> tier. Free tier quotas, model availability and provider terms can change.
> Public or high traffic use may later require paid hosting or paid model
> access.

---

## Which files go where

Two parts. Deploy both.

1. Frontend (GitHub Pages repo): `index.html`, `app.js`, `assistant.js`,
   `styles.css`, `methodology.html`, `README.txt`, `CHATBOT_TESTS.md`. These
   replace the matching files in your Pages repository. The chatbot UI, the
   open/close/minimise behaviour, copy and add to report, and the response
   formatting all live here.
2. Backend (Cloudflare Worker): the `worker/` folder, which contains
   `src/index.js`, `wrangler.toml`, `package.json`, and this guide. The AI
   call, the token limits, the thinking-off setting that prevents cut-off
   answers, the CORS rules and the rate limit live here.

## Already deployed an earlier version? Redeploy both

If your answers were getting cut off after a few lines, that fix is in the
Worker (`worker/src/index.js`: thinking is disabled and the output token
budget is raised). You MUST redeploy the Worker for it to take effect:

```
cd worker
wrangler deploy
```

The open/close/minimise, scrolling, formatting and copy fixes are in the
frontend, so also push the updated `index.html`, `assistant.js` and
`styles.css` to GitHub Pages. The Worker URL is already set in `assistant.js`.

---

## Step 1. Create a free Gemini API key

1. Go to Google AI Studio at https://aistudio.google.com/app/apikey
2. Sign in and create (or copy) a Gemini API key.
3. Copy the key somewhere safe for the next step.
4. Do NOT paste the key into any frontend file, into `assistant.js`, or into
   the GitHub repository. It belongs only in the Cloudflare secret below.

## Step 2. Create a free Cloudflare account and install Wrangler

1. Sign up at https://dash.cloudflare.com (free plan is fine).
2. Install Wrangler (the Workers command line tool):

   ```
   npm install -g wrangler
   ```

3. Log in:

   ```
   wrangler login
   ```

## Step 3. Deploy the Worker

From the folder that contains this file:

```
cd worker
npm install
wrangler secret put GEMINI_API_KEY
```

When prompted, paste your Gemini key and press Enter. It is stored encrypted by
Cloudflare and is never written to the repo.

Optional: set or change the model. The default is `gemini-2.5-flash`. For
maximum free tier reliability you can use `gemini-2.5-flash-lite`. Either set it
in `wrangler.toml` under `[vars]`, or as a variable:

```
wrangler secret put GEMINI_MODEL     # then type, for example, gemini-2.5-flash
```

Then deploy:

```
wrangler deploy
```

Wrangler prints a URL like:

```
https://emandeval-chat.YOUR-SUBDOMAIN.workers.dev
```

## Step 4. The Worker URL is already set

`assistant.js` is already configured with your deployed Worker URL:

```
const CHATBOT_WORKER_URL = "https://emandeval-chat.drgenie.workers.dev/api/emandeval-chat";
```

If your Worker subdomain ever changes, update that one line (keep the
`/api/emandeval-chat` path), then commit and push:

```
git add assistant.js
git commit -m "Update Policy Assistant Worker URL"
git push
```

## Step 5. Allow your site origin (CORS)

The Worker only answers requests from origins you allow. The default already
includes `https://drgenie.github.io`. If your Pages site is on a different
origin, update `ALLOWED_ORIGINS` in `worker/wrangler.toml` (comma separated),
then run `wrangler deploy` again. Use the scheme and host only, with no path,
for example `https://drgenie.github.io`.

## Step 6. Test

1. Open the GitHub Pages tool.
2. Click "Ask Policy Assistant".
3. Try the quick buttons (Explain this result, Explain the LC model, and so on).
4. Type a free text question, for example "What does this predicted support mean?".
5. Open browser DevTools (Network tab) and confirm requests go to your Worker
   URL, not to Google, and that no API key appears anywhere in the page source.
6. Confirm a graceful message appears if the backend is briefly unavailable.

## Step 7. Security check

1. In the repo, search for `GEMINI_API_KEY` and for the actual key value. The
   key value must NOT appear anywhere in the repository.
2. Confirm the secret is set in Cloudflare: `wrangler secret list`.
3. Confirm CORS is limited to your GitHub Pages origin in `wrangler.toml`.

## Step 8. Free tier use

- Keep responses short; the Worker caps output length already.
- The frontend limits each session to 20 messages, and the Worker limits
  question length and tool state size and applies a light per IP throttle.
- Monitor usage in the Cloudflare dashboard and in Google AI Studio.
- If a quota is exceeded, users see a clear fallback message and the rest of
  the decision aid keeps working.

---

## Troubleshooting

- "AI assistant is unavailable": check the Worker URL in `assistant.js`, that
  the `GEMINI_API_KEY` secret is set, and that you are within the free tier
  quota.
- CORS error in the console: the request origin is not in `ALLOWED_ORIGINS`.
  Add it in `wrangler.toml` and redeploy.
- 401 or 403 from the Worker: the Gemini API key is missing or invalid. Re-run
  `wrangler secret put GEMINI_API_KEY` and redeploy.
- 429 from the Worker: rate limit or quota reached. Wait and retry, or reduce
  message frequency.
- API key exposed warning: if a key ever appears in the frontend or repo,
  rotate it in Google AI Studio immediately, then set the new key with
  `wrangler secret put GEMINI_API_KEY` and redeploy. Never commit keys.
- Responses stop after a few lines: redeploy the Worker. The fix disables
  model "thinking" (which was consuming the output budget) and raises
  maxOutputTokens. Run `cd worker` then `wrangler deploy`.
- Chatbot gives generic or empty answers: confirm the tool state is being sent.
  In DevTools, inspect the POST body to `/api/emandeval-chat` and check that
  `toolState` is populated. Apply a design in the tool first.
