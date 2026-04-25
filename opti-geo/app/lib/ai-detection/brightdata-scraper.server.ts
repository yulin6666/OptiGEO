import { isProvider, type NormalizedScrapeResult, type Provider } from "./types";

const OUTPUT_CACHE_TTL_MS = 1000 * 60 * 20;

const inMemoryCache = new Map<
  string,
  { expiresAt: number; value: NormalizedScrapeResult }
>();

const providerToDatasetEnv: Record<Provider, string> = {
  chatgpt: "BRIGHT_DATA_DATASET_CHATGPT",
  perplexity: "BRIGHT_DATA_DATASET_PERPLEXITY",
  copilot: "BRIGHT_DATA_DATASET_COPILOT",
  gemini: "BRIGHT_DATA_DATASET_GEMINI",
  google_ai: "BRIGHT_DATA_DATASET_GOOGLE_AI",
  grok: "BRIGHT_DATA_DATASET_GROK",
};

const providerBaseUrl: Record<Provider, string> = {
  chatgpt: "https://chatgpt.com/",
  perplexity: "https://www.perplexity.ai/",
  copilot: "https://copilot.microsoft.com/",
  gemini: "https://gemini.google.com/",
  google_ai: "https://www.google.com/",
  grok: "https://grok.com/",
};

export type ScrapeRequest = {
  provider: Provider;
  prompt: string;
  requireSources?: boolean;
  country?: string;
};

function getApiKey() {
  return process.env.BRIGHT_DATA_KEY;
}

function getDatasetId(provider: Provider) {
  return process.env[providerToDatasetEnv[provider]];
}

function buildCacheKey(input: ScrapeRequest) {
  return JSON.stringify(input);
}

function withAuthHeaders() {
  const key = getApiKey();
  if (!key) {
    throw new Error("Missing BRIGHT_DATA_KEY");
  }

  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function stripAnswerHtml(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnswerHtml(entry));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(obj)) {
      if (key.toLowerCase() === "answer_html") {
        continue;
      }
      cleaned[key] = stripAnswerHtml(entry);
    }

    return cleaned;
  }

  return value;
}

function extractSourcesFromAnswer(answer: string) {
  const found = new Set<string>();

  const blockedHostFragments = [
    "chatgpt.com",
    "openai.com",
    "oaiusercontent.com",
    "perplexity.ai",
    "pplx.ai",
    "copilot.microsoft.com",
    "grok.com",
    "x.ai",
    "gemini.google.com",
    "bard.google.com",
    "google.com/ai",
    "cloudfront.net",
    "cdn.prod.website-files.com",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "unpkg.com",
    "fastly.net",
    "akamaihd.net",
    "cloudflare.com",
    "amazonaws.com",
    "connect.facebook.net",
    "facebook.net",
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "hotjar.com",
    "segment.io",
    "segment.com",
    "mixpanel.com",
    "amplitude.com",
    "sentry.io",
    "w3.org",
    "schema.org",
    "xmlns.com",
  ];

  const assetPathPattern = /\.(js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|mp3)(\?|$)/i;

  const junkPathFragments = [
    "/signals/",
    "/pixel",
    "/tracking",
    "/beacon",
    "/analytics",
    "/__",
    "/wp-content/uploads/",
    "/wp-includes/",
  ];

  const isThirdPartyCitation = (urlValue: string) => {
    try {
      const parsed = new URL(urlValue);
      const host = parsed.hostname.toLowerCase();
      const full = `${host}${parsed.pathname}`.toLowerCase();

      if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
        return false;
      }

      if (blockedHostFragments.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
        return false;
      }

      if (assetPathPattern.test(parsed.pathname)) {
        return false;
      }

      if (junkPathFragments.some((frag) => full.includes(frag))) {
        return false;
      }

      if (
        parsed.pathname.includes("/_spa/") ||
        parsed.pathname.includes("/assets/") ||
        full.includes("static")
      ) {
        return false;
      }

      if (parsed.search.length > 200) {
        return false;
      }

      if (host === "" || host === "localhost") {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  };

  const normalize = (urlValue: string) => {
    try {
      const parsed = new URL(urlValue);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return urlValue;
    }
  };

  const plainUrls = answer.match(/https?:\/\/[^\s)\]}"']+/g) ?? [];
  plainUrls
    .map((entry) => entry.replace(/[),.;:!?]+$/, ""))
    .filter(isThirdPartyCitation)
    .map(normalize)
    .forEach((entry) => found.add(entry));

  const markdownLinks = answer.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g) ?? [];
  markdownLinks.forEach((entry) => {
    const urlMatch = entry.match(/\((https?:\/\/[^)]+)\)/);
    if (!urlMatch?.[1]) return;
    const candidate = urlMatch[1].replace(/[),.;:!?]+$/, "");
    if (isThirdPartyCitation(candidate)) {
      found.add(normalize(candidate));
    }
  });

  return [...found];
}

