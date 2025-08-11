/**
 * Google Sheets 配置管理 - 业务优化版本
 * 
 * 业务要求：
 * 1. 清空再写入策略：每次同步都完全清空表格再写入新数据
 * 2. 只同步Events和Guests数据：不再同步hosts数据
 * 3. 优化大数据量处理性能
 */

export interface SheetsConfig {
  // 批量写入配置
  batchWriteConfig: {
    batchSize: number;
    delayBetweenBatches: number;
    maxRetries: number;
    retryDelay: number;
    clearBeforeWrite: boolean; // 业务要求：清空再写入
  };
  
  // 数据表配置
  sheetsConfig: {
    enabledSheets: string[]; // 只启用Events和Guests
    maxRowsPerSheet: number;
  };
  
  // 性能配置
  performanceConfig: {
    requestTimeout: number;
    maxConcurrentRequests: number;
    rateLimitPerMinute: number;
    memoryOptimizationThreshold: number; // 超过此阈值启用内存优化
  };
  
  // 错误恢复配置
  errorRecoveryConfig: {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    enableFallback: boolean;
  };
  
  // 监控配置
  monitoringConfig: {
    healthCheckInterval: number;
    enableStatistics: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}

export const DEFAULT_SHEETS_CONFIG: SheetsConfig = {
  batchWriteConfig: {
    batchSize: 1000,
    delayBetweenBatches: 500,
    maxRetries: 3,
    retryDelay: 1000,
    clearBeforeWrite: true // 业务要求
  },
  
  sheetsConfig: {
    enabledSheets: ['Events', 'Guests'], // 只启用这两个表
    maxRowsPerSheet: 100000
  },
  
  performanceConfig: {
    requestTimeout: 30000,
    maxConcurrentRequests: 5,
    rateLimitPerMinute: 100,
    memoryOptimizationThreshold: 5000 // 超过5000行启用内存优化
  },
  
  errorRecoveryConfig: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    enableFallback: true
  },
  
  monitoringConfig: {
    healthCheckInterval: 300000, // 5分钟
    enableStatistics: true,
    logLevel: 'info'
  }
};

// 根据数据量自动调整配置
export function getOptimalConfig(eventsCount: number, guestsCount: number): SheetsConfig {
  const config = { ...DEFAULT_SHEETS_CONFIG };
  const totalRows = eventsCount + guestsCount;
  
  if (totalRows < 1000) {
    // 小数据量：快速写入
    config.batchWriteConfig.batchSize = 500;
    config.batchWriteConfig.delayBetweenBatches = 200;
    config.performanceConfig.maxConcurrentRequests = 3;
  } else if (totalRows < 5000) {
    // 中等数据量：平衡性能和稳定性
    config.batchWriteConfig.batchSize = 1000;
    config.batchWriteConfig.delayBetweenBatches = 500;
    config.performanceConfig.maxConcurrentRequests = 5;
  } else {
    // 大数据量：优先稳定性和内存效率
    config.batchWriteConfig.batchSize = 500;
    config.batchWriteConfig.delayBetweenBatches = 1000;
    config.performanceConfig.maxConcurrentRequests = 3;
    config.performanceConfig.requestTimeout = 60000; // 增加超时时间
  }
  
  return config;
}

// 验证配置有效性
export function validateConfig(config: SheetsConfig): string[] {
  const errors: string[] = [];
  
  if (config.batchWriteConfig.batchSize <= 0) {
    errors.push('batchSize must be positive');
  }
  
  if (config.batchWriteConfig.delayBetweenBatches < 0) {
    errors.push('delayBetweenBatches must be non-negative');
  }
  
  if (config.performanceConfig.requestTimeout <= 0) {
    errors.push('requestTimeout must be positive');
  }
  
  if (config.performanceConfig.maxConcurrentRequests <= 0) {
    errors.push('maxConcurrentRequests must be positive');
  }
  
  // 验证启用的表格
  const validSheets = ['Events', 'Guests'];
  const invalidSheets = config.sheetsConfig.enabledSheets.filter(
    sheet => !validSheets.includes(sheet)
  );
  if (invalidSheets.length > 0) {
    errors.push(`Invalid sheets: ${invalidSheets.join(', ')}. Valid sheets are: ${validSheets.join(', ')}`);
  }
  
  return errors;
} 