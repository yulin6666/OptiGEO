import { useState, useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import FirecrawlApp from "@mendable/firecrawl-js";

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

  // 1. llms.txt
  checks.push({
    id: "llms_txt",
    label: "llms.txt",
    category: "discovery",
    pass: llmsRes.ok,
    value: llmsRes.ok ? "Present" : "Missing",
    detail: llmsRes.ok
      ? `Found at ${target.origin}/llms.txt (${llmsRes.text.length} bytes)`
      : "No llms.txt file found. This file tells AI models about your site's purpose and preferred content.",
  });

  // 2. llms-full.txt
  checks.push({
    id: "llms_full_txt",
    label: "llms-full.txt",
    category: "discovery",
    pass: llmsFullRes.ok,
    value: llmsFullRes.ok ? "Present" : "Missing",
    detail: llmsFullRes.ok
      ? `Found at ${target.origin}/llms-full.txt (${llmsFullRes.text.length} bytes)`
      : "No llms-full.txt found. This extended file provides detailed context for AI models.",
  });

  // 3. robots.txt - AI bot access
  const aiBots = ["gptbot", "chatgpt-user", "claudebot", "anthropic-ai", "google-extended", "googleother", "cohere-ai", "bytespider", "perplexitybot", "ccbot"];
  const blockedBots: string[] = [];
  const allowedBots: string[] = [];
  if (robotsRes.ok) {
    for (const bot of aiBots) {
      const botPattern = new RegExp(`user-agent:\\s*${bot}[\\s\\S]*?disallow:\\s*/`, "i");
      if (botPattern.test(robotsRes.text)) {
        blockedBots.push(bot);
      } else {
        allowedBots.push(bot);
      }
    }
  }
  const botAccessOk = robotsRes.ok && blockedBots.length <= 2;
  checks.push({
    id: "robots_ai_access",
    label: "AI Bot Access (robots.txt)",
    category: "discovery",
    pass: botAccessOk,
    value: robotsRes.ok ? `${blockedBots.length} blocked / ${aiBots.length} checked` : "No robots.txt",
    detail: robotsRes.ok
      ? blockedBots.length > 0
        ? `Blocked: ${blockedBots.join(", ")}. Allowed: ${allowedBots.slice(0, 5).join(", ")}${allowedBots.length > 5 ? "..." : ""}`
        : "All major AI bots are allowed to crawl."
      : "No robots.txt found — AI bots will default to crawling all pages.",
  });

  // 4. Sitemap
  const hasSitemap = sitemapRes.ok && (sitemapRes.text.includes("<url") || sitemapRes.text.includes("<sitemap"));
  const sitemapUrlCount = (sitemapRes.text.match(/<url>/gi) ?? []).length;
  const sitemapIndexCount = (sitemapRes.text.match(/<sitemap>/gi) ?? []).length;
  const displayCount = sitemapUrlCount > 0 ? sitemapUrlCount : sitemapIndexCount;
  const displayType = sitemapUrlCount > 0 ? "URLs" : "sitemaps";
  checks.push({
    id: "sitemap",
    label: "XML Sitemap",
    category: "discovery",
    pass: hasSitemap,
    value: hasSitemap ? `${displayCount} ${displayType}` : "Missing",
    detail: hasSitemap
      ? sitemapUrlCount > 0
        ? `Sitemap found with ${sitemapUrlCount} URL entries.`
        : `Sitemap index found with ${sitemapIndexCount} sub-sitemaps.`
      : "No sitemap.xml found. A sitemap helps AI systems discover and index your pages.",
  });

  // 5. JSON-LD Structured Data
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
    } catch { /* skip invalid JSON-LD */ }
  }
  checks.push({
    id: "json_ld",
    label: "JSON-LD Structured Data",
    category: "structure",
    pass: jsonLdBlocks.length > 0,
    value: jsonLdBlocks.length > 0 ? `${jsonLdBlocks.length} blocks (${schemaTypes.length} types)` : "None found",
    detail: schemaTypes.length > 0
      ? `Schema types: ${[...new Set(schemaTypes)].join(", ")}`
      : "No JSON-LD structured data found. Add Organization, Product, FAQPage, or Article schema.",
  });

  // 6. FAQ Schema
  const hasFaqSchema = schemaTypes.some((t) => /faq/i.test(t));
  const hasFaqHtml = /<details|<summary|class="faq"|id="faq"|class="accordion"/i.test(html);
  checks.push({
    id: "faq_schema",
    label: "FAQ / Q&A Schema",
    category: "structure",
    pass: hasFaqSchema || hasFaqHtml,
    value: hasFaqSchema ? "Schema present" : hasFaqHtml ? "HTML only (no schema)" : "Missing",
    detail: hasFaqSchema
      ? "FAQPage schema found — AI models can extract Q&A pairs."
      : hasFaqHtml
        ? "FAQ-like HTML elements found but no FAQPage schema markup. Add JSON-LD FAQPage schema."
        : "No FAQ content or schema detected. FAQ schema dramatically improves AI answer citations.",
  });

  // 7. Open Graph Tags
  const ogTags = html.match(/<meta[^>]*property=["']og:[^"']*["'][^>]*>/gi) ?? [];
  const ogTitle = /og:title/i.test(html);
  const ogDesc = /og:description/i.test(html);
  const ogImage = /og:image/i.test(html);
  const ogComplete = ogTitle && ogDesc && ogImage;
  checks.push({
    id: "open_graph",
    label: "Open Graph Tags",
    category: "structure",
    pass: ogComplete,
    value: `${ogTags.length} tags${ogComplete ? " (complete)" : ""}`,
    detail: ogComplete
      ? "og:title, og:description, and og:image all present."
      : `Missing: ${[!ogTitle && "og:title", !ogDesc && "og:description", !ogImage && "og:image"].filter(Boolean).join(", ")}. OG tags help AI tools preview and cite your content.`,
  });

  // 8. Meta Description
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const metaDesc = metaDescMatch?.[1] ?? "";
  const metaDescOk = metaDesc.length >= 50 && metaDesc.length <= 300;
  checks.push({
    id: "meta_description",
    label: "Meta Description",
    category: "structure",
    pass: metaDescOk,
    value: metaDesc ? `${metaDesc.length} chars` : "Missing",
    detail: metaDesc
      ? metaDescOk
        ? `Good length (${metaDesc.length} chars): "${metaDesc.slice(0, 100)}..."`
        : `Length ${metaDesc.length} chars — ${metaDesc.length < 50 ? "too short" : "too long"}. Aim for 50–160 characters.`
      : "No meta description found. AI tools use this as a content summary.",
  });

  // 9. Canonical Tag
  const hasCanonical = /<link[^>]*rel=["']canonical["']/i.test(html);
  checks.push({
    id: "canonical",
    label: "Canonical Tag",
    category: "structure",
    pass: hasCanonical,
    value: hasCanonical ? "Present" : "Missing",
    detail: hasCanonical
      ? "Canonical tag found — helps prevent duplicate content issues."
      : "No canonical tag. Add one to ensure AI models reference the correct URL.",
  });

  // 10. BLUF / Direct-Answer Style
  const firstChunkLen = Math.max(plain.length * 0.2, 400);
  const firstChunk = plain.slice(0, Math.floor(firstChunkLen));
  const bulletCount = (html.match(/<li\b/gi) ?? []).length;
  const hasDirectAnswer = /\b(in short|tl;dr|summary|key takeaways|bottom line|the answer is|here('?s| is) (what|how|why))\b/i.test(firstChunk);
  const blufScore = Math.min(1, (Number(hasDirectAnswer) + Number(bulletCount > 3) + Number(firstChunk.length > 100)) / 2);
  checks.push({
    id: "bluf_style",
    label: "BLUF / Direct-Answer Style",
    category: "content",
    pass: blufScore >= 0.5,
    value: `${Math.round(blufScore * 100)}%`,
    detail: hasDirectAnswer
      ? "Content leads with a direct answer — good for AI citation."
      : "Content doesn't lead with a clear direct answer. Start with a BLUF (Bottom Line Up Front) statement.",
  });

  // 11. Heading Hierarchy
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
  const h3Count = (html.match(/<h3[\s>]/gi) ?? []).length;
  const headingOk = h1Count === 1 && h2Count >= 2;
  checks.push({
    id: "heading_hierarchy",
    label: "Heading Hierarchy",
    category: "content",
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

  // 12. Content Length
  const wordCount = plain.split(/\s+/).filter(Boolean).length;
  const contentLengthOk = wordCount >= 300;
  checks.push({
    id: "content_length",
    label: "Content Depth",
    category: "content",
    pass: contentLengthOk,
    value: `${wordCount.toLocaleString()} words`,
    detail: contentLengthOk
      ? wordCount > 2000
        ? "Comprehensive content — great for in-depth AI citations."
        : "Adequate content length for AI answer extraction."
      : "Thin content — AI models prefer pages with 300+ words for citation. Add more substance.",
  });

  // 13. Internal Links
  const internalLinkPattern = new RegExp(`<a[^>]*href=["'](?:https?://(?:www\\.)?${target.hostname.replace(/\./g, "\\.")})?/[^"']*["']`, "gi");
  const internalLinks = (html.match(internalLinkPattern) ?? []).length;
  const internalLinkOk = internalLinks >= 3;
  checks.push({
    id: "internal_links",
    label: "Internal Links",
    category: "content",
    pass: internalLinkOk,
    value: `${internalLinks} links`,
    detail: internalLinkOk
      ? "Good internal linking — helps AI models discover related content."
      : "Few internal links. Add 3+ contextual internal links to help AI models map your content.",
  });

  // 14. HTTPS
  const isHttps = target.protocol === "https:";
  checks.push({
    id: "https",
    label: "HTTPS",
    category: "technical",
    pass: isHttps,
    value: isHttps ? "Yes" : "No",
    detail: isHttps ? "Site uses HTTPS — required for trust signals." : "Site is not using HTTPS. This hurts trust and AI citation likelihood.",
  });

  // 15. Page Size
  const pageSizeKb = Math.round(html.length / 1024);
  const pageSizeOk = pageSizeKb < 500;
  checks.push({
    id: "page_size",
    label: "Page Size",
    category: "technical",
    pass: pageSizeOk,
    value: `${pageSizeKb} KB`,
    detail: pageSizeOk
      ? "Page size is reasonable for fast loading."
      : "Page is large (>500 KB). Heavy pages may timeout AI crawlers.",
  });

  // 16. Language Tag
  const langMatch = html.match(/<html[^>]*lang=["']([^"']+)["']/i);
  const hasLang = !!langMatch;
  checks.push({
    id: "lang_tag",
    label: "Language Attribute",
    category: "technical",
    pass: hasLang,
    value: hasLang ? langMatch![1] : "Missing",
    detail: hasLang
      ? `Language set to "${langMatch![1]}" — helps AI models serve correct language results.`
      : 'No lang attribute on <html>. Add lang="en" (or your language) for AI localization.',
  });

  // 17. Client-Side Rendering Detection
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
    id: "csr_detection",
    label: "Client-Side Rendering",
    category: "rendering",
    pass: csrCheckPass,
    value: likelyCsr
      ? hasSsrMarkers
        ? "CSR detected but SSR markers present"
        : `Likely CSR (${detectedCsrFrameworks.join(", ")})`
      : "Server-rendered",
    detail: likelyCsr && !hasSsrMarkers
      ? `Detected ${detectedCsrFrameworks.join(", ")} with minimal server-rendered text (${plain.length} chars, ${(textToHtmlRatio * 100).toFixed(1)}% text ratio). LLM bots cannot execute JavaScript — they will see a blank page. Use SSR or SSG.`
      : likelyCsr && hasSsrMarkers
        ? `Framework detected (${detectedCsrFrameworks.join(", ")}) but SSR markers found. Content appears to be server-rendered.`
        : `Page content is server-rendered (${plain.length.toLocaleString()} chars text, ${(textToHtmlRatio * 100).toFixed(1)}% text ratio). LLM bots can read this content.`,
  });

  // 18. Noscript Fallback
  const hasNoscript = /<noscript[\s>]/i.test(html);
  const noscriptContent = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/i)?.[1] ?? "";
  const noscriptHasContent = stripHtml(noscriptContent).length > 20;
  checks.push({
    id: "noscript_fallback",
    label: "Noscript Fallback",
    category: "rendering",
    pass: hasNoscript && noscriptHasContent,
    value: hasNoscript ? (noscriptHasContent ? "Has content" : "Empty/minimal") : "Missing",
    detail: hasNoscript && noscriptHasContent
      ? "Good — <noscript> tag with meaningful fallback content."
      : hasNoscript
        ? "<noscript> tag exists but contains minimal content. Add a meaningful fallback message."
        : "No <noscript> tag found. Add one with fallback content for non-JS environments.",
  });

  // 19. JavaScript Bundle Weight
  const scriptTags = html.match(/<script[^>]*src=["'][^"']+["'][^>]*>/gi) ?? [];
  const inlineScripts = html.match(/<script(?![^>]*src=)[\s\S]*?<\/script>/gi) ?? [];
  const totalInlineScriptSize = inlineScripts.reduce((sum, s) => sum + s.length, 0);
  const externalScriptCount = scriptTags.length;
  const jsHeavy = externalScriptCount > 15 || totalInlineScriptSize > 100_000;
  checks.push({
    id: "js_bundle_weight",
    label: "JavaScript Weight",
    category: "rendering",
    pass: !jsHeavy,
    value: `${externalScriptCount} external, ${Math.round(totalInlineScriptSize / 1024)}KB inline`,
    detail: jsHeavy
      ? `Heavy JS detected: ${externalScriptCount} external scripts and ${Math.round(totalInlineScriptSize / 1024)}KB inline JS. Consider reducing JS or implementing SSR.`
      : `Reasonable JS footprint: ${externalScriptCount} external scripts, ${Math.round(totalInlineScriptSize / 1024)}KB inline.`,
  });

  // 20. Server-Rendered Content Quality
  const serverContentLen = plain.length;
  const hasSemanticHtml = /<(article|main|section)[\s>]/i.test(html);
  const hasDataAttributes = /data-(testid|cy|component)/i.test(html);
  const serverContentOk = serverContentLen > 500 && (hasSemanticHtml || !hasDataAttributes);
  checks.push({
    id: "server_content_quality",
    label: "Server-Rendered Content Quality",
    category: "rendering",
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

// ── Loader & Action ────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const actionType = formData.get("action") as string;
  const url = formData.get("url") as string;

  console.log("=== Action 被调用 ===");
  console.log("actionType:", actionType);
  console.log("url:", url);

  if (!url) {
    console.log("❌ URL 缺失");
    return { error: "URL is required" };
  }

  try {
    new URL(url);
  } catch {
    console.log("❌ URL 格式无效");
    return { error: "Invalid URL format" };
  }

  // 生成 llms.txt 和 llms-full.txt
  if (actionType === "generate_llms_txt") {
    console.log("✅ 进入生成 llms.txt 逻辑");

    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
    console.log("Firecrawl API Key 存在:", !!firecrawlApiKey);
    console.log("API Key 前缀:", firecrawlApiKey?.substring(0, 10));

    if (!firecrawlApiKey) {
      console.log("❌ API Key 未配置");
      return {
        error: "Firecrawl API Key 未配置。请在 .env 文件中设置 FIRECRAWL_API_KEY"
      };
    }

    try {
      console.log("🚀 开始调用 Firecrawl API...");
      const firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey });

      console.log("📡 调用 v1.generateLLMsText...");
      const result = await firecrawl.v1.generateLLMsText(url, {
        maxUrls: 50,
        showFullText: true
      });

      console.log("✅ Firecrawl 返回结果:", result);

      // 检查是否成功
      if (!result.success || !('data' in result)) {
        const errorMsg = 'error' in result ? result.error : '生成失败';
        console.error("❌ Firecrawl 返回失败:", errorMsg);
        return {
          error: `生成 llms.txt 失败: ${errorMsg}`
        };
      }

      console.log("✅ Firecrawl 调用成功");
      console.log("llmsTxt 长度:", result.data.llmstxt?.length);
      console.log("llmsFullTxt 长度:", result.data.llmsfulltxt?.length);

      return {
        success: true,
        action: "generate_llms_txt",
        llmsTxt: result.data.llmstxt,
        llmsFullTxt: result.data.llmsfulltxt
      };

    } catch (error) {
      console.error("❌ Firecrawl 调用失败:", error);
      const message = error instanceof Error ? error.message : "生成失败";
      return {
        error: `生成 llms.txt 失败: ${message}`
      };
    }
  }

  // 原有的审计逻辑
  console.log("📊 执行审计逻辑");
  try {
    const result = await runAudit(url);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { error: message };
  }
};

// ── UI Components ──────────────────────────────────────────────────────────

const CATEGORY_META: Record<CheckCategory, { label: string; icon: string; color: string }> = {
  discovery: { label: "Discovery", icon: "🔍", color: "#3b82f6" },
  structure: { label: "Structure & Schema", icon: "🏗️", color: "#8b5cf6" },
  content: { label: "Content Quality", icon: "📝", color: "#10b981" },
  technical: { label: "Technical", icon: "⚙️", color: "#f59e0b" },
  rendering: { label: "Server-Side Rendering", icon: "🖥️", color: "#ec4899" },
};

function ScoreRing({ score }: { score: number }) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  const color = score >= 80 ? "#10b981" : score >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 110, height: 110 }}>
      <svg width="110" height="110" viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e5e7eb" strokeWidth="8" />
        <circle
          cx="55"
          cy="55"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          transform="rotate(-90 55 55)"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <span style={{ position: "absolute", fontSize: "1.5rem", fontWeight: "bold", color }}>
        {score}
      </span>
    </div>
  );
}

