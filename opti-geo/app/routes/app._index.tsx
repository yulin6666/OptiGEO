import { useState, useEffect, useMemo } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import FirecrawlApp from "@mendable/firecrawl-js";
import prisma from "../db.server";
import { runAiScraper } from "../lib/ai-detection/brightdata-scraper.server";
import { generateNicheDetectionPrompts, extractNicheFromUrl } from "../lib/ai-detection/openrouter.server";
import { calcVisibilityScore, detectSentiment, findMentions } from "../lib/ai-detection/scoring";
import { PROVIDERS, type Provider, type VisibilityResult } from "../lib/ai-detection/types";

// ── Types ──────────────────────────────────────────────────────────────────

type CheckCategory = "discovery" | "structure" | "content" | "technical" | "rendering";

type Check = {
  id: string;
  label: string;
  category: CheckCategory;
  pass: boolean;
  value: string;
  detail: string;
};

type AuditResult = {
  url: string;
  score: number;
  checks: Check[];
  error?: string;
};

type ActionData = {
  actionType?: string;
  error?: string;
  url?: string;
  score?: number;
  checks?: Check[];
  prompt?: string;
  niche?: string;
  nichePrompts?: string[];
  results?: VisibilityResult[];
  avgScore?: number;
  failedProviders?: Array<{ provider: Provider; error: string }>;
  success?: boolean;
  llmsTxt?: string;
  llmsFullTxt?: string;
  // detect_started
  taskId?: string;
  providerTotal?: number;
  // poll_task
  task?: DetectionTask;
};

type DetectionRun = {
  id: string;
  prompt: string;
  url?: string;
  avgScore: number;
  results: VisibilityResult[];
  failedProviders: Array<{ provider: Provider; error: string }>;
  providerTotal: number;
  createdAt: number;
};

type DetectionTask = {
  status: "running" | "done" | "error";
  prompt: string;
  url?: string;
  providerTotal: number;
  completedProviders: number;
  results?: VisibilityResult[];
  avgScore?: number;
  failedProviders: Array<{ provider: Provider; error: string }>;
  error?: string;
  createdAt: number;
};

const detectionTaskMap = new Map<string, DetectionTask>();

const PROVIDER_LABELS: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  copilot: "Copilot",
  gemini: "Gemini",
  google_ai: "Google AI",
  grok: "Grok",
};

const CATEGORY_META: Record<CheckCategory, { label: string; icon: string; color: string }> = {
  discovery: { label: "Discovery", icon: "🔍", color: "#3b82f6" },
  structure: { label: "Structure & Schema", icon: "🏗️", color: "#8b5cf6" },
  content: { label: "Content Quality", icon: "📝", color: "#10b981" },
  technical: { label: "Technical", icon: "⚙️", color: "#f59e0b" },
  rendering: { label: "Server-Side Rendering", icon: "🖥️", color: "#ec4899" },
};

// ── Audit helpers ──────────────────────────────────────────────────────────

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function tryFetch(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GEO-AEO-Tracker/1.0" },
      redirect: "follow",
    });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, text, status: res.status };
  } catch {
    return { ok: false, text: "", status: 0 };
  }
}

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

