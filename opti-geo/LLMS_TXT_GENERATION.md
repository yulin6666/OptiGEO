# 一键生成 llms.txt 功能实现文档

## 功能概述

在 GEO 审计结果中，如果检测到网站缺少 `llms.txt` 或 `llms-full.txt` 文件，用户可以点击"生成"按钮，自动生成这两个文件并下载。

## 技术实现

### 1. 使用的技术栈

- **Firecrawl SDK** (`@mendable/firecrawl-js`): 专业的网站爬取和 llms.txt 生成工具
- **React Router 7**: 处理表单提交和数据获取
- **TypeScript**: 类型安全

### 2. 核心代码结构

#### 服务端 (Action)

```typescript
// app/routes/app._index.tsx

export const action = async ({ request }: ActionFunctionArgs) => {
  const actionType = formData.get("action");

  if (actionType === "generate_llms_txt") {
    const firecrawl = new FirecrawlApp({
      apiKey: process.env.FIRECRAWL_API_KEY
    });

    const result = await firecrawl.generateLLMsText(url, {
      maxUrls: 50,           // 限制爬取 50 个页面
      showFullText: true     // 同时生成 llms-full.txt
    });

    return {
      success: true,
      action: "generate_llms_txt",
      llmsTxt: result.data.llmstxt,
      llmsFullTxt: result.data.llmsfulltxt
    };
  }
};
```

#### 客户端 (UI)

**CheckRow 组件** - 在失败的检查项旁边显示"生成"按钮：

```typescript
function CheckRow({ check, auditUrl }) {
  const fixFetcher = useFetcher();
  const canFix = !check.pass && (check.id === "llms_txt" || check.id === "llms_full_txt");

  return (
    <div>
      {/* 检查项内容 */}

      {canFix && (
        <fixFetcher.Form method="post">
          <input type="hidden" name="action" value="generate_llms_txt" />
          <input type="hidden" name="url" value={auditUrl} />
          <button type="submit">生成</button>
        </fixFetcher.Form>
      )}
    </div>
  );
}
```

**Index 组件** - 处理文件下载：

```typescript
export default function Index() {
  const fetcher = useFetcher();

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.action === "generate_llms_txt") {
      // 下载 llms.txt
      const blob1 = new Blob([fetcher.data.llmsTxt], { type: 'text/plain' });
      const url1 = URL.createObjectURL(blob1);
      const a1 = document.createElement('a');
      a1.href = url1;
      a1.download = 'llms.txt';
      a1.click();

      // 下载 llms-full.txt (延迟 500ms)
      setTimeout(() => {
        const blob2 = new Blob([fetcher.data.llmsFullTxt], { type: 'text/plain' });
        // ... 同样的下载逻辑
      }, 500);
    }
  }, [fetcher.data]);
}
```

## 使用流程

### 1. 配置 API Key

在 `.env` 文件中添加 Firecrawl API Key：

```bash
FIRECRAWL_API_KEY=your_api_key_here
```

获取 API Key：访问 [Firecrawl](https://firecrawl.dev/) 注册账号。

### 2. 用户操作流程

1. 用户在 OptiGEO app 中输入网站 URL
2. 点击 "Run Audit" 运行审计
3. 如果检测到缺少 `llms.txt` 或 `llms-full.txt`
4. 在对应的检查项旁边会显示"生成"按钮
5. 点击"生成"按钮
6. 系统自动爬取网站内容并生成文件
7. 自动下载 `llms.txt` 和 `llms-full.txt` 两个文件
8. 用户将这两个文件上传到网站根目录

### 3. 生成过程

```
用户点击"生成"
    ↓
发送 POST 请求到 action
    ↓
Firecrawl 爬取网站 (最多 50 个页面)
    ↓
使用 GPT-4-mini 处理和格式化内容
    ↓
生成 llms.txt (摘要) 和 llms-full.txt (完整内容)
    ↓
返回文件内容到前端
    ↓
自动触发浏览器下载
```

## 技术特点

### 1. 专业的内容生成

- 使用 Firecrawl 的专业爬虫，支持 JavaScript 渲染
- 内置 GPT-4-mini 进行内容整理和格式化
- 自动提取网站结构和关键信息
- 生成符合 llms.txt 标准的 Markdown 格式

### 2. 用户体验优化

- **按钮状态管理**: 生成中显示"生成中..."，禁用按钮
- **自动下载**: 生成完成后自动触发下载，无需手动操作
- **错误处理**: 清晰的错误提示（API Key 未配置、生成失败等）
- **非阻塞操作**: 使用独立的 `fixFetcher`，不影响主审计流程

### 3. 安全性

- API Key 存储在服务端环境变量中
- 不暴露给前端
- 通过 Shopify 认证保护 API 端点

## 限制和注意事项

### 1. 页面限制

- 免费版本限制爬取 50 个页面
- 如需更多页面，可以调整 `maxUrls` 参数

### 2. 生成时间

- 根据网站大小，生成时间约 10-60 秒
- 大型网站可能需要更长时间

### 3. API 成本

- Firecrawl 按使用量计费
- 建议添加缓存机制，避免重复生成

## 未来扩展

### 1. 缓存机制

```typescript
// 添加缓存，避免重复生成
const cacheKey = `llms_txt_${url}`;
const cached = await redis.get(cacheKey);
if (cached) return cached;

// 生成后缓存 24 小时
await redis.set(cacheKey, result, { ex: 86400 });
```

### 2. 批量修复

```typescript
// 一键修复所有失败的检查项
<button onClick={handleFixAll}>
  修复所有问题
</button>
```

### 3. 预览功能

```typescript
// 生成前预览内容
<button onClick={handlePreview}>
  预览 llms.txt
</button>
```

## 测试

### 本地测试

1. 启动开发服务器：
```bash
npm run dev
```

2. 访问 Shopify 提供的测试 URL

3. 输入测试网站 URL（如 `https://www.meimeitea.com/`）

4. 运行审计，点击"生成"按钮

5. 检查下载的文件内容

### 生产部署

```bash
# 设置生产环境变量
shopify app env set FIRECRAWL_API_KEY=your_production_key

# 部署
shopify app deploy
```

## 总结

这个实现提供了专业、用户友好的一键生成 llms.txt 功能，使用业界最佳实践（Firecrawl SDK），确保生成的文件质量高、格式标准，帮助用户快速优化网站的 AI 可发现性。
