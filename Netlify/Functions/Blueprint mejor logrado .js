// netlify/functions/blueprint.js

import fs from "fs";
import path from "path";
import OpenAI from "openai";

/**
 * ============
 * LOAD CATALOG
 * ============
 */

const catalogPath = path.join(process.cwd(), "data", "party_catalog_v4.json");

let RAW_CATALOG;
let PARTY_ITEMS = [];

try {
  RAW_CATALOG = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  PARTY_ITEMS = RAW_CATALOG?.stores?.[0]?.items || [];
  console.log(
    `[Prendy] Loaded party_catalog_v4.json: version=${RAW_CATALOG.version}, currency=${RAW_CATALOG.currency}, items=${PARTY_ITEMS.length}`
  );
} catch (err) {
  console.error(
    "[Prendy] Failed to load data/party_catalog_v4.json; falling back to empty catalog:",
    err
  );
  RAW_CATALOG = { version: "4.0", currency: "CLP", stores: [] };
  PARTY_ITEMS = [];
}

/**
 * ======================
 * LIGHTWEIGHT CATALOG IQ
 * ======================
 */

function normalizeTag(t) {
  return (t || "").toString().trim().toLowerCase();
}

function hasTag(item, tag) {
  const needle = normalizeTag(tag);
  return (item.tags || []).map(normalizeTag).includes(needle);
}

function scoreForEvent(item, eventType) {
  const tags = (item.tags || []).map(normalizeTag);
  const cat = normalizeTag(item.category);

  let score = 0;

  // Base on category
  if (["finger_food", "brunch_box", "cheese", "charcuterie"].includes(cat)) {
    score += 3;
  }
  if (["main_delivery", "main_prepared"].includes(cat)) {
    score += 4;
  }
  if (["dessert"].includes(cat)) {
    score += 3;
  }
  if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) {
    score += 2;
  }

  // Event-specific boosts
  if (eventType === "adult_birthday_home") {
    if (tags.includes("adult_birthday_home")) score += 3;
    if (tags.includes("big_home_party")) score += 2;
    if (tags.includes("party")) score += 2;
    if (tags.includes("chilean")) score += 2;
    if (tags.includes("ready_to_heat")) score += 1;
    if (tags.includes("finger_food")) score += 1;
  }

  return score;
}

function categorizeItemsForEvent(eventType) {
  const buckets = {
    fingerFoods: [],
    mains: [],
    desserts: [],
    drinks: [],
    other: [],
  };

  PARTY_ITEMS.forEach((item) => {
    const cat = normalizeTag(item.category);
    const scored = { ...item, score: scoreForEvent(item, eventType) };

    if (["finger_food", "cheese", "charcuterie", "brunch_box"].includes(cat)) {
      buckets.fingerFoods.push(scored);
    } else if (["main_delivery", "main_prepared"].includes(cat)) {
      buckets.mains.push(scored);
    } else if (["dessert"].includes(cat)) {
      buckets.desserts.push(scored);
    } else if (["wine", "beer", "spirits", "soft_drink", "coffee"].includes(cat)) {
      buckets.drinks.push(scored);
    } else {
      buckets.other.push(scored);
    }
  });

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.name || "").localeCompare(b.name || "");
    });
  }

  return buckets;
}

function summarizeBucket(label, items, max = 40) {
  const lines = [];
  lines.push(`=== ${label} (top ${Math.min(max, items.length)} of ${items.length}) ===`);
  items.slice(0, max).forEach((it) => {
    lines.push(
      `- id=${it.id || "?"}, name=${it.name || "?"}, category=${it.category || "?"}, score=${it.score}, price=${it.price ?? "null"}, tags=${(it.tags || []).join(", ")}`
    );
  });
  return lines.join("\n");
}

function buildStructuredCatalogView(eventType) {
  const buckets = categorizeItemsForEvent(eventType);

  const lines = [];
  lines.push(
    `Catalog version=${RAW_CATALOG.version}, currency=${RAW_CATALOG.currency}, totalItems=${PARTY_ITEMS.length}`
  );
  lines.push("");

  lines.push(summarizeBucket("Finger foods / brunch / cheese boards", buckets.fingerFoods));
  lines.push("");
  lines.push(summarizeBucket("Mains / main delivery / prepared mains", buckets.mains));
  lines.push("");
  lines.push(summarizeBucket("Desserts & sweets", buckets.desserts));
  lines.push("");
  lines.push(summarizeBucket("Drinks & coffee", buckets.drinks));
  lines.push("");
  lines.push(summarizeBucket("Other", buckets.other));

  return {
    text: lines.join("\n"),
    buckets,
  };
}