function CheckRow({ check, auditUrl }: { check: Check; auditUrl: string }) {
  const [open, setOpen] = useState(false);
  const fixFetcher = useFetcher();

  // 判断是否可以修复
  const canFix = !check.pass && (check.id === "llms_txt" || check.id === "llms_full_txt");
  const isFixing = fixFetcher.state === "submitting";

  // 检查是否生成成功
  const isGenerated = fixFetcher.data &&
    typeof fixFetcher.data === 'object' &&
    'success' in fixFetcher.data &&
    fixFetcher.data.success === true &&
    'action' in fixFetcher.data &&
    fixFetcher.data.action === "generate_llms_txt";

  console.log("CheckRow 渲染:", {
    checkId: check.id,
    canFix,
    isFixing,
    isGenerated,
    fetcherData: fixFetcher.data
  });

  // 处理文件下载
  const handleDownload = () => {
    if (!isGenerated || !fixFetcher.data) return;

    const data = fixFetcher.data as any;
    console.log("📥 开始下载文件");

    // 下载 llms.txt
    const blob1 = new Blob([data.llmsTxt], { type: 'text/plain;charset=utf-8' });
    const url1 = URL.createObjectURL(blob1);
    const a1 = document.createElement('a');
    a1.href = url1;
    a1.download = 'llms.txt';
    document.body.appendChild(a1);
    a1.click();
    document.body.removeChild(a1);
    URL.revokeObjectURL(url1);

    // 下载 llms-full.txt
    setTimeout(() => {
      const blob2 = new Blob([data.llmsFullTxt], { type: 'text/plain;charset=utf-8' });
      const url2 = URL.createObjectURL(blob2);
      const a2 = document.createElement('a');
      a2.href = url2;
      a2.download = 'llms-full.txt';
      document.body.appendChild(a2);
      a2.click();
      document.body.removeChild(a2);
      URL.revokeObjectURL(url2);
      console.log("✅ 文件下载完成");
    }, 500);
  };

  return (
    <div style={{ borderRadius: 8, border: "1px solid #e5e7eb", backgroundColor: "#fff", marginBottom: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
          textAlign: "left",
          fontSize: "0.875rem",
          border: "none",
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <span style={{ color: check.pass ? "#10b981" : "#ef4444", fontSize: "1rem" }}>
          {check.pass ? "✓" : "✗"}
        </span>
        <span style={{ flex: 1, fontWeight: 500, color: "#111827" }}>{check.label}</span>
        <span style={{ borderRadius: 6, backgroundColor: "#f3f4f6", padding: "2px 8px", fontSize: "0.75rem", color: "#6b7280" }}>
          {check.value}
        </span>

        {canFix && !isGenerated && (
          <fixFetcher.Form
            method="post"
            onClick={(e) => e.stopPropagation()}
          >
            <input type="hidden" name="action" value="generate_llms_txt" />
            <input type="hidden" name="url" value={auditUrl} />
            <button
              type="submit"
              disabled={isFixing}
              style={{
                padding: "4px 12px",
                fontSize: "0.75rem",
                fontWeight: 500,
                color: "#fff",
                backgroundColor: isFixing ? "#9ca3af" : "#5C6AC4",
                border: "none",
                borderRadius: 6,
                cursor: isFixing ? "not-allowed" : "pointer",
                transition: "background-color 0.2s",
              }}
            >
              {isFixing ? "生成中..." : "生成"}
            </button>
          </fixFetcher.Form>
        )}

        {isGenerated && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
            style={{
              padding: "4px 12px",
              fontSize: "0.75rem",
              fontWeight: 500,
              color: "#fff",
              backgroundColor: "#10b981",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              transition: "background-color 0.2s",
            }}
          >
            下载
          </button>
        )}

        <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid #e5e7eb", padding: "10px 16px", fontSize: "0.875rem", color: "#6b7280", lineHeight: 1.6 }}>
          {check.detail}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const [url, setUrl] = useState("");

  const isLoading = fetcher.state === "submitting";
  const result = fetcher.data as AuditResult | undefined;

  const handleSubmit = () => {
    if (!url.trim()) return;
    const formData = new FormData();
    formData.append("url", url);
    fetcher.submit(formData, { method: "POST" });
  };

  // 处理文件下载
  useEffect(() => {
    if (fetcher.data && 'success' in fetcher.data && fetcher.data.success && fetcher.data.action === "generate_llms_txt") {
      const data = fetcher.data as any;

      // 下载 llms.txt
      const blob1 = new Blob([data.llmsTxt], { type: 'text/plain;charset=utf-8' });
      const url1 = URL.createObjectURL(blob1);
      const a1 = document.createElement('a');
      a1.href = url1;
      a1.download = 'llms.txt';
      document.body.appendChild(a1);
      a1.click();
      document.body.removeChild(a1);
      URL.revokeObjectURL(url1);

      // 下载 llms-full.txt
      setTimeout(() => {
        const blob2 = new Blob([data.llmsFullTxt], { type: 'text/plain;charset=utf-8' });
        const url2 = URL.createObjectURL(blob2);
        const a2 = document.createElement('a');
        a2.href = url2;
        a2.download = 'llms-full.txt';
        document.body.appendChild(a2);
        a2.click();
        document.body.removeChild(a2);
        URL.revokeObjectURL(url2);
      }, 500);
    }
  }, [fetcher.data]);

  const categories: CheckCategory[] = ["discovery", "structure", "content", "technical", "rendering"];

  return (
    <s-page heading="GEO Audit">
      <s-section>
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            style={{
              flex: 1,
              padding: "10px 12px",
              fontSize: "0.875rem",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              outline: "none",
            }}
          />
          <s-button onClick={handleSubmit} {...(isLoading ? { loading: true } : {})}>
            Run Audit
          </s-button>
        </div>

        {result?.error && (
          <div style={{ padding: 16, backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", marginBottom: 24 }}>
            {result.error}
          </div>
        )}

        {result && !result.error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24, padding: 20, border: "1px solid #e5e7eb", borderRadius: 12, backgroundColor: "#fff" }}>
              <ScoreRing score={result.score} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "1.125rem", fontWeight: 600, color: "#111827", marginBottom: 8 }}>
                  AEO Readiness Score
                </div>
                <div style={{ fontSize: "0.875rem", color: "#6b7280", marginBottom: 12 }}>
                  {result.checks.filter((c) => c.pass).length} of {result.checks.length} checks passed for{" "}
                  <span style={{ color: "#3b82f6" }}>{result.url}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {categories.map((cat) => {
                    const meta = CATEGORY_META[cat];
                    const group = result.checks.filter((c) => c.category === cat);
                    if (group.length === 0) return null;
                    const passed = group.filter((c) => c.pass).length;
                    return (
                      <span
                        key={cat}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "4px 10px",
                          fontSize: "0.75rem",
                          fontWeight: 500,
                          border: "1px solid #e5e7eb",
                          borderRadius: 16,
                          backgroundColor: "#f9fafb",
                          color: meta.color,
                        }}
                      >
                        {meta.icon} {meta.label}: {passed}/{group.length}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            {categories.map((cat) => {
              const meta = CATEGORY_META[cat];
              const group = result.checks.filter((c) => c.category === cat);
              if (group.length === 0) return null;
              return (
                <div key={cat}>
                  <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.875rem", fontWeight: 600, color: meta.color, marginBottom: 12 }}>
                    {meta.icon} {meta.label}
                  </h3>
                  <div>
                    {group.map((check) => (
                      <CheckRow key={check.id} check={check} auditUrl={result.url} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
