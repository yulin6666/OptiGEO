# 美美茶测试网站

这是一个用于测试 GEO (Generative Engine Optimization) 优化效果的测试网站。

## 包含的文件

- `index.html` - 主页面，包含完整的 SEO 优化
- `llms.txt` - AI 模型简要信息文件
- `llms-full.txt` - AI 模型完整信息文件
- `robots.txt` - 搜索引擎爬虫配置
- `sitemap.xml` - 网站地图

## 本地运行

```bash
# 使用 Python 启动本地服务器
python3 -m http.server 8000

# 或使用 npm
npm run dev
```

然后访问 http://localhost:8000

## 部署选项

### 1. Vercel (推荐)
```bash
npm install -g vercel
vercel
```

### 2. Netlify
拖拽整个文件夹到 https://app.netlify.com/drop

### 3. GitHub Pages
1. 创建 GitHub 仓库
2. 上传所有文件
3. 在 Settings > Pages 中启用 GitHub Pages

## 使用 GEO 审计工具测试

部署后，在 OptiGEO Shopify app 中输入你的测试网址，查看优化效果。
