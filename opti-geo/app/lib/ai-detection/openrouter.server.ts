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

  const userMessage = `Generate ${count} short search queries in English for: "${niche}"

Requirements:
- Natural questions people type into ChatGPT
- Under 12 words each
- Mix: "where to buy", "what's best", "recommend", "worth it"
- Some add "with reviews" or "according to experts"

Examples:
"where can I buy good quality Chinese tea"
"what's the best high mountain tea brand"
"is loose leaf tea worth buying"

Output: Just the numbered list of ${count} queries.`;

  const requestBody = {
    model: "moonshotai/kimi-k2.5",
    messages: [{ role: "user", content: userMessage }],
    max_tokens: 1500,
    temperature: 0.2,
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

  // Try JSON array first
  const jsonMatch = stripped.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) {
        const items = arr
          .map((item: unknown) => (typeof item === "string" ? item.trim() : ""))
          .filter((s: string) => s.length > 10);
        if (items.length > 0) return items.slice(0, max);
      }
    } catch {
      // fall through to line parsing
    }
  }

  // Line-by-line parsing
  const fromLines = stripped
    .split("\n")
    .map((line) =>
      line
        .replace(/^[\s]*[-*•][\s]+/, "")
        .replace(/^[\s]*\d+[.)]\s+/, "")
        .replace(/^["']+|["']+$/g, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((line) => line.length > 10 && line.length < 300)
    .filter((line) => !/^(here\s+(are|is)|high[- ]intent|sure|certainly|below|the following|key requirements|short and simple|casual|everyday|mix of styles|some mention|numbered list|all in english|the target|good examples|output)\b/i.test(line))
    .filter((line) => line.includes(" "))
    .filter((line) => {
      // Filter out lines that look like instructions rather than queries
      const instructionPatterns = [
        /^(most under|use |mix |some |make them|keep |no fancy|generate)/i,
        /\b(language|jargon|keywords|sources|examples|requirements)\b/i,
      ];
      return !instructionPatterns.some(pattern => pattern.test(line));
    });

  return fromLines.slice(0, max);
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

  // Build prompt for LLM - keep it concise for reasoning model
  const userMessage = `Analyze this website and describe its business niche in 1-2 short English sentences.

Website: ${url}
Title: ${title}
Description: ${description}
Content: ${content.slice(0, 1000)}

Output: A concise niche statement in English (under 100 characters).
Example: "Premium Chinese loose leaf tea brand, direct-sourced from mountain farms, sold online in the US"

Generate the niche statement:`;

  const requestBody = {
    model: "moonshotai/kimi-k2.5",
    messages: [{ role: "user", content: userMessage }],
    max_tokens: 1500,
    temperature: 0.2,
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
  let niche = "";
  if (typeof msg?.content === "string") {
    niche = msg.content.trim();
  } else if (Array.isArray(msg?.content)) {
    niche = msg.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }

  // Fallback to reasoning field
  if (!niche && typeof msg?.reasoning === "string" && msg.reasoning.trim()) {
    const reasoning = msg.reasoning.trim();
    console.log(`[ai-detection][openrouter] niche content was null, parsing reasoning field length=${reasoning.length}`);

    // Try to extract the final answer from reasoning
    // Look for sentences that look like niche descriptions (contain key business words)
    const lines = reasoning.split("\n").filter(Boolean);
    const businessKeywords = /\b(brand|company|business|service|product|platform|marketplace|store|shop|sell|offer|provide|specialize)\b/i;

    // Find lines that contain business keywords and are reasonable length
    const candidates = lines.filter(line => {
      const trimmed = line.trim();
      return businessKeywords.test(trimmed) && trimmed.length >= 20 && trimmed.length <= 200;
    });

    if (candidates.length > 0) {
      // Take the last matching line (likely the final answer)
      niche = candidates[candidates.length - 1].trim();
      console.log(`[ai-detection][openrouter] extracted niche from reasoning: "${niche}"`);
    } else {
      // Fallback to last non-empty line
      const lastLine = lines[lines.length - 1] || "";
      niche = lastLine.trim();
      console.log(`[ai-detection][openrouter] fell back to last reasoning line: "${niche}"`);
    }
  }

  if (!niche) {
    console.error("[ai-detection][openrouter] niche extraction empty response content after parse");
    throw new Error("OpenRouter returned empty response");
  }

  // Clean up the niche text (remove quotes, extra whitespace)
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
