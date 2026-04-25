const promptCache = new Map<string, { expiresAt: number; text: string }>();
const nichePromptCache = new Map<string, { expiresAt: number; prompts: string[] }>();
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

  const userMessage = `You are an expert in AI search optimization (AEO/GEO).
Generate exactly ${count} high-intent search queries that a buyer or researcher would type into an AI assistant (ChatGPT, Perplexity, Gemini) when exploring this niche: "${niche}".

Requirements:
- Each query should be realistic and conversational
- Include source-seeking phrasing like "with sources", "according to experts", etc.
- Mix informational, comparison, and decision-stage queries
- Return ONLY a numbered list, one query per line, no explanations`;

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
    .filter((line) => !/^(here\s+(are|is)|high[- ]intent|sure|certainly|below|the following)\b/i.test(line))
    .filter((line) => line.includes(" "));

  return fromLines.slice(0, max);
}
