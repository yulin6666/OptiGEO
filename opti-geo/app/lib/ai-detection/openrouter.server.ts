const promptCache = new Map<string, { expiresAt: number; text: string }>();
const nichePromptCache = new Map<string, { expiresAt: number; prompts: string[] }>();
const nicheCache = new Map<string, { expiresAt: number; niche: string }>();
const CACHE_TTL_MS = 1000 * 60 * 30;

/**
 * Generate a detection prompt for a URL by asking an LLM what a user
 * would type into an AI assistant when looking for the site's product or service.
 */
export async function generateDetectionPrompt(url: string): Promise<string> {
  const start = Date.now();
  console.log(`[ai-detection][openrouter] generate prompt start url=${url}`);

  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    console.error("[ai-detection][openrouter] missing OPENROUTER_KEY");
    throw new Error("Missing OPENROUTER_KEY");
  }

  const cacheKey = url;
  const cached = promptCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[ai-detection][openrouter] cache hit url=${url}`);
    return cached.text;
  }

  console.log(`[ai-detection][openrouter] cache miss url=${url}`);

  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // keep original
  }

  const userMessage = `You are an expert in AI search optimization (AEO/GEO).
Given a website URL, generate a single natural-language query that a user would type into an AI assistant (ChatGPT, Perplexity, Gemini, etc.) when looking for the product, service, or information offered by that website.

