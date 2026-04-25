import type { Sentiment } from "./types";

/** Find which terms appear in text (case-insensitive) */
export function findMentions(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t.toLowerCase()));
}

/** Detect basic sentiment toward brand terms in an AI answer */
export function detectSentiment(
  answer: string,
  brandTerms: string[],
): Sentiment {
  if (brandTerms.length === 0) return "not-mentioned";
  const lower = answer.toLowerCase();
  const mentioned = brandTerms.some((t) => lower.includes(t.toLowerCase()));
  if (!mentioned) return "not-mentioned";

  const positiveWords = [
    "best", "leading", "top", "excellent", "recommend", "great", "outstanding",
    "innovative", "trusted", "powerful", "superior", "preferred", "popular",
    "reliable", "impressive", "standout", "strong", "ideal",
  ];
  const negativeWords = [
    "worst", "poor", "bad", "avoid", "lacking", "weak", "inferior",
    "disappointing", "overpriced", "limited", "outdated", "risky",
    "problematic", "concern", "drawback", "downside",
  ];

  let posScore = 0;
  let negScore = 0;
  positiveWords.forEach((w) => { if (lower.includes(w)) posScore++; });
  negativeWords.forEach((w) => { if (lower.includes(w)) negScore++; });

  if (posScore > negScore + 1) return "positive";
  if (negScore > posScore + 1) return "negative";
  return "neutral";
}

/**
 * Calculate 0-100 visibility score for a brand inside an AI answer.
 *
 * @param answer   - Full text of the AI response
 * @param sources  - Citation URLs returned by the AI engine
 * @param brandTerms - Brand names / aliases to look for
 * @param websiteDomains - Brand website domains (e.g. ["example.com"])
 */
export function calcVisibilityScore(
  answer: string,
  sources: string[],
  brandTerms: string[],
  websiteDomains: string[] = [],
): number {
  if (brandTerms.length === 0) return 0;
  const lower = answer.toLowerCase();
  let score = 0;

  // Brand mentioned at all? +30
  const mentioned = brandTerms.some((t) => lower.includes(t.toLowerCase()));
  if (!mentioned) return 0;
  score += 30;

  // Mentioned in first 200 chars (prominent position)? +20
  const first200 = lower.slice(0, 200);
  if (brandTerms.some((t) => first200.includes(t.toLowerCase()))) score += 20;

  // Multiple mentions? +15
  const mentionCount = brandTerms.reduce((acc, t) => {
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return acc + (lower.match(re)?.length ?? 0);
  }, 0);
  if (mentionCount >= 3) score += 15;
  else if (mentionCount >= 2) score += 8;

  // Brand website in sources? +20
  if (websiteDomains.length > 0 && sources.some((s) => {
    const sl = s.toLowerCase();
    return websiteDomains.some((d) => sl.includes(d));
  })) {
    score += 20;
  }

  // Positive sentiment bonus +15
  const sent = detectSentiment(answer, brandTerms);
  if (sent === "positive") score += 15;
  else if (sent === "neutral") score += 5;

  return Math.min(100, score);
}