async function runAudit(url: string): Promise<AuditResult> {
  const target = new URL(url);
  const checks: Check[] = [];

  const pageRes = await tryFetch(url);
  if (!pageRes.ok) {
    throw new Error(`Unable to fetch page (${pageRes.status})`);
  }
  const html = pageRes.text;
  const plain = stripHtml(html);

  const [llmsRes, llmsFullRes, robotsRes, sitemapRes] = await Promise.all([
    tryFetch(`${target.origin}/llms.txt`),
    tryFetch(`${target.origin}/llms-full.txt`),
    tryFetch(`${target.origin}/robots.txt`),
    tryFetch(`${target.origin}/sitemap.xml`),
  ]);

  checks.push({
    id: "llms_txt", label: "llms.txt", category: "discovery",
    pass: llmsRes.ok,
    value: llmsRes.ok ? "Present" : "Missing",
    detail: llmsRes.ok
      ? `Found at ${target.origin}/llms.txt (${llmsRes.text.length} bytes)`
      : "No llms.txt file found. This file tells AI models about your site's purpose and preferred content.",
  });

  checks.push({
    id: "llms_full_txt", label: "llms-full.txt", category: "discovery",
    pass: llmsFullRes.ok,
    value: llmsFullRes.ok ? "Present" : "Missing",
    detail: llmsFullRes.ok
      ? `Found at ${target.origin}/llms-full.txt (${llmsFullRes.text.length} bytes)`
      : "No llms-full.txt found. This extended file provides detailed context for AI models.",
  });

  const aiBots = ["gptbot", "chatgpt-user", "claudebot", "anthropic-ai", "google-extended", "googleother", "cohere-ai", "bytespider", "perplexitybot", "ccbot"];
  const blockedBots: string[] = [];
  const allowedBots: string[] = [];
  if (robotsRes.ok) {
    for (const bot of aiBots) {
      const botPattern = new RegExp(`user-agent:\\s*${bot}[\\s\\S]*?disallow:\\s*/`, "i");
      if (botPattern.test(robotsRes.text)) blockedBots.push(bot);
      else allowedBots.push(bot);
    }
  }
  const botAccessOk = robotsRes.ok && blockedBots.length <= 2;
  checks.push({
    id: "robots_ai_access", label: "AI Bot Access (robots.txt)", category: "discovery",
    pass: botAccessOk,
    value: robotsRes.ok ? `${blockedBots.length} blocked / ${aiBots.length} checked` : "No robots.txt",
    detail: robotsRes.ok
      ? blockedBots.length > 0
        ? `Blocked: ${blockedBots.join(", ")}. Allowed: ${allowedBots.slice(0, 5).join(", ")}${allowedBots.length > 5 ? "..." : ""}`
        : "All major AI bots are allowed to crawl."
      : "No robots.txt found — AI bots will default to crawling all pages.",
  });

  const hasSitemap = sitemapRes.ok && (sitemapRes.text.includes("<url") || sitemapRes.text.includes("<sitemap"));
  const sitemapUrlCount = (sitemapRes.text.match(/<url>/gi) ?? []).length;
  const sitemapIndexCount = (sitemapRes.text.match(/<sitemap>/gi) ?? []).length;
  const displayCount = sitemapUrlCount > 0 ? sitemapUrlCount : sitemapIndexCount;
  const displayType = sitemapUrlCount > 0 ? "URLs" : "sitemaps";
  checks.push({
    id: "sitemap", label: "XML Sitemap", category: "discovery",
    pass: hasSitemap,
    value: hasSitemap ? `${displayCount} ${displayType}` : "Missing",
    detail: hasSitemap
      ? sitemapUrlCount > 0 ? `Sitemap found with ${sitemapUrlCount} URL entries.` : `Sitemap index found with ${sitemapIndexCount} sub-sitemaps.`
      : "No sitemap.xml found. A sitemap helps AI systems discover and index your pages.",
  });

  const jsonLdBlocks = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const schemaTypes: string[] = [];
  for (const block of jsonLdBlocks) {
    const inner = block.replace(/<script[^>]*>|<\/script>/gi, "");
    try {
      const parsed = JSON.parse(inner);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item?.["@type"]) {
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          schemaTypes.push(...types);
        }
      }
    } catch { /* skip */ }
  }
  checks.push({
    id: "json_ld", label: "JSON-LD Structured Data", category: "structure",
    pass: jsonLdBlocks.length > 0,
    value: jsonLdBlocks.length > 0 ? `${jsonLdBlocks.length} blocks (${schemaTypes.length} types)` : "None found",
    detail: schemaTypes.length > 0
      ? `Schema types: ${[...new Set(schemaTypes)].join(", ")}`
      : "No JSON-LD structured data found. Add Organization, Product, FAQPage, or Article schema.",
  });

  const hasFaqSchema = schemaTypes.some((t) => /faq/i.test(t));
  const hasFaqHtml = /<details|<summary|class="faq"|id="faq"|class="accordion"/i.test(html);
  checks.push({
    id: "faq_schema", label: "FAQ / Q&A Schema", category: "structure",
    pass: hasFaqSchema || hasFaqHtml,
    value: hasFaqSchema ? "Schema present" : hasFaqHtml ? "HTML only (no schema)" : "Missing",
    detail: hasFaqSchema
      ? "FAQPage schema found — AI models can extract Q&A pairs."
      : hasFaqHtml
        ? "FAQ-like HTML elements found but no FAQPage schema markup. Add JSON-LD FAQPage schema."
        : "No FAQ content or schema detected. FAQ schema dramatically improves AI answer citations.",
  });

  const ogTags = html.match(/<meta[^>]*property=["']og:[^"']*["'][^>]*>/gi) ?? [];
  const ogTitle = /og:title/i.test(html);
  const ogDesc = /og:description/i.test(html);
  const ogImage = /og:image/i.test(html);
  const ogComplete = ogTitle && ogDesc && ogImage;
  checks.push({
    id: "open_graph", label: "Open Graph Tags", category: "structure",
    pass: ogComplete,
    value: `${ogTags.length} tags${ogComplete ? " (complete)" : ""}`,
    detail: ogComplete
      ? "og:title, og:description, and og:image all present."
      : `Missing: ${[!ogTitle && "og:title", !ogDesc && "og:description", !ogImage && "og:image"].filter(Boolean).join(", ")}. OG tags help AI tools preview and cite your content.`,
  });

  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const metaDesc = metaDescMatch?.[1] ?? "";
  const metaDescOk = metaDesc.length >= 50 && metaDesc.length <= 300;
  checks.push({
    id: "meta_description", label: "Meta Description", category: "structure",
    pass: metaDescOk,
    value: metaDesc ? `${metaDesc.length} chars` : "Missing",
    detail: metaDesc
      ? metaDescOk
        ? `Good length (${metaDesc.length} chars): "${metaDesc.slice(0, 100)}..."`
        : `Length ${metaDesc.length} chars — ${metaDesc.length < 50 ? "too short" : "too long"}. Aim for 50–160 characters.`
      : "No meta description found. AI tools use this as a content summary.",
  });

  const hasCanonical = /<link[^>]*rel=["']canonical["']/i.test(html);
  checks.push({
    id: "canonical", label: "Canonical Tag", category: "structure",
    pass: hasCanonical,
    value: hasCanonical ? "Present" : "Missing",
    detail: hasCanonical
      ? "Canonical tag found — helps prevent duplicate content issues."
      : "No canonical tag. Add one to ensure AI models reference the correct URL.",
  });

  const firstChunkLen = Math.max(plain.length * 0.2, 400);
  const firstChunk = plain.slice(0, Math.floor(firstChunkLen));
  const bulletCount = (html.match(/<li\b/gi) ?? []).length;
  const hasDirectAnswer = /\b(in short|tl;dr|summary|key takeaways|bottom line|the answer is|here('?s| is) (what|how|why))\b/i.test(firstChunk);
  const blufScore = Math.min(1, (Number(hasDirectAnswer) + Number(bulletCount > 3) + Number(firstChunk.length > 100)) / 2);
  checks.push({
    id: "bluf_style", label: "BLUF / Direct-Answer Style", category: "content",
    pass: blufScore >= 0.5,
    value: `${Math.round(blufScore * 100)}%`,
    detail: hasDirectAnswer
      ? "Content leads with a direct answer — good for AI citation."
      : "Content doesn't lead with a clear direct answer. Start with a BLUF (Bottom Line Up Front) statement.",
  });

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
  const h3Count = (html.match(/<h3[\s>]/gi) ?? []).length;
  const headingOk = h1Count === 1 && h2Count >= 2;
  checks.push({
    id: "heading_hierarchy", label: "Heading Hierarchy", category: "content",
    pass: headingOk,
    value: `H1:${h1Count} H2:${h2Count} H3:${h3Count}`,
    detail: h1Count === 0
      ? "No H1 tag found. Every page should have exactly one H1."
      : h1Count > 1
        ? `${h1Count} H1 tags found — use exactly one. AI models use H1 as primary topic signal.`
        : h2Count < 2
          ? "Only 1 H2 or none. Use H2 subheadings to break content into scannable sections."
          : "Good heading hierarchy — single H1 with multiple H2/H3 subheadings.",
  });

  const wordCount = plain.split(/\s+/).filter(Boolean).length;
  const contentLengthOk = wordCount >= 300;
  checks.push({
    id: "content_length", label: "Content Depth", category: "content",
    pass: contentLengthOk,
    value: `${wordCount.toLocaleString()} words`,
    detail: contentLengthOk
      ? wordCount > 2000 ? "Comprehensive content — great for in-depth AI citations." : "Adequate content length for AI answer extraction."
      : "Thin content — AI models prefer pages with 300+ words for citation. Add more substance.",
  });

  const internalLinkPattern = new RegExp(`<a[^>]*href=["'](?:https?://(?:www\\.)?${target.hostname.replace(/\./g, "\\.")})?/[^"']*["']`, "gi");
  const internalLinks = (html.match(internalLinkPattern) ?? []).length;
  const internalLinkOk = internalLinks >= 3;
  checks.push({
    id: "internal_links", label: "Internal Links", category: "content",
    pass: internalLinkOk,
    value: `${internalLinks} links`,
    detail: internalLinkOk
      ? "Good internal linking — helps AI models discover related content."
      : "Few internal links. Add 3+ contextual internal links to help AI models map your content.",
  });

  const isHttps = target.protocol === "https:";
  checks.push({
    id: "https", label: "HTTPS", category: "technical",
    pass: isHttps,
    value: isHttps ? "Yes" : "No",
    detail: isHttps ? "Site uses HTTPS — required for trust signals." : "Site is not using HTTPS. This hurts trust and AI citation likelihood.",
  });

  const pageSizeKb = Math.round(html.length / 1024);
  const pageSizeOk = pageSizeKb < 500;
  const inlineStyleTags = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  const styleSize = inlineStyleTags.reduce((sum, tag) => sum + tag.length, 0);
  const inlineScriptTags = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const scriptSize = inlineScriptTags.reduce((sum, tag) => sum + tag.length, 0);
  const base64Images = html.match(/data:image\/[^;]+;base64,[^"')]+/g) ?? [];
  const imageSize = base64Images.reduce((sum, img) => sum + img.length, 0);
  const htmlStructureSize = html.length - styleSize - scriptSize - imageSize;
  const breakdown = [
    { label: "HTML Structure", size: htmlStructureSize, percent: Math.round((htmlStructureSize / html.length) * 100) },
    { label: "Inline CSS", size: styleSize, percent: Math.round((styleSize / html.length) * 100) },
    { label: "Inline JavaScript", size: scriptSize, percent: Math.round((scriptSize / html.length) * 100) },
    { label: "Base64 Images", size: imageSize, percent: Math.round((imageSize / html.length) * 100) },
  ].filter(item => item.size > 0).sort((a, b) => b.size - a.size);
  const breakdownText = breakdown.map(item => `  • ${item.label}: ${Math.round(item.size / 1024)} KB (${item.percent}%)`).join("\n");
  const recommendations: string[] = [];
  if (scriptSize > 200_000) recommendations.push("Inline JS is large — consider code splitting or external files");
  if (styleSize > 100_000) recommendations.push("Inline CSS is large — consider external stylesheets");
  if (imageSize > 100_000) recommendations.push("Base64 images detected — use external image files with CDN");
  checks.push({
    id: "page_size", label: "Page Size", category: "technical",
    pass: pageSizeOk,
    value: `${pageSizeKb} KB`,
    detail: pageSizeOk
      ? "Page size is reasonable for fast loading."
      : `Page is large (>500 KB). Heavy pages may timeout AI crawlers.\n\nSize breakdown:\n${breakdownText}${recommendations.length > 0 ? "\n\nRecommendations:\n  • " + recommendations.join("\n  • ") : ""}`,
  });

  const langMatch = html.match(/<html[^>]*lang=["']([^"']+)["']/i);
  const hasLang = !!langMatch;
  checks.push({
    id: "lang_tag", label: "Language Attribute", category: "technical",
    pass: hasLang,
    value: hasLang ? langMatch![1] : "Missing",
    detail: hasLang
      ? `Language set to "${langMatch![1]}" — helps AI models serve correct language results.`
      : 'No lang attribute on <html>. Add lang="en" (or your language) for AI localization.',
  });

  const csrFrameworkSignals = [
    { name: "React CSR", pattern: /<div\s+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i },
    { name: "Vue CSR", pattern: /<div\s+id=["'](app|__vue_app__)["'][^>]*>\s*<\/div>/i },
    { name: "Angular", pattern: /<app-root[^>]*>\s*<\/app-root>/i },
    { name: "Svelte", pattern: /<div\s+id=["']svelte["'][^>]*>\s*<\/div>/i },
  ];
  const detectedCsrFrameworks = csrFrameworkSignals.filter((s) => s.pattern.test(html)).map((s) => s.name);
  const textToHtmlRatio = plain.length / Math.max(html.length, 1);
  const hasMinimalContent = plain.length < 200 && html.length > 2000;
  const likelyCsr = detectedCsrFrameworks.length > 0 && (hasMinimalContent || textToHtmlRatio < 0.02);
  const hasNextData = /__NEXT_DATA__/i.test(html);
  const hasReactRoot = /data-reactroot/i.test(html);
  const hasSsrMarkers = hasNextData || hasReactRoot;
  const csrCheckPass = !likelyCsr || hasSsrMarkers;
  checks.push({
    id: "csr_detection", label: "Client-Side Rendering", category: "rendering",
    pass: csrCheckPass,
    value: likelyCsr ? (hasSsrMarkers ? "CSR detected but SSR markers present" : `Likely CSR (${detectedCsrFrameworks.join(", ")})`) : "Server-rendered",
    detail: likelyCsr && !hasSsrMarkers
      ? `Detected ${detectedCsrFrameworks.join(", ")} with minimal server-rendered text (${plain.length} chars, ${(textToHtmlRatio * 100).toFixed(1)}% text ratio). LLM bots cannot execute JavaScript — they will see a blank page. Use SSR or SSG.`
      : likelyCsr && hasSsrMarkers
        ? `Framework detected (${detectedCsrFrameworks.join(", ")}) but SSR markers found. Content appears to be server-rendered.`
        : `Page content is server-rendered (${plain.length.toLocaleString()} chars text, ${(textToHtmlRatio * 100).toFixed(1)}% text ratio). LLM bots can read this content.`,
  });

  const hasNoscript = /<noscript[\s>]/i.test(html);
  const noscriptContent = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/i)?.[1] ?? "";
  const noscriptHasContent = stripHtml(noscriptContent).length > 20;
  checks.push({
    id: "noscript_fallback", label: "Noscript Fallback", category: "rendering",
    pass: hasNoscript && noscriptHasContent,
    value: hasNoscript ? (noscriptHasContent ? "Has content" : "Empty/minimal") : "Missing",
    detail: hasNoscript && noscriptHasContent
      ? "Good — <noscript> tag with meaningful fallback content."
      : hasNoscript
        ? "<noscript> tag exists but contains minimal content. Add a meaningful fallback message."
        : "No <noscript> tag found. Add one with fallback content for non-JS environments.",
  });

  const scriptTags = html.match(/<script[^>]*src=["'][^"']+["'][^>]*>/gi) ?? [];
  const inlineScripts = html.match(/<script(?![^>]*src=)[\s\S]*?<\/script>/gi) ?? [];
  const totalInlineScriptSize = inlineScripts.reduce((sum, s) => sum + s.length, 0);
  const externalScriptCount = scriptTags.length;
  const jsHeavy = externalScriptCount > 15 || totalInlineScriptSize > 100_000;
  checks.push({
    id: "js_bundle_weight", label: "JavaScript Weight", category: "rendering",
    pass: !jsHeavy,
    value: `${externalScriptCount} external, ${Math.round(totalInlineScriptSize / 1024)}KB inline`,
    detail: jsHeavy
      ? `Heavy JS detected: ${externalScriptCount} external scripts and ${Math.round(totalInlineScriptSize / 1024)}KB inline JS. Consider reducing JS or implementing SSR.`
      : `Reasonable JS footprint: ${externalScriptCount} external scripts, ${Math.round(totalInlineScriptSize / 1024)}KB inline.`,
  });

  const serverContentLen = plain.length;
  const hasSemanticHtml = /<(article|main|section)[\s>]/i.test(html);
  const hasDataAttributes = /data-(testid|cy|component)/i.test(html);
  const serverContentOk = serverContentLen > 500 && (hasSemanticHtml || !hasDataAttributes);
  checks.push({
    id: "server_content_quality", label: "Server-Rendered Content Quality", category: "rendering",
    pass: serverContentOk,
    value: serverContentOk ? `${serverContentLen.toLocaleString()} chars` : `Only ${serverContentLen} chars`,
    detail: serverContentOk
      ? `Server-rendered HTML contains ${serverContentLen.toLocaleString()} characters${hasSemanticHtml ? " with semantic HTML elements" : ""}. LLM bots can extract meaningful information.`
      : serverContentLen <= 500
        ? `Very little server-rendered text (${serverContentLen} chars). Ensure key content is rendered server-side.`
        : "Server-rendered HTML lacks semantic structure. Use <article>, <main>, or <section> elements.",
  });

  const passed = checks.filter((c) => c.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  return { url, score, checks };
}

// ── Loader ─────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [latestAudit, latestDetection] = await Promise.all([
    prisma.auditSnapshot.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.detectionSnapshot.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { latestAudit, latestDetection };
};

// ── Action ─────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const actionType = String(formData.get("actionType") || "").trim();
  const rawUrl = String(formData.get("url") || "").trim();

  const normalizedUrl = rawUrl
    ? (/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
    : "";

  // ── audit ──────────────────────────────────────────────────────
  if (actionType === "audit") {
    if (!rawUrl) return { actionType, error: "URL is required" };
    try { new URL(normalizedUrl); } catch { return { actionType, error: "Invalid URL format" }; }

    try {
      const result = await runAudit(normalizedUrl);
      await prisma.auditSnapshot.create({
        data: {
          shop,
          url: result.url,
          score: result.score,
          checksJson: JSON.stringify(result.checks),
        },
      });
      return { actionType, url: result.url, score: result.score, checks: result.checks };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { actionType, error: message };
    }
  }

  // ── generate_llms_txt ──────────────────────────────────────────
  if (actionType === "generate_llms_txt") {
    if (!rawUrl) return { actionType, error: "URL is required" };
    try { new URL(normalizedUrl); } catch { return { actionType, error: "Invalid URL format" }; }

    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
    if (!firecrawlApiKey) {
      return { actionType, error: "Firecrawl API Key 未配置。请在 .env 文件中设置 FIRECRAWL_API_KEY" };
    }
    try {
      const firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey });
      const result = await firecrawl.v1.generateLLMsText(normalizedUrl, { maxUrls: 50, showFullText: true });
      if (!result.success || !("data" in result)) {
        const errorMsg = "error" in result ? result.error : "生成失败";
        return { actionType, error: `生成 llms.txt 失败: ${errorMsg}` };
      }
      return { actionType, success: true, llmsTxt: result.data.llmstxt, llmsFullTxt: result.data.llmsfulltxt };
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成失败";
      return { actionType, error: `生成 llms.txt 失败: ${message}` };
    }
  }

  // ── extract_niche ──────────────────────────────────────────────
  if (actionType === "extract_niche") {
    if (!rawUrl) return { actionType, error: "URL is required" };
    if (!isValidUrl(rawUrl)) return { actionType, error: "Invalid URL format" };
    try {
      const niche = await extractNicheFromUrl(normalizedUrl);
      return { actionType, url: normalizedUrl, niche };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to extract niche";
      return { actionType, url: rawUrl, error: message };
    }
  }

  // ── niche_generate ─────────────────────────────────────────────
  if (actionType === "niche_generate") {
    const niche = String(formData.get("niche") || "").trim();
    const promptCountRaw = Number(formData.get("promptCount") || 12);
    const promptCount = Number.isFinite(promptCountRaw)
      ? Math.min(30, Math.max(1, Math.floor(promptCountRaw)))
      : 12;
    if (!niche) return { actionType, error: "Niche is required" };
    try {
      const nichePrompts = await generateNicheDetectionPrompts(niche, promptCount);
      return { actionType, nichePrompts };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate niche prompts";
      return { actionType, error: message };
    }
  }

  // ── detect ─────────────────────────────────────────────────────
  if (actionType === "detect") {
    const prompt = String(formData.get("prompt") || "").trim();
    const providersRaw = String(formData.get("providers") || "").trim();
    if (prompt.length < 5) return { actionType, url: normalizedUrl || undefined, error: "Prompt is too short" };

    const domain = rawUrl && isValidUrl(rawUrl) ? normalizeDomain(normalizedUrl) : "";
    const brandTerms = domain ? [domain.split(".")[0], domain].filter(Boolean) : [];
    const websiteDomains = domain ? [domain] : [];

    const selectedProviders: Provider[] = providersRaw
      ? (providersRaw.split(",").filter((p) => PROVIDERS.includes(p as Provider)) as Provider[])
      : [...PROVIDERS];
    const runProviders = selectedProviders.length > 0 ? selectedProviders : [...PROVIDERS];

    const taskId = crypto.randomUUID();
    const task: DetectionTask = {
      status: "running",
      prompt,
      url: normalizedUrl || undefined,
      providerTotal: runProviders.length,
      completedProviders: 0,
      failedProviders: [],
      createdAt: Date.now(),
    };
    detectionTaskMap.set(taskId, task);

    Promise.allSettled(
      runProviders.map(async (provider) => {
        try {
          return await runAiScraper({ provider, prompt, requireSources: true });
        } finally {
          const currentTask = detectionTaskMap.get(taskId);
          if (currentTask && currentTask.status === "running") {
            detectionTaskMap.set(taskId, {
              ...currentTask,
              completedProviders: Math.min(currentTask.completedProviders + 1, runProviders.length),
            });
          }
        }
      }),
    )
      .then((settled) => {
        const results: VisibilityResult[] = [];
        const failedProviders: Array<{ provider: Provider; error: string }> = [];

        settled.forEach((entry, index) => {
          const provider = runProviders[index];
          if (entry.status === "fulfilled") {
            const item = entry.value;
            const visibilityScore = calcVisibilityScore(item.answer, item.sources, brandTerms, websiteDomains);
            const sentiment = detectSentiment(item.answer, brandTerms);
            const brandMentions = findMentions(item.answer, brandTerms);
            results.push({ ...item, visibilityScore, sentiment, brandMentions });
          } else {
            const message = entry.reason instanceof Error ? entry.reason.message : "Unknown error";
            failedProviders.push({ provider, error: message });
          }
        });

        if (results.length > 0) {
          const avgScore = Math.round(results.reduce((sum, r) => sum + r.visibilityScore, 0) / results.length);
          prisma.detectionSnapshot.create({
            data: {
              shop,
              url: normalizedUrl || null,
              prompt,
              avgScore,
              resultsJson: JSON.stringify(results),
            },
          }).catch(() => {});

          detectionTaskMap.set(taskId, {
            ...task,
            status: "done",
            completedProviders: runProviders.length,
            results,
            avgScore,
            failedProviders,
          });
          return;
        }

        detectionTaskMap.set(taskId, {
          ...task,
          status: "error",
          completedProviders: runProviders.length,
          failedProviders,
          error: "All providers failed",
        });
      })
      .catch((err) => {
        detectionTaskMap.set(taskId, {
          ...task,
          status: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      });

    return {
      actionType: "detect_started",
      taskId,
      url: normalizedUrl || undefined,
      prompt,
      providerTotal: runProviders.length,
    };
  }

  if (actionType === "poll_task") {
    const taskId = String(formData.get("taskId") || "");
    const task = detectionTaskMap.get(taskId);
    if (!task) return { actionType, error: "Task not found" };
    return { actionType, task };
  }

  return { actionType, error: "Invalid actionType" };
};

// ── UI Helpers ─────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 70) return "#10b981";
  if (score >= 40) return "#f59e0b";
  return "#ef4444";
}

function sentimentColor(sentiment: VisibilityResult["sentiment"]) {
  if (sentiment === "positive") return "#10b981";
  if (sentiment === "negative") return "#ef4444";
  if (sentiment === "neutral") return "#f59e0b";
  return "#6b7280";
}

function ScoreRing({ score, size = 110 }: { score: number | null; size?: number }) {
  const r = (size - 16) / 2;
  const circ = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  if (score === null) {
    return (
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e5e7eb" strokeWidth="8" />
        </svg>
        <span style={{ position: "absolute", fontSize: size > 90 ? "1.25rem" : "1rem", fontWeight: "bold", color: "#9ca3af" }}>--</span>
      </div>
    );
  }

  const offset = circ * (1 - score / 100);
  const color = score >= 80 ? "#10b981" : score >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e5e7eb" strokeWidth="8" />
        <circle
          cx={cx} cy={cy} r={r}
          fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <span style={{ position: "absolute", fontSize: size > 90 ? "1.5rem" : "1rem", fontWeight: "bold", color }}>
        {score}
      </span>
    </div>
  );
}

function CheckRow({ check, auditUrl }: { check: Check; auditUrl: string }) {
  const [open, setOpen] = useState(false);
  const fixFetcher = useFetcher<ActionData>();

  const canFix = !check.pass && (check.id === "llms_txt" || check.id === "llms_full_txt");
  const isFixing = fixFetcher.state === "submitting";
  const isGenerated = fixFetcher.data?.success === true && fixFetcher.data?.actionType === "generate_llms_txt";

  const handleDownload = () => {
    if (!isGenerated || !fixFetcher.data) return;
    const data = fixFetcher.data as ActionData;
    if (data.llmsTxt) {
      const blob1 = new Blob([data.llmsTxt], { type: "text/plain;charset=utf-8" });
      const url1 = URL.createObjectURL(blob1);
      const a1 = document.createElement("a");
      a1.href = url1; a1.download = "llms.txt";
      document.body.appendChild(a1); a1.click();
      document.body.removeChild(a1); URL.revokeObjectURL(url1);
    }
    if (data.llmsFullTxt) {
      setTimeout(() => {
        const blob2 = new Blob([data.llmsFullTxt!], { type: "text/plain;charset=utf-8" });
        const url2 = URL.createObjectURL(blob2);
        const a2 = document.createElement("a");
        a2.href = url2; a2.download = "llms-full.txt";
        document.body.appendChild(a2); a2.click();
        document.body.removeChild(a2); URL.revokeObjectURL(url2);
      }, 500);
    }
  };

  return (
    <div style={{ borderRadius: 8, border: "1px solid #e5e7eb", backgroundColor: "#fff", marginBottom: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "10px 16px", textAlign: "left", fontSize: "0.875rem", border: "none", background: "transparent", cursor: "pointer" }}
      >
        <span style={{ color: check.pass ? "#10b981" : "#ef4444", fontSize: "1rem" }}>{check.pass ? "✓" : "✗"}</span>
        <span style={{ flex: 1, fontWeight: 500, color: "#111827" }}>{check.label}</span>
        <span style={{ borderRadius: 6, backgroundColor: "#f3f4f6", padding: "2px 8px", fontSize: "0.75rem", color: "#6b7280" }}>{check.value}</span>
        {canFix && !isGenerated && (
          <fixFetcher.Form method="post" onClick={(e) => e.stopPropagation()}>
            <input type="hidden" name="actionType" value="generate_llms_txt" />
            <input type="hidden" name="url" value={auditUrl} />
            <button type="submit" disabled={isFixing} style={{ padding: "4px 12px", fontSize: "0.75rem", fontWeight: 500, color: "#fff", backgroundColor: isFixing ? "#9ca3af" : "#5C6AC4", border: "none", borderRadius: 6, cursor: isFixing ? "not-allowed" : "pointer" }}>
              {isFixing ? "生成中..." : "生成"}
            </button>
          </fixFetcher.Form>
        )}
        {isGenerated && (
          <button onClick={(e) => { e.stopPropagation(); handleDownload(); }} style={{ padding: "4px 12px", fontSize: "0.75rem", fontWeight: 500, color: "#fff", backgroundColor: "#10b981", border: "none", borderRadius: 6, cursor: "pointer" }}>
            下载
          </button>
        )}
        <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid #e5e7eb", padding: "10px 16px", fontSize: "0.875rem", color: "#6b7280", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {check.detail}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function Dashboard() {
  const loaderData = useLoaderData<typeof loader>();
  const auditFetcher = useFetcher<ActionData>();
  const detectionFetcher = useFetcher<ActionData>();

  const [url, setUrl] = useState("");
  const [niche, setNiche] = useState("");
  const [nichePrompts, setNichePrompts] = useState<string[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<Provider[]>([...PROVIDERS]);
  const [promptCount, setPromptCount] = useState(6);
  const [detectionRuns, setDetectionRuns] = useState<DetectionRun[]>([]);
  const [pollingTaskId, setPollingTaskId] = useState<string | null>(null);

  const isAuditLoading = auditFetcher.state === "submitting" && auditFetcher.formData?.get("actionType") === "audit";
  const isDetectionLoading = !!(
    (detectionFetcher.state === "submitting" && detectionFetcher.formData?.get("actionType") === "detect") ||
    pollingTaskId
  );

  const auditResult = auditFetcher.data?.actionType === "audit" ? auditFetcher.data : null;
  const latestRun = detectionRuns[0] ?? null;

  const latestAuditScore = auditResult?.score ?? loaderData.latestAudit?.score ?? null;
  const latestDetectionScore = latestRun?.avgScore ?? loaderData.latestDetection?.avgScore ?? null;

  useEffect(() => {
    if (!detectionFetcher.data) return;
    if (detectionFetcher.data.actionType === "extract_niche" && detectionFetcher.data.niche) {
      setNiche(detectionFetcher.data.niche);
      setNichePrompts([]);
    }
    if (detectionFetcher.data.actionType === "niche_generate" && detectionFetcher.data.nichePrompts) {
      setNichePrompts(detectionFetcher.data.nichePrompts);
    }
    if (detectionFetcher.data.actionType === "detect_started" && detectionFetcher.data.taskId) {
      setPollingTaskId(detectionFetcher.data.taskId);
    }
    if (detectionFetcher.data.actionType === "poll_task" && detectionFetcher.data.task) {
      const task = detectionFetcher.data.task;
      if (task.status === "done" && task.results && task.results.length > 0) {
        const run: DetectionRun = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          prompt: task.prompt,
          url: task.url,
          avgScore: task.avgScore ?? 0,
          results: task.results,
          failedProviders: task.failedProviders,
          providerTotal: task.providerTotal,
          createdAt: task.createdAt,
        };
        setDetectionRuns((prev) => [run, ...prev]);
        setPollingTaskId(null);
      } else if (task.status === "error") {
        setPollingTaskId(null);
      }
    }
  }, [detectionFetcher.data]);

  useEffect(() => {
    if (!pollingTaskId) return;
    const interval = setInterval(() => {
      const fd = new FormData();
      fd.append("actionType", "poll_task");
      fd.append("taskId", pollingTaskId);
      detectionFetcher.submit(fd, { method: "POST" });
    }, 3000);
    return () => clearInterval(interval);
  }, [pollingTaskId]);

  const handleAudit = () => {
    if (!url.trim()) return;
    const fd = new FormData();
    fd.append("actionType", "audit");
    fd.append("url", url);
    auditFetcher.submit(fd, { method: "POST" });
  };

  const handleDetect = (prompt: string) => {
    const fd = new FormData();
    fd.append("actionType", "detect");
    fd.append("url", url);
    fd.append("prompt", prompt);
    fd.append("providers", selectedProviders.join(","));
    detectionFetcher.submit(fd, { method: "POST" });
  };

  const kpis = useMemo(() => {
    const rows = latestRun?.results ?? [];
    if (rows.length === 0) return { avgScore: 0, mentionedProviders: 0, positiveProviders: 0, totalSources: 0 };
    const avgScore = Math.round(rows.reduce((sum, row) => sum + row.visibilityScore, 0) / rows.length);
    const mentionedProviders = rows.filter((row) => row.brandMentions.length > 0).length;
    const positiveProviders = rows.filter((row) => row.sentiment === "positive").length;
    const totalSources = rows.reduce((sum, row) => sum + row.sources.length, 0);
    return { avgScore, mentionedProviders, positiveProviders, totalSources };
  }, [latestRun]);

  const allSources = useMemo(() => {
    const rows = latestRun?.results ?? [];
    return [...new Set(rows.flatMap((row) => row.sources))];
  }, [latestRun]);

  const categories: CheckCategory[] = ["discovery", "structure", "content", "technical", "rendering"];

  return (
    <s-page heading="Dashboard">
      <s-section>
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            onKeyDown={(e) => e.key === "Enter" && handleAudit()}
            style={{ flex: 1, padding: "10px 12px", fontSize: "0.875rem", border: "1px solid #d1d5db", borderRadius: 8, outline: "none" }}
          />
          <s-button onClick={handleAudit} {...(isAuditLoading ? { loading: true } : {})}>
            Run Site Audit
          </s-button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          {/* ── Left: Site Audit ────────────────────────────────────── */}
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, backgroundColor: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
              <ScoreRing score={latestAuditScore} size={90} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "1rem", fontWeight: 600, color: "#111827", marginBottom: 4 }}>Site Audit</div>
                <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                  {latestAuditScore !== null ? `最新评分: ${latestAuditScore}` : "尚无历史数据"}
                </div>
              </div>
            </div>

            {auditResult?.error && (
              <div style={{ padding: 12, backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", marginBottom: 16, fontSize: "0.875rem" }}>
                {auditResult.error}
              </div>
            )}

            {auditResult && !auditResult.error && auditResult.checks && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                  {auditResult.checks.filter((c) => c.pass).length} / {auditResult.checks.length} 检查通过
                </div>
                {categories.map((cat) => {
                  const meta = CATEGORY_META[cat];
                  const group = auditResult.checks!.filter((c) => c.category === cat);
                  if (group.length === 0) return null;
                  return (
                    <div key={cat}>
                      <h4 style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem", fontWeight: 600, color: meta.color, marginBottom: 8 }}>
                        {meta.icon} {meta.label}
                      </h4>
                      <div>
                        {group.map((check) => (
                          <CheckRow key={check.id} check={check} auditUrl={auditResult.url!} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Right: Visibility Overview ────────────────────────────────── */}
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, backgroundColor: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
              <ScoreRing score={latestDetectionScore} size={90} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "1rem", fontWeight: 600, color: "#111827", marginBottom: 4 }}>Visibility Overview</div>
                <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                  {latestDetectionScore !== null ? `最新评分: ${latestDetectionScore}` : "尚无历史数据"}
                </div>
              </div>
            </div>

            {!niche && !nichePrompts.length && (
              <s-button
                onClick={() => {
                  if (!url.trim()) return;
                  const fd = new FormData();
                  fd.append("actionType", "extract_niche");
                  fd.append("url", url);
                  detectionFetcher.submit(fd, { method: "POST" });
                }}
                {...(detectionFetcher.state === "submitting" && detectionFetcher.formData?.get("actionType") === "extract_niche" ? { loading: true } : {})}
              >
                Check AI Visibility
              </s-button>
            )}

            {niche && !nichePrompts.length && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ padding: 12, backgroundColor: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, fontSize: "0.875rem" }}>
                  <div style={{ fontWeight: 600, color: "#166534", marginBottom: 4 }}>Niche Detected</div>
                  <div style={{ color: "#15803d" }}>{niche}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <label htmlFor="prompt-count" style={{ fontSize: "0.8rem", color: "#374151", minWidth: 86 }}>
                    Prompt count
                  </label>
                  <input
                    id="prompt-count"
                    type="number"
                    min={1}
                    max={30}
                    value={promptCount}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isFinite(value)) return;
                      setPromptCount(Math.min(30, Math.max(1, Math.floor(value))));
                    }}
                    style={{ width: 90, padding: "6px 8px", fontSize: "0.8rem", border: "1px solid #d1d5db", borderRadius: 6 }}
                  />
                </div>
                <s-button
                  onClick={() => {
                    const fd = new FormData();
                    fd.append("actionType", "niche_generate");
                    fd.append("niche", niche);
                    fd.append("promptCount", String(promptCount));
                    detectionFetcher.submit(fd, { method: "POST" });
                  }}
                  {...(detectionFetcher.state === "submitting" && detectionFetcher.formData?.get("actionType") === "niche_generate" ? { loading: true } : {})}
                >
                  Generate Prompts
                </s-button>
              </div>
            )}

            {pollingTaskId && detectionFetcher.data?.actionType === "poll_task" && detectionFetcher.data.task && (
              <div style={{ padding: 12, backgroundColor: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 8, color: "#1e40af", marginBottom: 16, fontSize: "0.875rem" }}>
                Running detection... ({detectionFetcher.data.task.completedProviders}/{detectionFetcher.data.task.providerTotal} providers completed)
              </div>
            )}

            {detectionFetcher.data?.error && (
              <div style={{ padding: 12, backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", marginBottom: 16, fontSize: "0.875rem" }}>
                {detectionFetcher.data.error}
              </div>
            )}

            {nichePrompts.length > 0 && detectionRuns.length === 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  {PROVIDERS.map((provider) => {
                    const checked = selectedProviders.includes(provider);
                    return (
                      <label key={provider} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: checked ? "1px solid #93c5fd" : "1px solid #e5e7eb", borderRadius: 6, background: checked ? "#eff6ff" : "#fff", cursor: "pointer", fontSize: 11 }}>
                        <input type="checkbox" checked={checked} onChange={(e) => { setSelectedProviders((prev) => { if (e.target.checked) return [...prev, provider]; const next = prev.filter((p) => p !== provider); return next.length > 0 ? next : prev; }); }} />
                        <span>{PROVIDER_LABELS[provider]}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {nichePrompts.map((q, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#f9fafb", fontSize: 11 }}>
                      <span style={{ flex: 1, color: "#111827" }}>{q}</span>
                      <s-button onClick={() => handleDetect(q)} {...(isDetectionLoading ? { loading: true } : {})}>
                        Run
                      </s-button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {nichePrompts.length > 0 && detectionRuns.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  {PROVIDERS.map((provider) => {
                    const checked = selectedProviders.includes(provider);
                    return (
                      <label key={provider} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: checked ? "1px solid #93c5fd" : "1px solid #e5e7eb", borderRadius: 6, background: checked ? "#eff6ff" : "#fff", cursor: "pointer", fontSize: 11 }}>
                        <input type="checkbox" checked={checked} onChange={(e) => { setSelectedProviders((prev) => { if (e.target.checked) return [...prev, provider]; const next = prev.filter((p) => p !== provider); return next.length > 0 ? next : prev; }); }} />
                        <span>{PROVIDER_LABELS[provider]}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {nichePrompts.map((q, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#f9fafb", fontSize: 11 }}>
                      <span style={{ flex: 1, color: "#111827" }}>{q}</span>
                      <s-button onClick={() => handleDetect(q)} {...(isDetectionLoading ? { loading: true } : {})}>
                        Run
                      </s-button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </s-section>

      {/* ── Detection Details (Full Width) ────────────────────────── */}
      {detectionRuns.length > 0 && (
        <s-section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#111827" }}>
              Detection Results ({detectionRuns.length} run{detectionRuns.length > 1 ? "s" : ""})
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  const lines: string[] = [];
                  lines.push(`AI Visibility Detection Report`);
                  lines.push(`Generated: ${new Date().toLocaleString()}`);
                  lines.push(`${"=".repeat(60)}\n`);
                  detectionRuns.forEach((run, ri) => {
                    lines.push(`Run ${ri + 1}: ${run.prompt}`);
                    if (run.url) lines.push(`URL: ${run.url}`);
                    lines.push(`Avg Score: ${run.avgScore}`);
                    lines.push(`Time: ${new Date(run.createdAt).toLocaleString()}`);
                    lines.push(`${"-".repeat(60)}`);
                    run.results.forEach((row) => {
                      lines.push(`\n[${PROVIDER_LABELS[row.provider]}] Score: ${row.visibilityScore} | Sentiment: ${row.sentiment}`);
                      lines.push(`Mentions: ${row.brandMentions.join(", ") || "none"}`);
                      lines.push(`Sources: ${row.sources.join(", ") || "none"}`);
                      lines.push(`Answer:\n${row.answer}`);
                    });
                    if (run.failedProviders.length > 0) {
                      lines.push(`\nFailed: ${run.failedProviders.map((f) => `${PROVIDER_LABELS[f.provider]} (${f.error})`).join(", ")}`);
                    }
                    lines.push(`\n${"=".repeat(60)}\n`);
                  });
                  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = `visibility-report-${Date.now()}.txt`;
                  document.body.appendChild(a); a.click();
                  document.body.removeChild(a); URL.revokeObjectURL(a.href);
                }}
                style={{ padding: "6px 14px", fontSize: "0.8rem", fontWeight: 500, color: "#fff", backgroundColor: "#5C6AC4", border: "none", borderRadius: 6, cursor: "pointer" }}
              >
                Download Report
              </button>
              <button
                onClick={() => { setNiche(""); setNichePrompts([]); setDetectionRuns([]); }}
                style={{ padding: "6px 14px", fontSize: "0.8rem", fontWeight: 500, color: "#374151", backgroundColor: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer" }}
              >
                New Check
              </button>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {detectionRuns.map((run, ri) => (
              <div key={run.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
                {/* Run header */}
                <div style={{ padding: "12px 16px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>
                      Run {detectionRuns.length - ri} · {new Date(run.createdAt).toLocaleTimeString()}
                      {run.failedProviders.length > 0 && (
                        <span style={{ color: "#ef4444", marginLeft: 8 }}>
                          {run.failedProviders.length} failed
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{run.prompt}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>Avg Score</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: scoreColor(run.avgScore) }}>{run.avgScore}</div>
                  </div>
                </div>
                {/* Provider answers */}
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {run.results.map((row, idx) => (
                    <div key={row.provider} style={{ padding: "12px 16px", borderTop: idx > 0 ? "1px solid #f3f4f6" : undefined }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{PROVIDER_LABELS[row.provider]}</span>
                          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#f3f4f6", color: sentimentColor(row.sentiment), fontWeight: 600 }}>
                            {row.sentiment}
                          </span>
                          {row.cached && <span style={{ fontSize: 11, color: "#9ca3af" }}>cached</span>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "#6b7280" }}>
                          <span>Score: <strong style={{ color: scoreColor(row.visibilityScore) }}>{row.visibilityScore}</strong></span>
                          <span>Mentions: <strong style={{ color: "#111827" }}>{row.brandMentions.length}</strong></span>
                          <span>Sources: <strong style={{ color: "#111827" }}>{row.sources.length}</strong></span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap", background: "#f9fafb", border: "1px solid #f3f4f6", borderRadius: 6, padding: "10px 12px", maxHeight: 240, overflowY: "auto" }}>
                        {row.answer || "(no answer)"}
                      </div>
                      {row.sources.length > 0 && (
                        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {row.sources.map((s) => (
                            <a key={s} href={s} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#2563eb", background: "#eff6ff", padding: "2px 6px", borderRadius: 4, textDecoration: "none" }}>
                              {(() => { try { return new URL(s).hostname; } catch { return s.slice(0, 40); } })()}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {run.failedProviders.length > 0 && (
                    <div style={{ padding: "8px 16px", borderTop: "1px solid #f3f4f6", fontSize: 11, color: "#9ca3af" }}>
                      Failed: {run.failedProviders.map((f) => PROVIDER_LABELS[f.provider]).join(", ")}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