Rules:
- Write exactly ONE query sentence (no explanations, no quotation marks, no bullet points)
- The query should be information-seeking, not brand-specific (don't use the domain name)
- Make it sound like something a real user would ask
- Keep it under 15 words

Website: ${url}
Domain: ${domain}

Generate the detection query:`;

  const requestBody = {
    model: "moonshotai/kimi-k2.5",
    messages: [
      { role: "user", content: userMessage },
    ],
    max_tokens: 900,
    temperature: 0.2,
  };

  console.log("[ai-detection][openrouter] request -> https://openrouter.ai/api/v1/chat/completions");
  console.log(`[ai-detection][openrouter] request headers content-type=application/json auth=Bearer ${key.slice(0, 12)}...`);
  console.log(`[ai-detection][openrouter] request body=${JSON.stringify(requestBody)}`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[ai-detection][openrouter] failed status=${response.status} body=${text.slice(0, 300)}`);
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }

  console.log(`[ai-detection][openrouter] response ok status=${response.status}`);

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }> | null;
        reasoning?: string;
      };
    }>;
  };

  const msg = payload.choices?.[0]?.message;
  let text = "";
  if (typeof msg?.content === "string") {
    text = msg.content.trim();
  } else if (Array.isArray(msg?.content)) {
    text = msg.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }

  // reasoning model fallback: extract first non-empty line from reasoning field
  if (!text && typeof msg?.reasoning === "string" && msg.reasoning.trim()) {
    const lastLine = msg.reasoning.trim().split("\n").filter(Boolean).at(-1) ?? "";
    text = lastLine.trim();
    console.log(`[ai-detection][openrouter] content was null, fell back to last reasoning line: "${text}"`);
  }

  console.log(`[ai-detection][openrouter] response payload preview=${JSON.stringify(payload).slice(0, 500)}`);

  if (!text) {
    console.error("[ai-detection][openrouter] empty response content after parse");
    throw new Error("OpenRouter returned empty response");
  }

  console.log(`[ai-detection][openrouter] prompt generated len=${text.length} preview=${text.slice(0, 120)}`);

  promptCache.set(cacheKey, {
    text,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  console.log(`[ai-detection][openrouter] done in ${Date.now() - start}ms`);
  return text;
}

/**
 * Given a niche description, generate multiple natural-language queries
 * that users would type into AI assistants when exploring that niche.
 * Returns up to `count` queries (default 12).
 */
export async function generateNicheDetectionPrompts(
  niche: string,
  count = 12,
): Promise<string[]> {
  const start = Date.now();
  console.log(`[ai-detection][openrouter] generate niche prompts start niche="${niche}" count=${count}`);

  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    console.error("[ai-detection][openrouter] missing OPENROUTER_KEY");
    throw new Error("Missing OPENROUTER_KEY");
  }

  const cacheKey = `niche:${niche}:${count}`;
  const cached = nichePromptCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[ai-detection][openrouter] niche cache hit niche="${niche}"`);
    return cached.prompts;
  }

  console.log(`[ai-detection][openrouter] niche cache miss niche="${niche}"`);

  const userMessage = `Generate ${count} short search queries in English that people type into AI assistants (ChatGPT, Perplexity, etc.) when looking for: "${niche}"

Rules:
- Each query must be under 12 words
- Mix intents: "where to buy", "best", "recommend", "worth it", "reviews"
- Sound like real user questions, not marketing copy
- Do NOT include the brand name or domain

Return ONLY a JSON array of ${count} strings. No explanation, no markdown, no numbering. Example format:
["query one here", "query two here", "query three here"]`;

  const requestBody = {
    model: "moonshotai/kimi-k2.5",
    messages: [
      { role: "system", content: "You are a helpful assistant. Output ONLY the requested JSON. No reasoning, no explanation, no markdown." },
      { role: "user", content: userMessage },
    ],
    max_tokens: 8000,
    temperature: 0.4,
  };

  console.log("[ai-detection][openrouter] niche request -> https://openrouter.ai/api/v1/chat/completions");
  console.log(`[ai-detection][openrouter] niche request body=${JSON.stringify(requestBody)}`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[ai-detection][openrouter] niche failed status=${response.status} body=${text.slice(0, 300)}`);
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }

  console.log(`[ai-detection][openrouter] niche response ok status=${response.status}`);

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }> | null;
        reasoning?: string;
      };
    }>;
  };

  console.log(`[ai-detection][openrouter] niche response payload preview=${JSON.stringify(payload).slice(0, 500)}`);

  const msg = payload.choices?.[0]?.message;
  let rawText = "";
  if (typeof msg?.content === "string") {
    rawText = msg.content.trim();
  } else if (Array.isArray(msg?.content)) {
    rawText = msg.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  if (!rawText && typeof msg?.reasoning === "string" && msg.reasoning.trim()) {
    rawText = msg.reasoning.trim();
    console.log(`[ai-detection][openrouter] niche content was null, fell back to reasoning field`);
  }

  // For reasoning models, extract JSON payload from mixed reasoning text
  if (rawText.includes("{") || rawText.includes("[")) {
    const jsonObjectMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (jsonArrayMatch?.[0]) {
      rawText = jsonArrayMatch[0];
    } else if (jsonObjectMatch?.[0]) {
      rawText = jsonObjectMatch[0];
    }
  }

  if (!rawText) {
    console.error("[ai-detection][openrouter] niche empty response content after parse");
    throw new Error("OpenRouter returned empty response");
  }

  const prompts = parseNicheQueryList(rawText, count);
  console.log(`[ai-detection][openrouter] niche parsed queries count=${prompts.length} elapsed=${Date.now() - start}ms`);

  nichePromptCache.set(cacheKey, {
    prompts,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return prompts;
}

function parseNicheQueryList(raw: string, max: number): string[] {
  // Strip markdown fences
  const stripped = raw.replace(/```[\s\S]*?```/g, "").trim();

  const dedupeAndLimit = (items: string[]) => {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const item of items) {
      const q = item.replace(/^"+|"+$/g, "").replace(/\s+/g, " ").trim();
      if (!q) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(q);
      if (cleaned.length >= max) break;
    }
    return cleaned;
  };

  // Try JSON array first
  const jsonMatch = stripped.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) {
        const items = arr
          .map((item: unknown) => (typeof item === "string" ? item.trim() : ""))
          .filter((s: string) => s.length > 4 && s.length < 180);
        const parsed = dedupeAndLimit(items);
        if (parsed.length > 0) return fillFallbackQueries(parsed, max);
      }
    } catch {
      // fall through to line parsing
    }
  }

  // Line-by-line parsing fallback
  const fromLines = stripped
    .split("\n")
    .map((line) =>
      line
        .replace(/^[\s]*[-*•][\s]+/, "")
        .replace(/^[\s]*\d+[.)]\s+/, "")
        .replace(/^"+|"+$/g, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((line) => line.length > 4 && line.length < 180)
    .filter((line) => line.includes(" "))
    .filter((line) => !/^(here\s+(are|is)|sure|certainly|below|the following|output|example|note|rules?)\b/i.test(line))
    .filter((line) => !/^(each\s+query\s+must|mix\s+intents|sound\s+like|do\s+not\s+include|return\s+only)/i.test(line))
    .filter((line) => !/\b(json|array|numbering|markdown|brand name|domain|marketing copy|under\s+12\s+words)\b/i.test(line))
    .filter((line) => !/[:：]\s*"?(where to buy|best|recommend|worth it|reviews)"?/i.test(line));

  const parsed = dedupeAndLimit(fromLines);
  return fillFallbackQueries(parsed, max);
}

