import fs from "fs";
import path from "path";
import fetch from "node-fetch";

export async function handler(event) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  // Load the detailed Catalog v5
  const catalogPath = path.join(process.cwd(), "data", "party_catalog_v5.json");
  let catalog;
  try {
    const rawData = fs.readFileSync(catalogPath, "utf8");
    catalog = JSON.parse(rawData);
  } catch (err) {
    console.error("Error loading catalog:", err);
    return { 
      statusCode: 500, 
      headers: cors, 
      body: JSON.stringify({ error: "Catalog file not found or invalid" }) 
    };
  }

  const formData = JSON.parse(event.body || "{}");
  const apiKey = process.env.OPENAI_API_KEY;

  // FOUNDER'S EXPERT LOGIC:
  // We provide the AI with a structured view of the catalog.
  // We instruct it to be an expert planner that prioritizes specific brands but maintains functionality.
  const systemPrompt = `
You are "Prendy", the expert logistics AI for premium social gatherings in Santiago, Chile.
Your task is to generate a personalized "Blueprint" JSON.

EXPERT SENSITIVITY & RULES:
1. NO GENERIC ITEMS: Do not say "Main protein" or "Sodas". Use the exact "name" from the catalog (e.g., "Lomo Vetado Premium Camposorno").
2. BRAND & PRICE PRIORITY: Always prioritize items that have complete brand names and price data.
3. GRACEFUL FALLBACK: If a necessary item for the event (like "Ice" or a specific "Decoration") lacks price or brand details in the catalog, you MUST still include it to ensure the event is functional. Use the name provided and estimate the quantity.
4. QUANTITY SCALING: Calculate quantities for ${formData.guestCount} guests (e.g., 300g meat/person, 1 bottle of wine per 3 people).
5. CHILEAN CONTEXT: Use "Jumbo" for premium host items, "Lider" for staples, and "Rappi" for urgent drinks.

CATALOG DATA (v5):
${JSON.stringify(catalog.items.slice(0, 200))}
`;

  const userPrompt = `
Generate a Blueprint for:
Event: ${formData.type}
Guests: ${formData.guestCount}
Budget: ${formData.budget} CLP
Vibe: ${formData.vibe}
Notes: ${formData.notes || "None"}

You MUST respond with valid JSON matching this structure:
{
  "summary": "One sentence expert summary",
  "timeline": [{"time": "HH:MM", "task": "description", "owner": "who"}],
  "supplies": {
    "food": [{"id": "item-id", "item": "Brand Name", "quantity": 0, "unit": "u/kg", "price": 0, "preferred_store": "storeId", "note": "why this choice"}],
    "drinks": [...],
    "equipment": [...]
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
  "tips": ["Expert insight 1", "Expert insight 2"],
  "risks": ["Specific risk for this event"]
}
`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o", // Using the most capable model for expert reasoning
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        response_format: { type: "json_object" }
      }),
    });

    const aiResult = await response.json();
    
    if (!response.ok) {
      throw new Error(aiResult.error?.message || "OpenAI API Error");
    }

    const blueprint = JSON.parse(aiResult.choices[0].message.content);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(blueprint),
    };
  } catch (error) {
    console.error("Function Error:", error);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Failed to generate expert blueprint", message: error.message }),
    };
  }
}
