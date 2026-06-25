# UPSC News Map — deployment guide

This makes the system run by itself, forever, with zero manual updates.
You set it up once. After that, a clock on Render triggers the backend script
every hour, and your website just displays whatever is in the database.

```
[NewsData.io] --hourly cron--> [backend script on Render]
                                       |
                                       | Claude Haiku 4.5 judges relevance + extracts place
                                       | OpenStreetMap geocodes the place
                                       v
                                [Supabase database]
                                       ^
                                       | reads only, every page load
                                       |
                                [your website, anywhere]
```

## Step 1 — Create the database (Supabase, free)

1. Go to supabase.com → New project (free tier is enough)
2. Open the SQL editor → paste the contents of `backend/supabase_schema.sql` → Run
3. Go to Settings → API. Copy two values, you'll need them twice:
   - `Project URL` → this is `SUPABASE_URL`
   - `anon public` key → this is `SUPABASE_ANON_KEY` (goes in the frontend, safe to expose)
   - `service_role` key → this is `SUPABASE_SERVICE_KEY` (goes in the backend ONLY, never put this in frontend code or git)

## Step 2 — Get your API keys

1. **Anthropic key** — console.anthropic.com → Settings → API keys → Create key.
   Cost is tiny: Haiku 4.5 is $1 per million input tokens, and each article classification
   is roughly 150-300 tokens, so classifying ~50 articles/hour costs a few cents a day.
2. **NewsData.io key** — newsdata.io → sign up free → copy the API key from your dashboard.
   Free tier gives 200 requests/day, which comfortably covers an hourly run.

## Step 3 — Deploy the backend (Render, free cron job)

1. Push the `backend/` folder to a GitHub repo (or use Render's "deploy from existing repo")
2. On render.com: New → Cron Job
3. Connect your repo, set:
   - Build command: `npm install`
   - Command: `npm start`
   - Schedule: `0 * * * *` (runs once every hour — adjust as you like)
4. Under Environment, add these four variables (Render keeps them encrypted, never in your code):
   - `ANTHROPIC_API_KEY`
   - `NEWSDATA_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
5. Deploy. Render will now run `fetch_and_classify.js` every hour automatically, forever,
   with no further action from you.

## Step 4 — Deploy the frontend (anywhere static, free)

1. Open `frontend/index.html` and replace:
   - `YOUR_SUPABASE_URL_HERE` → your real Supabase Project URL
   - `YOUR_SUPABASE_ANON_KEY_HERE` → your real anon public key
2. Deploy this single HTML file anywhere static-hosting-friendly:
   - Netlify Drop (drag and drop the file, instant)
   - Vercel
   - GitHub Pages
   - Or even Supabase Storage as a public bucket

That's it. The website pulls live from Supabase on every visit and refreshes itself
every 5 minutes — and the database refills itself every hour via Render's cron — so
nobody, including you, needs to touch anything after this setup.

## Tuning it for APPSC specifically (optional, recommended)

Right now the news search queries in `fetch_and_classify.js` are generic India/UPSC
queries. Since you're prepping APPSC Group 2 specifically, you'll get much more
relevant hits by adding Andhra Pradesh-specific queries to the `queries` array:

```js
const queries = [
  "India government policy",
  "Andhra Pradesh government scheme",
  "Andhra Pradesh assembly",
  "AP government order",
  // ...keep the rest
];
```

And you can tighten the Claude system prompt to weight AP state-specific governance,
schemes, and current affairs higher, since that's the exam's actual syllabus emphasis.

## Costs (all free-tier, realistic monthly total)

| Service | Free tier limit | Expected use |
|---|---|---|
| Supabase | 500MB DB, 2 projects | Way under, this app is tiny |
| Render cron job | 750 free hours/month | This uses minutes/month, not hours |
| NewsData.io | 200 requests/day | ~144/day at hourly runs across 6 queries |
| Anthropic API | pay-as-you-go, no free tier | A few cents/day at this volume |

Total realistic cost: under $2/month, almost entirely the Anthropic API usage.
