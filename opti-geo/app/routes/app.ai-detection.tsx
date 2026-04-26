import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { runAiScraper } from "../lib/ai-detection/brightdata-scraper.server";
import { generateDetectionPrompt, generateNicheDetectionPrompts, extractNicheFromUrl } from "../lib/ai-detection/openrouter.server";
import { calcVisibilityScore, detectSentiment, findMentions } from "../lib/ai-detection/scoring";
import { PROVIDERS, type Provider, type VisibilityResult } from "../lib/ai-detection/types";

type ActionData = {
  error?: string;
  phase?: "generate" | "detect" | "niche_generate" | "extract_niche";
  url?: string;
  prompt?: string;
  niche?: string;
  nichePrompts?: string[];
  startedAt?: string;
  completedAt?: string;
  results?: VisibilityResult[];
  failedProviders?: Array<{ provider: Provider; error: string }>;
};

const PROVIDER_LABELS: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  copilot: "Copilot",
  gemini: "Gemini",
  google_ai: "Google AI",
  grok: "Grok",
};

function normalizeDomain(input: string): string {
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(withProtocol);
  return parsed.hostname.replace(/^www\./, "").toLowerCase();
}

function isValidUrl(input: string): boolean {
  try {
    const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const parsed = new URL(withProtocol);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const actionStartedAt = Date.now();
  await authenticate.admin(request);

  const formData = await request.formData();
  const phase = String(formData.get("phase") || "");
  const rawUrl = String(formData.get("url") || "").trim();

  console.log(`[ai-detection][action] start phase=${phase} rawUrl=${rawUrl}`);

  if (phase === "extract_niche") {
    if (!rawUrl) {
      console.error("[ai-detection][action] phase=extract_niche validation failed: URL is required");
      return { phase: "extract_niche", error: "URL is required" };
    }

    const normalizedUrlForNiche = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    if (!isValidUrl(rawUrl)) {
      console.error(`[ai-detection][action] phase=extract_niche validation failed: invalid URL rawUrl=${rawUrl}`);
      return { phase: "extract_niche", error: "Invalid URL format" };
    }

    try {
      console.log(`[ai-detection][action] phase=extract_niche start url=${normalizedUrlForNiche}`);
      const niche = await extractNicheFromUrl(normalizedUrlForNiche);
      console.log(`[ai-detection][action] phase=extract_niche success niche="${niche}" elapsed=${Date.now() - actionStartedAt}ms`);
      return {
        phase: "extract_niche",
        url: normalizedUrlForNiche,
        niche,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to extract niche";
      console.error(`[ai-detection][action] phase=extract_niche failed error=${message}`);
      return {
        phase: "extract_niche",
        url: rawUrl,
        error: message,
      };
    }
  }

  if (phase === "niche_generate") {
    const niche = String(formData.get("niche") || "").trim();
    if (!niche) {
      console.error("[ai-detection][action] phase=niche_generate validation failed: niche is required");
      return {
        phase: "niche_generate",
        error: "Niche is required",
      };
    }

    try {
      console.log(`[ai-detection][action] phase=niche_generate start niche="${niche}"`);
      const nichePrompts = await generateNicheDetectionPrompts(niche, 12);
      console.log(`[ai-detection][action] phase=niche_generate success count=${nichePrompts.length} elapsed=${Date.now() - actionStartedAt}ms`);
      return {
        phase: "niche_generate",
        nichePrompts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate niche prompts";
      console.error(`[ai-detection][action] phase=niche_generate failed error=${message}`);
      return {
        phase: "niche_generate",
        error: message,
      };
    }
  }

  const normalizedUrl = rawUrl
    ? (/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
    : "";

  if (phase === "generate") {
    if (!rawUrl) {
      console.error("[ai-detection][action] validation failed: URL is required for generate");
      return { phase: "generate", error: "URL is required" };
    }

    if (!isValidUrl(rawUrl)) {
      console.error(`[ai-detection][action] validation failed: invalid URL rawUrl=${rawUrl}`);
      return { phase: "generate", error: "Invalid URL format" };
    }

    try {
      console.log(`[ai-detection][action] phase=generate url=${normalizedUrl}`);
      const prompt = await generateDetectionPrompt(normalizedUrl);
      console.log(`[ai-detection][action] phase=generate success promptLen=${prompt.length} elapsed=${Date.now() - actionStartedAt}ms`);
      return {
        phase: "generate",
        url: normalizedUrl,
        prompt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate prompt";
      console.error(`[ai-detection][action] phase=generate failed error=${message}`);
      return {
        phase: "generate",
        url: normalizedUrl,
        error: message,
      };
    }
  }

  if (phase === "detect") {
    const prompt = String(formData.get("prompt") || "").trim();
    if (prompt.length < 5) {
      console.error(`[ai-detection][action] phase=detect validation failed promptLen=${prompt.length}`);
      return {
        phase: "detect",
        url: normalizedUrl || undefined,
        error: "Prompt is too short",
      };
    }

    const domain = rawUrl && isValidUrl(rawUrl)
      ? normalizeDomain(normalizedUrl)
      : "";
    const brandTerms = domain
      ? [domain.split(".")[0], domain].filter(Boolean)
      : [];
    const websiteDomains = domain ? [domain] : [];

    const startedAt = new Date().toISOString();
    console.log(`[ai-detection][action] phase=detect start url=${normalizedUrl || "(none)"} domain=${domain || "(none)"} promptLen=${prompt.length} providers=${PROVIDERS.length}`);

    const settled = await Promise.allSettled(
      PROVIDERS.map((provider) =>
        runAiScraper({
          provider,
          prompt,
          requireSources: true,
        }),
      ),
    );

    const results: VisibilityResult[] = [];
    const failedProviders: Array<{ provider: Provider; error: string }> = [];

    settled.forEach((entry, index) => {
      const provider = PROVIDERS[index];
      if (entry.status === "fulfilled") {
        const item = entry.value;
        const visibilityScore = calcVisibilityScore(
          item.answer,
          item.sources,
          brandTerms,
          websiteDomains,
        );
        const sentiment = detectSentiment(item.answer, brandTerms);
        const brandMentions = findMentions(item.answer, brandTerms);

        console.log(`[ai-detection][action] provider success provider=${provider} answerLen=${item.answer.length} sources=${item.sources.length} score=${visibilityScore} sentiment=${sentiment}`);

        results.push({
          ...item,
          visibilityScore,
          sentiment,
          brandMentions,
        });
      } else {
        const message = entry.reason instanceof Error ? entry.reason.message : "Unknown error";
        console.error(`[ai-detection][action] provider failed provider=${provider} error=${message}`);
        failedProviders.push({
          provider,
          error: message,
        });
      }
    });

    console.log(`[ai-detection][action] phase=detect done success=${results.length} failed=${failedProviders.length} elapsed=${Date.now() - actionStartedAt}ms`);

    return {
      phase: "detect",
      url: normalizedUrl || undefined,
      prompt,
      startedAt,
      completedAt: new Date().toISOString(),
      results,
      failedProviders,
      error: results.length === 0 ? "All providers failed" : undefined,
    };
  }

  console.error(`[ai-detection][action] invalid phase=${phase}`);
  return { error: "Invalid action phase" };
};


function sentimentColor(sentiment: VisibilityResult["sentiment"]) {
  if (sentiment === "positive") return "#10b981";
  if (sentiment === "negative") return "#ef4444";
  if (sentiment === "neutral") return "#f59e0b";
  return "#6b7280";
}

export default function AiDetectionPage() {
  const fetcher = useFetcher<ActionData>();

  const [niche, setNiche] = useState("");
  const [nichePrompts, setNichePrompts] = useState<string[]>([]);
  const [resultData, setResultData] = useState<ActionData | null>(null);

  const isSubmitting = fetcher.state === "submitting";
  const submitPhase = isSubmitting
    ? String(fetcher.formData?.get("phase") || "")
    : "";

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.phase === "extract_niche" && fetcher.data.niche) {
      setNiche(fetcher.data.niche);
      setNichePrompts([]);
      setResultData(null);
    }

    if (fetcher.data.phase === "niche_generate") {
      setNichePrompts(fetcher.data.nichePrompts ?? []);
      setResultData(null);
    }

    if (fetcher.data.phase === "detect") {
      setResultData(fetcher.data);
    }
  }, [fetcher.data]);

  const kpis = useMemo(() => {
    const rows = resultData?.results ?? [];
    if (rows.length === 0) {
      return {
        avgScore: 0,
        mentionedProviders: 0,
        positiveProviders: 0,
        totalSources: 0,
      };
    }

    const avgScore = Math.round(
      rows.reduce((sum, row) => sum + row.visibilityScore, 0) / rows.length,
    );
    const mentionedProviders = rows.filter((row) => row.brandMentions.length > 0).length;
    const positiveProviders = rows.filter((row) => row.sentiment === "positive").length;
    const totalSources = rows.reduce((sum, row) => sum + row.sources.length, 0);

    return {
      avgScore,
      mentionedProviders,
      positiveProviders,
      totalSources,
    };
  }, [resultData?.results]);

  const allSources = useMemo(() => {
    const rows = resultData?.results ?? [];
    return [...new Set(rows.flatMap((row) => row.sources))];
  }, [resultData?.results]);

  return (
    <s-page heading="AI 引擎检测看板">
      {/* ── Section: URL → niche → multiple prompts ───────────────── */}
      <s-section>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>
            输入网址，自动提炼品类，批量生成检测 Prompts
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="例如：台湾奶茶品牌、AI SEO 工具、B2B SaaS 营销软件（或直接输入网址自动提炼）"
              style={{
                flex: 1,
                padding: "10px 12px",
                fontSize: "0.875rem",
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
            <s-button
              onClick={() => {
                if (!niche.trim()) return;
                const fd = new FormData();
                fd.append("phase", "niche_generate");
                fd.append("niche", niche.trim());
                fetcher.submit(fd, { method: "POST" });
              }}
              {...(submitPhase === "niche_generate" ? { loading: true } : {})}
            >
              Generate Prompts
            </s-button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
            <span style={{ fontSize: 12, color: "#9ca3af" }}>或者</span>
            <div style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input
              type="text"
              id="niche-url-input"
              placeholder="输入网址，自动分析品类，例如 https://example.com"
              style={{
                flex: 1,
                padding: "10px 12px",
                fontSize: "0.875rem",
                border: "1px solid #d1d5db",
                borderRadius: 8,
              }}
            />
            <s-button
              onClick={() => {
                const input = document.getElementById("niche-url-input") as HTMLInputElement;
                const val = input?.value?.trim();
                if (!val) return;
                const fd = new FormData();
                fd.append("phase", "extract_niche");
                fd.append("url", val);
                fetcher.submit(fd, { method: "POST" });
              }}
              {...(submitPhase === "extract_niche" ? { loading: true } : {})}
            >
              从网址提炼品类
            </s-button>
          </div>

          {submitPhase === "extract_niche" && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #dbeafe", backgroundColor: "#eff6ff", color: "#1e40af", fontSize: "0.875rem" }}>
              正在抓取网页并分析品类，请稍候...
            </div>
          )}

          {fetcher.data?.phase === "extract_niche" && fetcher.data.error && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #fecaca", backgroundColor: "#fef2f2", color: "#991b1b", fontSize: "0.875rem" }}>
              {fetcher.data.error}
            </div>
          )}

          {fetcher.data?.phase === "extract_niche" && fetcher.data.niche && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #d1fae5", backgroundColor: "#ecfdf5", color: "#065f46", fontSize: "0.875rem" }}>
              已提炼品类：<strong>{fetcher.data.niche}</strong>（已填入上方输入框，可编辑后点击 Generate Prompts）
            </div>
          )}

          {fetcher.data?.phase === "niche_generate" && fetcher.data.error && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #fecaca", backgroundColor: "#fef2f2", color: "#991b1b", fontSize: "0.875rem" }}>
              {fetcher.data.error}
            </div>
          )}

          {nichePrompts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>
                生成了 {nichePrompts.length} 个检测 Prompt。点击任意一条可直接用于检测：
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {nichePrompts.map((q, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      background: "#f9fafb",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ flex: 1, color: "#111827" }}>{q}</span>
                    <s-button
                      onClick={() => {
                        const fd = new FormData();
                        fd.append("phase", "detect");
                        fd.append("prompt", q);
                        fetcher.submit(fd, { method: "POST" });
                      }}
                      {...(submitPhase === "detect" ? { loading: true } : {})}
                    >
                      Run
                    </s-button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </s-section>

      {/* ── Section 3: Detection status + results ────────────────────── */}
      <s-section>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {submitPhase === "detect" && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #dbeafe", backgroundColor: "#eff6ff", color: "#1e40af", fontSize: "0.875rem" }}>
              检测进行中，通常需要 30-60 秒，请稍候...
            </div>
          )}

          {(fetcher.data?.phase === "detect" && fetcher.data.error) && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #fecaca", backgroundColor: "#fef2f2", color: "#991b1b", fontSize: "0.875rem" }}>
              {fetcher.data.error}
            </div>
          )}

          {resultData?.error && !resultData.results?.length && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid #fecaca", backgroundColor: "#fef2f2", color: "#991b1b", fontSize: "0.875rem" }}>
              {resultData.error}
            </div>
          )}

          {resultData?.results && resultData.results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {resultData.prompt && (
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  检测 Prompt：<em style={{ color: "#111827" }}>{resultData.prompt}</em>
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                  gap: 12,
                }}
              >
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>平均可见性</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{kpis.avgScore}</div>
                </div>
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>提及引擎数</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{kpis.mentionedProviders}/6</div>
                </div>
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>正向情感</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{kpis.positiveProviders}</div>
                </div>
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>总来源数</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{kpis.totalSources}</div>
                </div>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                {resultData.results.map((row) => (
                  <div
                    key={row.provider}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 10,
                      background: "#fff",
                      padding: 14,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{PROVIDER_LABELS[row.provider]}</div>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "#6b7280" }}>
                          Score <strong style={{ color: "#111827" }}>{row.visibilityScore}</strong>
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "#f3f4f6",
                            color: sentimentColor(row.sentiment),
                            fontWeight: 600,
                          }}
                        >
                          {row.sentiment}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#6b7280" }}>
                      <span>Mentions: {row.brandMentions.length}</span>
                      <span>Sources: {row.sources.length}</span>
                      <span>{row.cached ? "Cached" : "Fresh"}</span>
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        color: "#111827",
                        lineHeight: 1.55,
                        whiteSpace: "pre-wrap",
                        background: "#f9fafb",
                        border: "1px solid #f3f4f6",
                        borderRadius: 8,
                        padding: 10,
                      }}
                    >
                      {row.answer.slice(0, 1200) || "(no answer text)"}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff", padding: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Sources</div>
                {allSources.length === 0 ? (
                  <div style={{ fontSize: 13, color: "#6b7280" }}>No sources extracted.</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
                    {allSources.map((source) => (
                      <li key={source} style={{ fontSize: 13 }}>
                        <a href={source} target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>
                          {source}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {resultData.failedProviders && resultData.failedProviders.length > 0 && (
                <div style={{ border: "1px solid #fde68a", borderRadius: 10, background: "#fffbeb", padding: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "#92400e" }}>
                    部分引擎失败
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
                    {resultData.failedProviders.map((item) => (
                      <li key={item.provider} style={{ fontSize: 13, color: "#78350f" }}>
                        {PROVIDER_LABELS[item.provider]}: {item.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