function fillFallbackQueries(existing: string[], max: number): string[] {
  if (existing.length >= max) return existing.slice(0, max);

  const fallback = [
    "where can I buy this online",
    "what are the best options in this category",
    "is this worth buying",
    "best product in this niche with reviews",
    "recommended brands in this category",
    "top rated options according to experts",
    "what should I look for before buying",
    "most trusted choices for this product type",
    "best value option in this niche",
    "which option has the best customer reviews",
    "what is the difference between top options",
    "where to buy with fast shipping",
  ];

  const result = [...existing];
  const seen = new Set(result.map((q) => q.toLowerCase()));
  for (const q of fallback) {
    if (result.length >= max) break;
    if (seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    result.push(q);
  }

  return result.slice(0, max);
}

/**
 * Extract website content (title, description, main text) for niche analysis.
 */
async function extractWebsiteContent(url: string): Promise<{
  title: string;
  description: string;
  content: string;
}> {
  const start = Date.now();
  console.log(`[ai-detection][openrouter] extract content start url=${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GEO-Bot/1.0)",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      console.error(`[ai-detection][openrouter] fetch failed status=${response.status}`);
      throw new Error(`Failed to fetch URL (${response.status})`);
    }

    const html = await response.text();
    console.log(`[ai-detection][openrouter] fetched html length=${html.length}`);

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || "";
    console.log(`[ai-detection][openrouter] extracted title="${title.slice(0, 100)}"`);

    // Extract meta description
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
    const description = descMatch?.[1]?.trim() || "";
    console.log(`[ai-detection][openrouter] extracted description="${description.slice(0, 100)}"`);

    // Extract main text content (strip HTML tags)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch?.[1] || html;

    // Remove script and style tags
    let cleanHtml = bodyHtml
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Take first 2000 characters
    const content = cleanHtml.slice(0, 2000);
    console.log(`[ai-detection][openrouter] extracted content length=${content.length} preview="${content.slice(0, 150)}"`);

    console.log(`[ai-detection][openrouter] extract content done elapsed=${Date.now() - start}ms`);

    return { title, description, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ai-detection][openrouter] extract content failed error=${message}`);
    throw new Error(`Failed to extract website content: ${message}`);
  }
}

/**
 * Extract niche from a URL by analyzing its content with an LLM.
 * Returns a concise niche description (1-2 sentences).
 */
