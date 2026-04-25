export const PROVIDERS = [
  "chatgpt",
  "perplexity",
  "copilot",
  "gemini",
  "google_ai",
  "grok",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export type Sentiment = "positive" | "neutral" | "negative" | "not-mentioned";

export type NormalizedScrapeResult = {
  provider: Provider;
  prompt: string;
  answer: string;
  sources: string[];
  snapshotId?: string;
  cached: boolean;
  raw: unknown;
  createdAt: string;
};

export type VisibilityResult = NormalizedScrapeResult & {
  visibilityScore: number;
  sentiment: Sentiment;
  brandMentions: string[];
};

export function isProvider(value: string): value is Provider {
  return PROVIDERS.includes(value as Provider);
}
