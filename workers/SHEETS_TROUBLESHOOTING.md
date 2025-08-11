# Google Sheets 同步服务 - 故障排除指南

## 🚨 常见错误及解决方案

### 1. "Unable to parse range: Events" 错误

**错误信息：**
```
Failed to clear Events sheet: 400 {
  "error": {
    "code": 400,
    "message": "Unable to parse range: Events",
    "status": "INVALID_ARGUMENT"
  }
}
```

**原因：** Google Sheets中不存在名为"Events"的工作表

**解决方案：**

#### 自动解决（推荐）
系统现在会自动检测并创建缺失的工作表。重新启动同步即可。

#### 手动解决
1. **通过Web界面：**
   - 访问同步状态页面
   - 点击 "Validate Sheets" 按钮检查工作表状态
   - 点击 "Initialize Sheets" 按钮创建缺失的工作表

2. **通过API：**
   ```bash
   # 验证工作表状态
   curl -X GET "https://your-worker.your-account.workers.dev/api/sync/validate"
   
   # 初始化工作表
   curl -X POST "https://your-worker.your-account.workers.dev/api/sync/initialize"
   ```

3. **手动创建工作表：**
   - 打开Google Sheets文档
   - 创建名为"Events"和"Guests"的工作表
   - 确保工作表名称完全匹配

### 2. "PERMISSION_DENIED" 错误

**原因：** 服务账号没有访问Google Sheets的权限

**解决方案：**
1. 确保服务账号邮箱（通常是 `xxx@xxx.iam.gserviceaccount.com`）已被添加到Google Sheets的共享列表
2. 给予服务账号"编辑者"权限
3. 检查Google Cloud项目中的Google Sheets API是否已启用

### 3. "Invalid credentials" 错误

**原因：** Google服务账号配置不正确

**解决方案：**
1. 检查环境变量：
   - `GOOGLE_CLIENT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
   - `GOOGLE_SHEET_ID`
2. 确保私钥格式正确（包含完整的PEM头尾）
3. 验证Google Sheets ID是否正确

## 🔧 API端点

### 验证工作表设置
```bash
GET /api/sync/validate
```

**响应示例：**
```json
{
  "success": true,
  "validation": {
    "isValid": false,
    "missingSheets": ["Events"],
    "errors": ["Missing sheets: Events"]
  }
}
```

### 初始化工作表
```bash
POST /api/sync/initialize
```

**响应示例：**
```json
{
  "success": true,
  "message": "Sheets initialized successfully"
}
```

### 健康检查
```bash
GET /api/sync/health
```

**响应示例：**
```json
{
  "success": true,
  "health": {
    "status": "healthy",
    "checks": {
      "authentication": true,
      "sheetsAccess": true,
      "responseTime": true
    },
    "lastChecked": "2024-01-01T12:00:00.000Z"
  }
}
```

## 📋 使用指南

### 基本使用流程

1. **验证环境：**
   ```bash
   curl -X GET "https://your-worker.your-account.workers.dev/api/sync/validate"
   ```

2. **初始化（如需要）：**
   ```bash
   curl -X POST "https://your-worker.your-account.workers.dev/api/sync/initialize"
   ```

3. **开始同步：**
   ```bash
   curl -X POST "https://your-worker.your-account.workers.dev/api/sync/start" \
     -H "Content-Type: application/json" \
     -d '{"after": "2024-01-01T00:00:00Z", "before": "2024-12-31T23:59:59Z"}'
   ```

### Web界面使用

访问 `https://your-worker.your-account.workers.dev/` 可以看到管理界面，包含：

- **同步控制：** 启动、停止、重置同步
- **系统验证：** 验证工作表、健康检查
- **工作表管理：** 初始化缺失的工作表
- **实时状态：** 同步进度和日志

### 代码集成

```typescript
// 使用基本同步（小数据量）
await sheetsService.syncEvents(events, guests);

// 使用优化同步（大数据量）
await sheetsService.syncEventsOptimized(events, guests, true); // 内存优化
await sheetsService.syncEventsOptimized(events, guests, false); // 性能优化

// 验证工作表设置
const validation = await sheetsService.validateSheetsSetup();
if (!validation.isValid) {
  await sheetsService.initializeSheets();
}

// 健康检查
const health = await sheetsService.healthCheck();
```

## ⚡ 性能建议

### 数据量指导

| 数据量 | 推荐方法 | 原因 |
|--------|----------|------|
| < 1,000 行 | `syncEvents()` | 简单直接，速度快 |
| 1,000-5,000 行 | `syncEventsOptimized(data, false)` | 批量处理，避免超时 |
| > 5,000 行 | `syncEventsOptimized(data, true)` | 内存优化，分批处理 |

### 最佳实践

1. **定期验证：** 在同步前验证工作表状态
2. **错误处理：** 实现适当的重试和错误恢复
3. **监控健康：** 定期进行健康检查
4. **日志记录：** 保留详细的操作日志

## 🔍 故障诊断步骤

### 1. 快速诊断
```bash
# 1. 检查健康状态
curl -X GET "https://your-worker.your-account.workers.dev/api/sync/health"

# 2. 验证工作表
curl -X GET "https://your-worker.your-account.workers.dev/api/sync/validate"

# 3. 查看同步状态
curl -X GET "https://your-worker.your-account.workers.dev/api/sync/status"
```

### 2. 常见问题检查清单

- [ ] Google Sheets ID是否正确
- [ ] 服务账号是否有访问权限
- [ ] 环境变量是否正确配置
- [ ] 必要的工作表是否存在
- [ ] 网络连接是否正常

### 3. 日志分析

系统会记录详细的操作日志，包括：
- 环境验证过程
- 工作表创建过程
- 数据写入进度
- 错误详情和重试情况

## 📧 获取支持

如果遇到无法解决的问题：

1. 收集错误日志和状态信息
2. 记录重现问题的步骤
3. 检查Google Cloud Console中的API使用情况
4. 验证权限配置

通过这个指南，您应该能够解决大部分Google Sheets同步相关的问题。系统现在具备了自动诊断和修复能力，大大减少了手动干预的需要。 