/**
 * ============
 * OPENAI CLIENT
 * ============
 */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * ==================
 * NETLIFY ENTRYPOINT
 * ==================
 */

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const {
    eventType = "adult_birthday_home",
    guestCount = 20,
    budgetCLP = 0,
    location = "Santiago",
    notes = "",
  } = body;

  const requestSummary = [
    `Event type: ${eventType}`,
    `Guest count: ${guestCount}`,
    `Budget (CLP): ${budgetCLP}`,
    `Location: ${location}`,
    `User notes: ${notes || "none"}`,
  ].join("\n");

  const { text: catalogView, buckets } = buildStructuredCatalogView(eventType);

  const planningSkeleton = {
    fingerFoodIds: buckets.fingerFoods.slice(0, 12).map((i) => i.id),
    mainIds: buckets.mains.slice(0, 12).map((i) => i.id),
    dessertIds: buckets.desserts.slice(0, 12).map((i) => i.id),
    drinkIds: buckets.drinks.slice(0, 12).map((i) => i.id),
  };

  const systemPrompt = `
You are Prendy, an expert party-planning assistant in Santiago, Chile.
You have a structured catalog of real products (food, drinks, equipment).
Your primary job is to design a concrete MENU using ONLY catalog items, then give light suggestions about where they might be sourced.

CATALOG STRUCTURE
-----------------
You are given:
- A grouped catalog view (fingerFoods, mains, desserts, drinks, other) with ids, names, tags, prices, and scores.
- A planning skeleton listing top item ids per bucket:
  - fingerFoodIds
  - mainIds
  - dessertIds
  - drinkIds

Each item has:
- id (string, unique)
- name (string)
- description (string, may be short or empty)
- category, subcategory
- price (CLP) or null
- vendorName
- serviceType
- tags (string[])

HARD RULES
----------
1. You MUST ONLY recommend items that exist in the catalog view and that appear with an id.
2. Every product line MUST mention its exact id in parentheses: "Product name (id=...)". This is non-negotiable.
3. Do NOT invent generic items like "main protein" or "dessert portions" without tying them to a specific catalog item.
4. Do NOT structure the answer as supermarket checklists (no sections like "Lider.cl — 15 items ~ $X").
5. You MAY mention supermarkets (Lider, Jumbo, Rappi, etc.) only in a short "Where to buy" section at the END, after the menu, as suggestions of likely sources, without detailed price breakdowns.
6. Respect the user's budget and guest count as much as possible:
   - For 20–40 guests, you need variety and enough volume.
   - Prefer "ready_to_heat", "finger_food", and similar tags for home parties.
7. Prefer items whose tags or categories match the event type and Chilean context: "adult_birthday_home", "big_home_party", "chilean", "asado", "party", etc.
8. Organize the answer into sections with headings:
   - Event overview
   - Food plan (Starters, Mains, Desserts)
   - Drinks plan
   - Equipment & serving (high-level, can mention catalog items if available)
   - Where to buy (short, optional)
9. In Food and Drinks sections, provide at least:
   - 3–5 different catalog items for starters.
   - 2–3 different catalog items for mains (clearly specifying what protein(s) people will eat).
   - 2+ catalog items for desserts.
   - 4+ catalog items for drinks.
   For EACH item, include:
   - name
   - id
   - approximate quantity scaled to the guest count
   - 1-sentence rationale.
10. If the catalog is weak in a given area (e.g. no ice, no tables), say so explicitly and mention that the host can buy those at a supermarket or party store, but do not list SKUs or prices there.

Your tone: practical, specific, like a local planner who actually orders from these vendors.
`;

  const userPrompt = `
USER REQUEST
------------
${requestSummary}

CATALOG VIEW (GROUPED & SCORED)
--------------------------------
${catalogView}

PLANNING SKELETON (TOP IDS)
---------------------------
${JSON.stringify(planningSkeleton, null, 2)}

TASK
----
1) Build a concrete MENU for this event using ONLY catalog items:
   - Starters: use fingerFoodIds and related items.
   - Mains: use mainIds and related items (be explicit about proteins).
   - Desserts: use dessertIds and related items.
   - Drinks: use drinkIds and related items.
2) For each selected item, include:
   - item name
   - id (id=...)
   - quantity for ${guestCount} guests
   - a brief reason tied to tags/category.
3) After the menu, add a short "Where to buy" section that:
   - mentions 1–3 likely channels (e.g. Lider, Jumbo, Rappi) in very general terms,
   - does NOT list detailed quantities or prices there (the menu already handled that),
   - keeps focus on how to operationalize the menu.
4) Do NOT output store-by-store price tables or "Open Lider.cl" style CTAs.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      max_tokens: 1500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const text = completion.choices?.[0]?.message?.content || "";

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        blueprint: text,
        catalogVersion: RAW_CATALOG.version,
        catalogItemCount: PARTY_ITEMS.length,
      }),
    };
  } catch (err) {
    console.error("[Prendy] OpenAI error generating blueprint:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: "Failed to generate blueprint",
        details: err.message || String(err),
      }),
    };
  }
};
