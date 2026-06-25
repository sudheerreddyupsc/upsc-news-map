/**
 * UPSC NEWS MAP — automated pipeline
 * ------------------------------------
 * Runs on a schedule (cron). Each run:
 *   1. Pulls fresh articles from a news API
 *   2. Asks Claude Haiku to judge UPSC relevance + extract place + category
 *   3. Geocodes the place name to lat/lon (OpenStreetMap, free)
 *   4. Upserts the result into Supabase (so duplicates don't pile up)
 *
 * No human ever needs to touch this once it's deployed and scheduled.
 *
 * ENV VARS REQUIRED (set these in Render/Railway dashboard, never hardcode):
 *   ANTHROPIC_API_KEY   - from console.anthropic.com
 *   NEWSDATA_API_KEY    - from newsdata.io (free tier)
 *   SUPABASE_URL        - from your Supabase project settings
 *   SUPABASE_SERVICE_KEY- Supabase "service_role" key (server-side only, never expose to frontend)
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ---- 1. FETCH RAW NEWS -----------------------------------------------------
// NewsData.io free tier: 200 requests/day, good enough for a run every ~30-60 min.
// We search broad UPSC-adjacent categories; Claude does the real filtering after.
async function fetchRawNews() {
  const queries = [
    "India government policy",
    "India Supreme Court",
    "India environment ministry",
    "India foreign policy",
    "India economy RBI",
    "India welfare scheme"
  ];

  const allArticles = [];
  for (const q of queries) {
    const url = `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&q=${encodeURIComponent(q)}&language=en&country=in`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.status === "error") {
        console.error(`NewsData.io error for query "${q}": HTTP ${res.status} -`, JSON.stringify(data));
        continue;
      }
      if (Array.isArray(data.results)) {
        allArticles.push(...data.results);
      } else {
        console.error(`Unexpected response shape for query "${q}":`, JSON.stringify(data));
      }
    } catch (err) {
      console.error(`Fetch failed for query "${q}":`, err.message);
    }
    // Small delay to be polite to the free tier rate limit
    await sleep(300);
  }

  // De-duplicate by article_id / link
  const seen = new Set();
  return allArticles.filter(a => {
    const key = a.article_id || a.link;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- 2. CLASSIFY WITH CLAUDE HAIKU -----------------------------------------
// One cheap call per article. Returns strict JSON so we can parse it directly.
const CLASSIFY_SYSTEM_PROMPT = `You are a classifier for an APPSC/UPSC current-affairs news map.

Given a news headline and short description, decide:
1. Is this relevant to UPSC/APPSC Civil Services exam preparation? Relevant topics include:
   Polity & Constitution, Governance, Indian Economy, Environment & Ecology, Social Issues
   & Welfare Schemes, Science & Tech (policy angle), International Relations & India's
   foreign policy, Internal Security, Geography (with current-events angle), History (only
   if tied to a current event like a monument/heritage controversy).
2. If relevant, extract the SINGLE most specific place name the news is centered on
   (a city, state, or country — prefer the most specific level mentioned, e.g. "Manipur"
   not just "India" if Manipur is the actual subject).
3. Assign ONE category from: Polity, Economy, Environment, Schemes, IR, Security, SciTech, Society, Geography, History

Respond with ONLY valid JSON, no other text, in this exact shape:
{"relevant": true, "place": "Manipur, India", "category": "Polity", "summary": "one sentence, under 20 words"}

If not relevant:
{"relevant": false}`;

async function classifyArticle(article, attempt = 1) {
  const content = `Headline: ${article.title}\nDescription: ${article.description || ""}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: "user", content }]
    });

    const text = msg.content[0].text.trim();
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    // Transient network errors (e.g. "Premature close") are worth a couple of
    // retries with a short backoff, rather than giving up immediately.
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return classifyArticle(article, attempt + 1);
    }
    console.error("Classification failed for article:", article.title, err.message);
    return { relevant: false };
  }
}

// ---- 3. GEOCODE PLACE NAME -> LAT/LON --------------------------------------
// OpenStreetMap Nominatim: free, no key, but max ~1 request/second.
async function geocodePlace(placeName) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(placeName)}&format=json&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "upsc-news-map/1.0 (educational project)" }
    });
    const results = await res.json();
    if (results.length === 0) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } catch (err) {
    console.error("Geocoding failed for:", placeName, err.message);
    return null;
  }
}

// ---- 4. SAVE TO SUPABASE ----------------------------------------------------
async function saveNewsItem(article, classification, coords) {
  const { error } = await supabase.from("news_items").upsert(
    {
      article_id: article.article_id || article.link,
      headline: article.title,
      summary: classification.summary,
      place: classification.place,
      category: classification.category,
      lat: coords.lat,
      lon: coords.lon,
      source_url: article.link,
      source_name: article.source_id || "unknown",
      published_at: article.pubDate
    },
    { onConflict: "article_id" }
  );

  if (error) console.error("Supabase insert failed:", error.message);
}

// ---- MAIN PIPELINE ----------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log(`[${new Date().toISOString()}] Starting pipeline run...`);

  const articles = await fetchRawNews();
  console.log(`Fetched ${articles.length} raw articles`);

  let savedCount = 0;

  for (const article of articles) {
    if (!article.title) continue;

    await sleep(400);
    const classification = await classifyArticle(article);
    if (!classification.relevant || !classification.place) continue;

    // Respect Nominatim's 1 req/sec limit
    await sleep(1100);
    const coords = await geocodePlace(classification.place);
    if (!coords) continue;

    await saveNewsItem(article, classification, coords);
    savedCount++;
  }

  console.log(`Pipeline run complete. Saved ${savedCount} UPSC-relevant items.`);
}

run().catch(err => {
  console.error("Pipeline crashed:", err);
  process.exit(1);
});