function normalizeAnswer(rawRecord: Record<string, unknown>) {
  const answerCandidates = [
    rawRecord.answer_text,
    rawRecord.answer_text_markdown,
    rawRecord.answer,
    rawRecord.response_raw,
    rawRecord.response,
    rawRecord.output,
    rawRecord.result,
    rawRecord.text,
    rawRecord.content,
  ];

  for (const item of answerCandidates) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }

  function extractDeepText(obj: unknown, depth: number): string | null {
    if (depth > 3) return null;
    if (typeof obj === "string" && obj.trim().length > 20) return obj.trim();
    if (Array.isArray(obj)) {
      for (const entry of obj) {
        const found = extractDeepText(entry, depth + 1);
        if (found) return found;
      }
    }
    if (obj && typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      for (const key of ["answer_text", "answer_text_markdown", "answer", "response_raw", "response", "output", "result", "text", "content", "message", "body", "summary", "description"]) {
        if (typeof record[key] === "string" && (record[key] as string).trim().length > 20) {
          return (record[key] as string).trim();
        }
      }
      for (const val of Object.values(record)) {
        const found = extractDeepText(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const deepText = extractDeepText(rawRecord, 0);
  if (deepText) return deepText;

  const raw = JSON.stringify(rawRecord);
  if (raw.length < 500) return raw;
  return raw
    .replace(/[{}\[\]"]/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2000);
}

async function monitorUntilReady(snapshotId: string) {
  const maxAttempts = 60;
  const BASE_DELAY = 2000;
  const MAX_DELAY = 10000;
  let elapsed = 0;

  console.log(`[ai-detection][brightdata] polling snapshot=${snapshotId} maxAttempts=${maxAttempts}`);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const monitorRes = await fetch(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotId}`,
      {
        method: "GET",
        headers: withAuthHeaders(),
      },
    );

    if (!monitorRes.ok) {
      console.error(`[ai-detection][brightdata] poll failed snapshot=${snapshotId} status=${monitorRes.status}`);
      throw new Error(`Monitor failed (${monitorRes.status})`);
    }

    const monitorJson = (await monitorRes.json()) as {
      status: "starting" | "running" | "ready" | "failed";
    };

    console.log(`[ai-detection][brightdata] poll attempt=${attempt + 1} snapshot=${snapshotId} status=${monitorJson.status} elapsed=${elapsed}ms`);

    if (monitorJson.status === "ready") {
      console.log(`[ai-detection][brightdata] snapshot ready snapshot=${snapshotId} totalElapsed=${elapsed}ms`);
      return;
    }

    if (monitorJson.status === "failed") {
      console.error(`[ai-detection][brightdata] snapshot failed snapshot=${snapshotId}`);
      throw new Error("Snapshot failed");
    }

    const delay = Math.min(BASE_DELAY * Math.pow(2, Math.floor(attempt / 5)), MAX_DELAY);
    elapsed += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(
    `Timed out after ~${Math.round(elapsed / 1000)}s waiting for snapshot ${snapshotId}`,
  );
}

async function downloadSnapshot(snapshotId: string) {
  console.log(`[ai-detection][brightdata] download snapshot start snapshot=${snapshotId}`);

  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
    {
      method: "GET",
      headers: withAuthHeaders(),
    },
  );

  if (!response.ok) {
    console.error(`[ai-detection][brightdata] download snapshot failed snapshot=${snapshotId} status=${response.status}`);
    throw new Error(`Download failed (${response.status})`);
  }

  const json = await response.json();
  const size = Array.isArray(json) ? json.length : 1;
  console.log(`[ai-detection][brightdata] download snapshot ok snapshot=${snapshotId} records=${size}`);
  return json;
}

export async function runAiScraper(
  request: ScrapeRequest,
): Promise<NormalizedScrapeResult> {
  const startedAt = Date.now();
  console.log(`[ai-detection][brightdata] run start provider=${request.provider} promptLen=${request.prompt.length}`);

  if (!isProvider(request.provider)) {
    console.error(`[ai-detection][brightdata] invalid provider provider=${request.provider}`);
    throw new Error(`Invalid provider: ${request.provider}`);
  }

  const parsed = request.provider;
  const datasetId = getDatasetId(parsed);

  if (!datasetId) {
    console.error(`[ai-detection][brightdata] missing dataset provider=${parsed} env=${providerToDatasetEnv[parsed]}`);
    throw new Error(
      `Missing dataset id for provider ${parsed}. Expected env: ${providerToDatasetEnv[parsed]}`,
    );
  }

  const cacheKey = buildCacheKey(request);
  const cacheHit = inMemoryCache.get(cacheKey);
  if (cacheHit && cacheHit.expiresAt > Date.now()) {
    console.log(`[ai-detection][brightdata] cache hit provider=${parsed}`);
    return {
      ...cacheHit.value,
      cached: true,
    };
  }

  console.log(`[ai-detection][brightdata] cache miss provider=${parsed}`);

  const inputRecord: Record<string, unknown> = {
    url: providerBaseUrl[parsed],
    prompt: request.prompt,
    index: 1,
  };

  if (request.country) {
    inputRecord.geolocation = request.country;
  }

  console.log(`[ai-detection][brightdata] scrape request provider=${parsed} dataset=${datasetId}`);

  const scrapeResponse = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${datasetId}&notify=false&include_errors=true&format=json`,
    {
      method: "POST",
      headers: withAuthHeaders(),
      body: JSON.stringify({ input: [inputRecord] }),
    },
  );

  let payload: unknown;

  if (scrapeResponse.status === 202) {
    const pending = (await scrapeResponse.json()) as {
      snapshot_id: string;
    };
    console.log(`[ai-detection][brightdata] scrape accepted provider=${parsed} snapshot=${pending.snapshot_id}`);
    await monitorUntilReady(pending.snapshot_id);
    payload = await downloadSnapshot(pending.snapshot_id);
  } else {
    if (!scrapeResponse.ok) {
      const text = await scrapeResponse.text();
      console.error(`[ai-detection][brightdata] scrape failed provider=${parsed} status=${scrapeResponse.status} body=${text.slice(0, 300)}`);
      throw new Error(`Scrape failed (${scrapeResponse.status}): ${text}`);
    }
    console.log(`[ai-detection][brightdata] scrape immediate response provider=${parsed} status=${scrapeResponse.status}`);
    payload = await scrapeResponse.json();
  }

  const rawFirst = Array.isArray(payload)
    ? (payload as Record<string, unknown>[])[0]
    : (payload as Record<string, unknown>);
  const rawRecord = (rawFirst ?? {}) as Record<string, unknown>;

  const sanitizedPayload = stripAnswerHtml(payload);
  const sanitizedFirst = Array.isArray(sanitizedPayload)
    ? sanitizedPayload[0]
    : (sanitizedPayload as Record<string, unknown>);
  const record = (sanitizedFirst ?? {}) as Record<string, unknown>;
  const answer = normalizeAnswer(record);

  const textSources = extractSourcesFromAnswer(answer);

  const structuredSources: string[] = [];
  for (const field of ["citations", "links_attached", "sources"]) {
    const arr = rawRecord[field];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string" && item.startsWith("http")) {
          structuredSources.push(item);
        } else if (item && typeof item === "object") {
          const url = (item as Record<string, unknown>).url;
          if (typeof url === "string" && url.startsWith("http")) {
            structuredSources.push(url);
          }
        }
      }
    }
  }

  const allSources = [...new Set([...textSources, ...structuredSources])];

  const normalized: NormalizedScrapeResult = {
    provider: parsed,
    prompt: request.prompt,
    answer,
    sources: allSources,
    snapshotId:
      typeof record.snapshot_id === "string" ? record.snapshot_id : undefined,
    cached: false,
    raw: sanitizedPayload,
    createdAt: new Date().toISOString(),
  };

  console.log(
    `[ai-detection][brightdata] run done provider=${parsed} answerLen=${answer.length} sources=${allSources.length} elapsed=${Date.now() - startedAt}ms`,
  );

  inMemoryCache.set(cacheKey, {
    expiresAt: Date.now() + OUTPUT_CACHE_TTL_MS,
    value: normalized,
  });

  return normalized;
}