export async function extractNicheFromUrl(url: string): Promise<string> {
  const start = Date.now();
  console.log(`[ai-detection][openrouter] extract niche start url=${url}`);

  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    console.error("[ai-detection][openrouter] missing OPENROUTER_KEY");
    throw new Error("Missing OPENROUTER_KEY");
  }

  // Check cache
  const cacheKey = `niche:${url}`;
  const cached = nicheCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[ai-detection][openrouter] niche cache hit url=${url}`);
    return cached.niche;
  }

  console.log(`[ai-detection][openrouter] niche cache miss url=${url}`);

  // Extract website content
  const { title, description, content } = await extractWebsiteContent(url);

  // Build prompt for LLM
  const userMessage = `Analyze this website and describe its business niche in ONE concise English sentence (under 100 characters).

Website: ${url}
Title: ${title}
Description: ${description}
Content: ${content.slice(0, 1000)}

Return ONLY a JSON object with a single "niche" field. No explanation, no markdown. Example format:
{"niche": "Premium Chinese loose leaf tea brand, direct-sourced from mountain farms"}`;

  const requestBody = {
    model: "moonshotai/kimi-k2.5",
    messages: [
      { role: "system", content: "You are a helpful assistant. Output ONLY the requested JSON. No reasoning, no explanation, no markdown." },
      { role: "user", content: userMessage },
    ],
    max_tokens: 8000,
    temperature: 0.3,
  };

  console.log("[ai-detection][openrouter] niche extraction request -> https://openrouter.ai/api/v1/chat/completions");
  console.log(`[ai-detection][openrouter] niche extraction request body preview=${JSON.stringify(requestBody).slice(0, 300)}...`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[ai-detection][openrouter] niche extraction failed status=${response.status} body=${text.slice(0, 300)}`);
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }

  console.log(`[ai-detection][openrouter] niche extraction response ok status=${response.status}`);

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }> | null;
        reasoning?: string;
      };
    }>;
  };

  console.log(`[ai-detection][openrouter] niche extraction response payload preview=${JSON.stringify(payload).slice(0, 500)}`);

  const msg = payload.choices?.[0]?.message;
  let rawText = "";
  if (typeof msg?.content === "string") {
    rawText = msg.content.trim();
  } else if (Array.isArray(msg?.content)) {
    rawText = msg.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }

  if (!rawText) {
    console.error("[ai-detection][openrouter] niche extraction empty response content");
    throw new Error("OpenRouter returned empty response");
  }

  // Try to parse JSON first
  let niche = "";
  const jsonMatch = rawText.match(/\{[\s\S]*"niche"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.niche === "string" && parsed.niche.trim()) {
        niche = parsed.niche.trim();
        console.log(`[ai-detection][openrouter] parsed niche from JSON: "${niche}"`);
      }
    } catch (e) {
      console.warn(`[ai-detection][openrouter] JSON parse failed, falling back to text extraction`);
    }
  }

  // Fallback: extract "niche statement" from free text/reasoning
  if (!niche) {
    const text = rawText.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
    const labelMatch = text.match(/niche\s*statement\s*[:：]\s*([^\n.]{20,220})/i);
    if (labelMatch?.[1]) {
      niche = labelMatch[1].trim();
      console.log(`[ai-detection][openrouter] extracted niche from niche-statement label: "${niche}"`);
    }
  }

  // Fallback: extract first reasonable sentence
  if (!niche) {
    const sentences = rawText
      .replace(/```[\s\S]*?```/g, "")
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20 && s.length <= 200);

    if (sentences.length > 0) {
      niche = sentences[0];
      console.log(`[ai-detection][openrouter] extracted niche from first sentence: "${niche}"`);
    }
  }

  if (!niche) {
    console.error("[ai-detection][openrouter] niche extraction failed to parse response");
    throw new Error("Failed to extract niche from response");
  }

  // Clean up
  niche = niche
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  console.log(`[ai-detection][openrouter] niche extracted len=${niche.length} text="${niche}"`);

  // Cache the result
  nicheCache.set(cacheKey, {
    niche,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  console.log(`[ai-detection][openrouter] extract niche done elapsed=${Date.now() - start}ms`);
  return niche;
}
