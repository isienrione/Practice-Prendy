export async function handler(event) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "OPENAI_API_KEY is not configured" }),
    };
  }

  try {
    const formData = JSON.parse(event.body || "{}");

    const prompt = `You are Prendy, a logistics AI for social gatherings in Santiago, Chile. Generate a detailed event logistics blueprint.

Event: ${formData.type}, ${formData.guestCount} guests, ${formData.budget} CLP budget, Setting: ${formData.setting}, Vibe: ${formData.vibe}, Dietary: ${formData.dietary || "None"}, Notes: ${formData.notes || "None"}
Store routing rules (Chile / Santiago):
- lider: bulk groceries + staples (tortillas, meat, veg, soda, chips, paper goods).
- jumbo: premium host items (gourmet cheese/charcuterie, nicer desserts, better wine, imported ingredients).
- pedidosya or ubereats: last-minute party supplies + fast delivery (balloons, decor, candles, extra snacks, emergency items).
- rappi: very fast drinks/ice.
- mercadolibre: chairs, benches, tables, equipment, lighting, speakers, coolers.
REQUIREMENT: Use at least 3 different preferred_store values across the supplies when guestCount >= 12.
preferred_store must be one of: lider, jumbo, pedidosya, ubereats, rappi, mercadolibre.


Respond ONLY with valid JSON (no markdown, no commentary) exactly matching this schema:
{
  "summary": "one sentence",
  "timeline": [{"time": "HH:MM", "task": "desc", "owner": "who"}],
  "supplies": {
    "food": [
      {"item": "name", "quantity": 0, "unit": "u", "note": "tip", "preferred_store": "lider", "suggestedStores": ["lider","jumbo"]}
    ],
    "drinks": [
      {"item": "name", "quantity": 0, "unit": "u", "note": "tip", "preferred_store": "rappi", "suggestedStores": ["rappi","lider"]}
    ],
    "equipment": [
      {"item": "name", "quantity": 0, "unit": "u", "note": "tip", "preferred_store": "mercadolibre", "suggestedStores": ["mercadolibre","lider"]}
    ]
  },
  "budget": {
    "venue": {"amount": 0, "pct": 0},
    "food": {"amount": 0, "pct": 0},
    "drinks": {"amount": 0, "pct": 0},
    "entertainment": {"amount": 0, "pct": 0},
    "staff": {"amount": 0, "pct": 0},
    "misc": {"amount": 0, "pct": 0}
  },
  "staffing": {"servers": 0, "bartenders": 0, "setup_crew": 0},
  "tips": ["tip1","tip2","tip3"],
  "risks": ["risk1","risk2"]
}

}`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.8,
        messages: [
          { role: "system", content: "You output ONLY valid JSON. No markdown." },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: cors,
        body: JSON.stringify({ error: "OpenAI error", details: data }),
      };
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || "";

    // Hardening: strip accidental code fences
    const cleaned = text.replace(/```json|```/g, "").trim();

    // Extract JSON object if there is extra text
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found in model output");

    const parsed = JSON.parse(cleaned.slice(start, end + 1));

const ALLOWED_STORES = new Set(["lider","jumbo","pedidosya","ubereats","rappi","mercadolibre"]);
const normStore = (s) => String(s || "").trim().toLowerCase();


function ensureStores(list, cat) {
  return (Array.isArray(list) ? list : []).map((x) => {
    // Normalize incoming store fields (if model provided them)
    const ps = normStore(x.preferred_store);
    const ss = Array.isArray(x.suggestedStores)
      ? x.suggestedStores.map(normStore).filter((s) => ALLOWED_STORES.has(s))
      : [];

 if (ALLOWED_STORES.has(ps) && ss.length) {
  const merged = [ps, ...ss]
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 4);
  return { ...x, preferred_store: ps, suggestedStores: merged };
}
const g = Number(formData.guestCount) || 0;
if (g >= 12) {
  const used = new Set(
    ["food","drinks","equipment"].flatMap(k => (parsed.supplies?.[k] || []).map(x => x.preferred_store))
  );
  if (used.size < 3) {
    // force diversity without changing quantities
    if (parsed.supplies.food?.length) parsed.supplies.food[0].preferred_store = "jumbo";
    if (parsed.supplies.equipment?.length) parsed.supplies.equipment[0].preferred_store = "mercadolibre";
  }
}


    // Otherwise route based on content + category
    const name = String(x.item || "").toLowerCase();
    let preferred = "lider";

    // Equipment / rentals => MercadoLibre
    if (
      cat === "equipment" ||
      /chair|chairs|bench|benches|table|tables|speaker|speakers|light|lights|projector|cooler/.test(name)
    ) {
      preferred = "mercadolibre";
    }
    // Premium host items => Jumbo
    else if (
      /cheese|charcut|brie|camembert|prosciutto|gourmet|wine|cabernet|carmenere|sauvignon|champagne|sparkling/.test(name)
    ) {
      preferred = "jumbo";
    }
    // Last-minute decor/party supplies => PedidosYa or UberEats
    else if (
      /balloon|balloons|garland|decor|decoration|candles|confetti|banner|centerpiece|tablecloth|globos|guirnalda/.test(name)
    ) {
      preferred = "pedidosya";
    }
    // Ice / urgent drinks => Rappi
    else if (/ice|hielo/.test(name)) {
      preferred = "rappi";
    }

    preferred = ALLOWED_STORES.has(preferred) ? preferred : "lider";

    const fallback = {
      lider: ["lider", "jumbo"],
      jumbo: ["jumbo", "lider"],
      pedidosya: ["pedidosya", "ubereats", "rappi"],
      ubereats: ["ubereats", "pedidosya", "rappi"],
      rappi: ["rappi", "lider"],
      mercadolibre: ["mercadolibre", "lider"],
    }[preferred];

    return { ...x, preferred_store: preferred, suggestedStores: fallback };
  });
}

parsed.supplies = parsed.supplies || {};
parsed.supplies.food = ensureStores(parsed.supplies.food, "food");
parsed.supplies.drinks = ensureStores(parsed.supplies.drinks, "drinks");
parsed.supplies.equipment = ensureStores(parsed.supplies.equipment, "equipment");

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: "Server error",
        message: String(err?.message || err),
      }),
    };
  }
}
