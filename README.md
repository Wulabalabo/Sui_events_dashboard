# Luma 活动数据可视化系统

这是一个用于收集和可视化 Luma 活动数据的系统。该系统自动收集我方 Luma 账号主办的活动数据，并通过可视化工具展示全球参与分布和趋势图表。

## 功能特点

- 自动收集 Luma 活动数据
- 提取参与者信息
- 数据存储与可视化
- 实时数据更新
- 数据导出功能
- 管理后台

## 技术栈

- 前端：Next.js + TypeScript
- 后端：Cloudflare Workers
- 数据库：Supabase (PostgreSQL)
- 可视化：Preset (Apache Superset)

## 环境要求

- Node.js 18+
- npm 或 yarn
- Supabase 账号
- Cloudflare 账号
- Luma Pro 账号

## 快速开始

1. 克隆项目
```bash
git clone [项目地址]
cd luma-events-dashboard
```

2. 安装依赖
```bash
npm install
# 或
yarn install
```

3. 配置环境变量
创建 `.env.local` 文件并添加以下配置：
```
NEXT_PUBLIC_SUPABASE_URL=你的_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=你的_SUPABASE_ANON_KEY
LUMA_API_KEY=你的_LUMA_API_KEY
```

4. 启动开发服务器
```bash
npm run dev
# 或
yarn dev
```

## 项目结构

```
├── src/
│   ├── app/              # Next.js 应用路由
│   ├── components/       # React 组件
│   ├── lib/             # 工具函数和配置
│   └── types/           # TypeScript 类型定义
├── workers/             # Cloudflare Workers
└── public/             # 静态资源
```

## 数据流程

1. Cloudflare Worker 定时从 Luma API 获取数据
2. 数据经过处理后存入 Supabase
3. Preset 从 Supabase 读取数据并生成可视化图表

## 安全说明

- API 密钥存储在 Cloudflare Worker 环境变量中
- 敏感数据经过脱敏处理
- 仅展示聚合数据，保护用户隐私

## 贡献指南

欢迎提交 Issue 和 Pull Request。

## 许可证

MIT 