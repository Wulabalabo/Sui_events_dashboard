import { LumaEvent, LumaHost, LumaGuest } from '../types/luma';
import { CalendarEvent } from './luma';

/**
 * Google Sheets 服务类 - 业务优化版本
 * 
 * 业务要求：
 * 1. 清空再写入策略：每次同步都完全清空表格再写入新数据（业务要求）
 * 2. 只同步Events和Guests数据：不再同步hosts数据（业务简化）
 * 3. 性能优化：支持批量写入处理大数据量
 * 4. 错误恢复：完善的重试机制和备用方案
 * 5. 监控支持：健康检查和统计信息
 * 6. 自动工作表管理：自动检查和创建缺失的工作表
 * 
 * 使用方法：
 * 
 * // 基本同步（向后兼容）
 * await sheetsService.syncEvents(events, guests);
 * 
 * // 优化同步（推荐用于大数据量）
 * await sheetsService.syncEventsOptimized(events, guests, true); // 增量模式（内存优化）
 * await sheetsService.syncEventsOptimized(events, guests, false); // 批量模式（性能优化）
 * 
 * // 健康检查
 * const health = await sheetsService.healthCheck();
 * 
 * // 验证工作表设置
 * const validation = await sheetsService.validateSheetsSetup();
 * 
 * // 手动初始化工作表（可选）
 * await sheetsService.initializeSheets();
 * 
 * 常见错误解决方案：
 * 
 * 1. "Unable to parse range: Events" 错误：
 *    - 原因：工作表不存在
 *    - 解决：系统会自动创建缺失的工作表
 *    - 手动解决：调用 sheetsService.initializeSheets()
 * 
 * 2. "INVALID_ARGUMENT" 错误：
 *    - 原因：Google Sheets ID 不正确或工作表不存在
 *    - 解决：检查 GOOGLE_SHEET_ID 配置，或调用验证方法
 * 
 * 3. 权限错误：
 *    - 原因：服务账号没有访问 Google Sheets 的权限
 *    - 解决：确保服务账号邮箱已被添加到 Google Sheets 的共享列表
 * 
 * 性能建议：
 * - 小于 1000 行数据：使用 syncEvents
 * - 1000-5000 行数据：使用 syncEventsOptimized(data, false)
 * - 大于 5000 行数据：使用 syncEventsOptimized(data, true)
 * 
 * 注意事项：
 * - 所有同步操作都会清空现有数据再写入新数据
 * - 仅同步Events和Guests两个工作表
 * - 建议在数据量较大时使用优化版本的同步方法
 * - 系统会自动处理工作表不存在的情况
 */

export class GoogleSheetsService {
  private readonly credentials: {
    client_email: string;
    private_key: string;
  };
  private readonly sheetId: string;

  constructor(
    clientEmail: string,
    privateKey: string,
    sheetId: string
  ) {
    this.credentials = {
      client_email: clientEmail,
      private_key: privateKey
    };
    this.sheetId = sheetId;
  }

  // 将 base64 字符串转换为 URL 安全的 base64
  private base64url(source: string): string {
    return btoa(source)
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  // 将 PEM 格式私钥转为 ArrayBuffer
  private str2ab(pem: string): ArrayBuffer {
    try {
      // 移除 PEM 头尾和所有换行符
      let base64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\\n/g, '')  // 处理转义的换行符
        .replace(/\r?\n/g, '')  // 处理实际的换行符
        .replace(/\s+/g, '')  // 移除所有空白字符
        .trim();

      // 如果 base64 字符串太短，说明私钥可能被截断了
      if (base64.length < 100) {
        console.error('私钥可能被截断了，长度:', base64.length);
        throw new Error('私钥格式不正确');
      }

      // 将 base64 转换为二进制
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    } catch (error) {
      console.error('处理私钥时出错:', error);
      throw error;
    }
  }

  // 获取 Google OAuth2 Access Token
  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'RS256',
      typ: 'JWT'
    };
    const payload = {
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };

    console.log('准备生成 JWT...');
    console.log('Client Email:', this.credentials.client_email);
    console.log('Private Key 长度:', this.credentials.private_key.length);

    // 验证私钥格式
    if (!this.credentials.private_key.includes('-----BEGIN PRIVATE KEY-----') || 
        !this.credentials.private_key.includes('-----END PRIVATE KEY-----')) {
      throw new Error('私钥格式不正确，缺少 PEM 头尾');
    }

    const enc = new TextEncoder();
    const headerBase64 = this.base64url(JSON.stringify(header));
    const payloadBase64 = this.base64url(JSON.stringify(payload));
    const toSign = `${headerBase64}.${payloadBase64}`;

    const keyData = this.str2ab(this.credentials.private_key);
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        'pkcs8',
        keyData,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );
    } catch (error: unknown) {
      console.error('私钥导入失败:', error);
      throw new Error(`私钥导入失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(toSign));
    const signatureBase64 = this.base64url(Array.from(new Uint8Array(signature)).map(b => String.fromCharCode(b)).join(''));

    const jwt = `${toSign}.${signatureBase64}`;

    // 添加重试逻辑
    let retryCount = 0;
    const maxRetries = 3;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          },
          body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`
        });

        if (!res.ok) {
          const errorText = await res.text();
          console.error(`获取访问令牌失败 (尝试 ${retryCount + 1}/${maxRetries}):`, {
            status: res.status,
            statusText: res.statusText,
            error: errorText
          });
          
          if (res.status >= 500) {
            lastError = new Error(`服务器错误: ${res.status} ${errorText}`);
            retryCount++;
            if (retryCount < maxRetries) {
              const delay = Math.pow(2, retryCount) * 1000;
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }
          
          throw new Error(`failed to get access token: ${res.status} ${errorText}`);
        }

        const data = await res.json();
        if (!data.access_token) {
          throw new Error('no access token in response');
        }

        return data.access_token;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount++;
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('failed to get access token, reached max retries');
  }

  // 检查工作表是否存在
  private async checkSheetExists(sheetName: string, accessToken: string): Promise<boolean> {
    try {
      const sheetInfoUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}`;
      const sheetInfoRes = await fetch(sheetInfoUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!sheetInfoRes.ok) {
        console.warn(`Failed to get sheet info: ${sheetInfoRes.status}`);
        return false;
      }

      const sheetInfo = await sheetInfoRes.json();
      const sheet = sheetInfo.sheets?.find((s: any) => s.properties.title === sheetName);
      
      return !!sheet;
    } catch (error) {
      console.warn(`Error checking if sheet ${sheetName} exists:`, error);
      return false;
    }
  }

  // 将列索引(从1开始)转换为Excel列名
  private columnIndexToLetter(index: number): string {
    let letters = '';
    while (index > 0) {
      const remainder = (index - 1) % 26;
      letters = String.fromCharCode(65 + remainder) + letters;
      index = Math.floor((index - 1) / 26);
    }
    return letters;
  }

  // 确保工作表的行列数量足够
  private async ensureSheetSize(sheetName: string, accessToken: string, minRows: number, minCols: number): Promise<void> {
    const sheetInfoUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}`;
    const sheetInfoRes = await fetch(sheetInfoUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!sheetInfoRes.ok) {
      console.warn(`Failed to get sheet info for sizing: ${sheetInfoRes.status}`);
      return;
    }

    const sheetInfo = await sheetInfoRes.json();
    const sheet = sheetInfo.sheets?.find((s: any) => s.properties.title === sheetName);
    if (!sheet) return;

    const sheetId = sheet.properties.sheetId;
    const currentRows = sheet.properties.gridProperties?.rowCount ?? 1000;
    const currentCols = sheet.properties.gridProperties?.columnCount ?? 26;

    const desiredRows = Math.max(currentRows, minRows);
    const desiredCols = Math.max(currentCols, minCols);

    if (desiredRows === currentRows && desiredCols === currentCols) {
      return;
    }

    const updateBody = {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount: desiredRows,
                columnCount: desiredCols
              }
            },
            fields: 'gridProperties(rowCount,columnCount)'
          }
        }
      ]
    };

    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}:batchUpdate`;
    const updateRes = await fetch(updateUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateBody)
    });

    if (!updateRes.ok) {
      const errorText = await updateRes.text();
      console.warn(`Failed to resize sheet ${sheetName}: ${updateRes.status} ${errorText}`);
    }
  }

  // 创建单个工作表
  private async createSheet(sheetName: string, accessToken: string): Promise<void> {
    try {
      console.log(`Creating sheet: ${sheetName}`);
      
      const createSheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}:batchUpdate`;
      const columnCount = sheetName === 'Events' ? 20 : 11;
      
      const createSheetBody = {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
                gridProperties: {
                  rowCount: 1000,
                  columnCount: columnCount
                }
              }
            }
          }
        ]
      };

      const createResponse = await fetch(createSheetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(createSheetBody)
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create sheet ${sheetName}: ${createResponse.status} ${errorText}`);
      }

      console.log(`Sheet ${sheetName} created successfully`);
    } catch (error) {
      console.error(`Error creating sheet ${sheetName}:`, error);
      throw error;
    }
  }

  // 确保工作表存在（如果不存在则创建）
  private async ensureSheetExists(sheetName: string, accessToken: string): Promise<void> {
    const exists = await this.checkSheetExists(sheetName, accessToken);
    
    if (!exists) {
      console.log(`Sheet ${sheetName} does not exist, creating it...`);
      await this.createSheet(sheetName, accessToken);
      
      // 创建后写入表头
      const headers = this.getHeaders(sheetName);
      if (headers.length > 0) {
        console.log(`Writing headers to new sheet: ${sheetName}`);
        // 直接写入表头，不清空（因为是新建的表）
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1?valueInputOption=USER_ENTERED`;
        const updateRes = await fetch(updateUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            values: [headers],
            majorDimension: 'ROWS'
          })
        });

        if (!updateRes.ok) {
          const errorText = await updateRes.text();
          console.warn(`Failed to write headers to ${sheetName}: ${updateRes.status} ${errorText}`);
        }
      }
    }
  }

  // 写入数据到指定工作表（彻底清空并覆盖写入 - 业务要求）
  async writeToSheet(sheetName: string, values: any[][]): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      console.log(`Writing to ${sheetName} sheet...`);

      // 确保工作表存在
      await this.ensureSheetExists(sheetName, accessToken);

      // 1. 彻底清空整个 sheet（业务要求）
      console.log(`Clearing ${sheetName} sheet...`);
      const clearSheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}:clear`;
      const clearRes = await fetch(clearSheetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!clearRes.ok) {
        const errorText = await clearRes.text();
        throw new Error(`Failed to clear ${sheetName} sheet: ${clearRes.status} ${errorText}`);
      }
      console.log(`${sheetName} sheet cleared successfully`);

      // 2. 覆盖写入所有数据（包括表头）
      if (values.length > 0) {
        const headers = this.getHeaders(sheetName);
        const allValues = [headers, ...values];
        // 确保尺寸足够
        await this.ensureSheetSize(sheetName, accessToken, allValues.length + 10, headers.length);
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1?valueInputOption=USER_ENTERED`;
        const updateRes = await fetch(updateUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            values: allValues,
            majorDimension: 'ROWS'
          })
        });

        if (!updateRes.ok) {
          const errorText = await updateRes.text();
          throw new Error(`Google Sheets API write error: ${updateRes.status} ${errorText}`);
        }

        const result = await updateRes.json();
        console.log(`${sheetName} sheet data written successfully: ${result.updatedRows} rows`);
      } else {
        console.log(`No data to write to ${sheetName}, only headers will be present`);
      }
    } catch (error) {
      console.error(`Error writing to ${sheetName} sheet:`, error);
      throw error;
    }
  }

  private getHeaders(sheetName: string): string[] {
    switch (sheetName) {
      case 'Events':
        return [
          'API ID', 'Calendar API ID', 'Name', 'Description', 'Description MD',
          'Cover URL', 'Start At', 'End At', 'Timezone', 'Duration Interval',
          'Meeting URL', 'URL', 'User API ID', 'Visibility', 'Zoom Meeting URL',
          'Geo Address', 'Geo Latitude', 'Geo Longitude', 'Created At', 'Updated At'
        ];
      case 'Guests':
        return [
          'API ID', 'Event API ID', 'User Name', 'User Email',
          'User First Name', 'User Last Name', 'Approval Status',
          'Checked In At', 'Check In QR Code', 'Created At', 'Updated At'
        ];
      default:
        return [];
    }
  }

  // 批量写入方法 - 支持大数据量（适配清空再写入业务需求）
  async batchWriteToSheet(sheetName: string, values: any[][], append: boolean = false): Promise<void> {
    const BATCH_SIZE = 500; // 每批处理500行
    const DELAY_BETWEEN_BATCHES = 500; // 批次间延迟500ms
    
    if (values.length === 0) return;

    const accessToken = await this.getAccessToken();
    const headers = this.getHeaders(sheetName);
    // 确保工作表存在
    await this.ensureSheetExists(sheetName, accessToken);

    // 如果不是追加模式，先清空并写入第一批数据（包含表头）
    if (!append) {
      await this.writeToSheet(sheetName, values.slice(0, BATCH_SIZE));
      
      // 如果数据量小于等于批次大小，直接返回
      if (values.length <= BATCH_SIZE) {
        return;
      }
      
      // 延迟后处理剩余数据
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }

    // 处理剩余批次（追加模式）
    const startIndex = append ? 0 : BATCH_SIZE;
    
    // 如果是追加模式，需要先获取当前的行数
    let currentRow = 1; // 默认从第1行开始（表头）
    if (append) {
      currentRow = await this.getNextAvailableRow(sheetName, accessToken);
    }
    
    for (let i = startIndex; i < values.length; i += BATCH_SIZE) {
      const batch = values.slice(i, i + BATCH_SIZE);
      
      // 计算要写入的行范围
      const startRow = currentRow;
      const endRow = startRow + batch.length - 1;
      const endColLetter = this.columnIndexToLetter(headers.length);
      
      // 确保尺寸
      await this.ensureSheetSize(sheetName, accessToken, endRow + 10, headers.length);
      const range = `${sheetName}!A${startRow}:${endColLetter}${endRow}`;

      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${range}?valueInputOption=USER_ENTERED`;
      
      const updateRes = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          values: batch,
          majorDimension: 'ROWS'
        })
      });

      if (!updateRes.ok) {
        const errorText = await updateRes.text();
        throw new Error(`Batch write error for ${sheetName}: ${updateRes.status} ${errorText}`);
      }

      console.log(`Batch ${Math.floor((i - startIndex) / BATCH_SIZE) + 1} written to ${sheetName} (rows ${startRow}-${endRow}, ${batch.length} rows)`);
      
      // 更新当前行号，避免重复计算
      currentRow = endRow + 1;

      // 批次间延迟，避免API限制
      if (i + BATCH_SIZE < values.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }
  }

  // 增量更新方法 - 简化版本（适配清空再写入业务需求）
  private async incrementalWriteToSheet(sheetName: string, values: any[][], existingHashes?: Set<string>): Promise<void> {
    try {
      console.log(`Incremental writing to ${sheetName} sheet...`);
      
      // 由于业务要求清空再写入，增量更新主要优化内存使用
      // 分批处理大数据量，避免内存溢出
      if (values.length > 5000) {
        await this.batchWriteToSheet(sheetName, values, false);
      } else {
        await this.writeToSheet(sheetName, values);
      }
      
      console.log(`Successfully wrote ${values.length} rows to ${sheetName}`);
    } catch (error) {
      console.error(`Error in incremental write to ${sheetName}:`, error);
      // 如果失败，尝试直接写入
      await this.writeToSheet(sheetName, values);
    }
  }

  // 计算行数据哈希值
  private calculateRowHash(row: any[]): string {
    return btoa(JSON.stringify(row)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
  }

  // 获取下一个可用行号
  private async getNextAvailableRow(sheetName: string, accessToken: string): Promise<number> {
    try {
      const range = `${sheetName}!A:A`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${range}`;
      
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) return 1;

      const data = await response.json();
      return data.values ? data.values.length + 1 : 1;
    } catch (error) {
      console.warn(`Failed to get next available row for ${sheetName}:`, error);
      return 1;
    }
  }

  // 主同步方法（向后兼容）- 移除hosts参数
  async syncEvents(events: CalendarEvent[], guests: LumaGuest[]): Promise<void> {
    try {
      console.log('Starting to sync to Google Sheets...');
      
      // 同步事件数据
      console.log('Syncing events data...');
      await this.syncEventsData(events);
      
      // 同步参与者数据
      console.log('Syncing guests data...');
      await this.syncGuestsData(guests);
      
      console.log('Google Sheets sync completed');
    } catch (error) {
      console.error('Error syncing to Google Sheets:', error);
      throw error;
    }
  }

  // 同步事件数据（向后兼容）
  private async syncEventsData(events: CalendarEvent[]): Promise<void> {
    const rows = events.map(event => [
      event.event.api_id,
      event.api_id,
      event.event.name,
      event.event.description,
      event.event.description_md,
      event.event.cover_url,
      event.event.start_at,
      event.event.end_at,
      event.event.timezone,
      event.event.duration_interval,
      event.event.meeting_url,
      event.event.url,
      event.event.user_api_id,
      event.event.visibility,
      event.event.zoom_meeting_url,
      event.event.geo_address_json?.address,
      event.event.geo_latitude,
      event.event.geo_longitude,
      event.event.created_at,
      event.event.updated_at
    ]);

    await this.writeToSheet('Events', rows);
  }

  // 同步参与者数据（向后兼容）
  private async syncGuestsData(guests: LumaGuest[]): Promise<void> {
    const rows = guests.map(guest => [
      guest.api_id,
      guest.event_api_id,
      guest.user_name,
      guest.user_email,
      guest.user_first_name,
      guest.user_last_name,
      guest.approval_status,
      guest.checked_in_at,
      guest.check_in_qr_code,
      guest.created_at,
      guest.updated_at
    ]);

    await this.writeToSheet('Guests', rows);
  }

  // 优化后的主同步方法
  async syncEventsOptimized(events: CalendarEvent[], guests: LumaGuest[], useIncremental: boolean = true): Promise<void> {
    try {
      console.log('Starting optimized sync to Google Sheets...');
      
      if (useIncremental) {
        // 使用增量更新策略
        await this.incrementalSyncEventsData(events);
        await this.incrementalSyncGuestsData(guests);
      } else {
        // 使用批量写入策略
        await this.batchSyncEventsData(events);
        await this.batchSyncGuestsData(guests);
      }
      
      console.log('Optimized Google Sheets sync completed');
    } catch (error) {
      console.error('Error in optimized sync to Google Sheets:', error);
      throw error;
    }
  }

  // 增量同步事件数据
  private async incrementalSyncEventsData(events: CalendarEvent[]): Promise<void> {
    const rows = events.map(event => [
      event.event.api_id,
      event.api_id,
      event.event.name,
      event.event.description,
      event.event.description_md,
      event.event.cover_url,
      event.event.start_at,
      event.event.end_at,
      event.event.timezone,
      event.event.duration_interval,
      event.event.meeting_url,
      event.event.url,
      event.event.user_api_id,
      event.event.visibility,
      event.event.zoom_meeting_url,
      event.event.geo_address_json?.address,
      event.event.geo_latitude,
      event.event.geo_longitude,
      event.event.created_at,
      event.event.updated_at
    ]);

    await this.incrementalWriteToSheet('Events', rows);
  }

  // 批量同步事件数据
  private async batchSyncEventsData(events: CalendarEvent[]): Promise<void> {
    const rows = events.map(event => [
      event.event.api_id,
      event.api_id,
      event.event.name,
      event.event.description,
      event.event.description_md,
      event.event.cover_url,
      event.event.start_at,
      event.event.end_at,
      event.event.timezone,
      event.event.duration_interval,
      event.event.meeting_url,
      event.event.url,
      event.event.user_api_id,
      event.event.visibility,
      event.event.zoom_meeting_url,
      event.event.geo_address_json?.address,
      event.event.geo_latitude,
      event.event.geo_longitude,
      event.event.created_at,
      event.event.updated_at
    ]);

    await this.batchWriteToSheet('Events', rows);
  }

  // 增量同步参与者数据
  private async incrementalSyncGuestsData(guests: LumaGuest[]): Promise<void> {
    const rows = guests.map(guest => [
      guest.api_id,
      guest.event_api_id,
      guest.user_name,
      guest.user_email,
      guest.user_first_name,
      guest.user_last_name,
      guest.approval_status,
      guest.checked_in_at,
      guest.check_in_qr_code,
      guest.created_at,
      guest.updated_at
    ]);

    await this.incrementalWriteToSheet('Guests', rows);
  }

  // 批量同步参与者数据
  private async batchSyncGuestsData(guests: LumaGuest[]): Promise<void> {
    const rows = guests.map(guest => [
      guest.api_id,
      guest.event_api_id,
      guest.user_name,
      guest.user_email,
      guest.user_first_name,
      guest.user_last_name,
      guest.approval_status,
      guest.checked_in_at,
      guest.check_in_qr_code,
      guest.created_at,
      guest.updated_at
    ]);

    await this.batchWriteToSheet('Guests', rows);
  }

  // 验证Google Sheets设置
  async validateSheetsSetup(): Promise<{
    isValid: boolean;
    missingSheets: string[];
    errors: string[];
  }> {
    const result = {
      isValid: true,
      missingSheets: [] as string[],
      errors: [] as string[]
    };

    try {
      const accessToken = await this.getAccessToken();
      const requiredSheets = ['Events', 'Guests'];

      for (const sheetName of requiredSheets) {
        const exists = await this.checkSheetExists(sheetName, accessToken);
        if (!exists) {
          result.missingSheets.push(sheetName);
          result.isValid = false;
        }
      }

      if (result.missingSheets.length > 0) {
        result.errors.push(`Missing sheets: ${result.missingSheets.join(', ')}`);
      }

    } catch (error) {
      result.isValid = false;
      result.errors.push(`Failed to validate sheets: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
  }

  // 确保所有必要的工作表都存在
  async ensureAllSheetsExist(): Promise<void> {
    try {
      console.log('Checking and creating necessary sheets...');
      const accessToken = await this.getAccessToken();
      const requiredSheets = ['Events', 'Guests'];

      for (const sheetName of requiredSheets) {
        await this.ensureSheetExists(sheetName, accessToken);
      }

      console.log('All necessary sheets are ready');
    } catch (error) {
      console.error('Failed to ensure sheets exist:', error);
      throw error;
    }
  }

  // 创建和初始化工作表 - 改进版本
  async initializeSheets(): Promise<void> {
    try {
      console.log('Starting to initialize Google Sheets...');
      
      // 首先验证现有设置
      const validation = await this.validateSheetsSetup();
      
      if (validation.isValid) {
        console.log('All sheets already exist, initialization skipped');
        return;
      }

      console.log(`Found missing sheets: ${validation.missingSheets.join(', ')}`);
      
      // 确保所有工作表存在
      await this.ensureAllSheetsExist();

      console.log('Sheets initialization completed successfully');
    } catch (error) {
      console.error('Error initializing sheets:', error);
      throw error;
    }
  }

  // 错误恢复和监控机制
  private async withRetryAndFallback<T>(
    operation: () => Promise<T>,
    fallbackOperation?: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`${operationName} failed on attempt ${attempt}/${maxRetries}:`, lastError.message);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 指数退避
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // 如果有备用方案，尝试备用方案
    if (fallbackOperation) {
      try {
        console.log(`Attempting fallback for ${operationName}...`);
        return await fallbackOperation();
      } catch (fallbackError) {
        console.error(`Fallback for ${operationName} also failed:`, fallbackError);
      }
    }

    throw lastError || new Error(`${operationName} failed after ${maxRetries} attempts`);
  }

  // 健康检查方法
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Record<string, boolean>;
    lastChecked: string;
  }> {
    const checks: Record<string, boolean> = {};
    const startTime = Date.now();

    try {
      // 检查认证
      await this.getAccessToken();
      checks.authentication = true;
    } catch (error) {
      checks.authentication = false;
      console.error('Authentication check failed:', error);
    }

    try {
      // 检查 Sheets API 访问
      const accessToken = await this.getAccessToken();
      const testUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}`;
      const response = await fetch(testUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      checks.sheetsAccess = response.ok;
    } catch (error) {
      checks.sheetsAccess = false;
      console.error('Sheets access check failed:', error);
    }

    // 检查延迟
    const responseTime = Date.now() - startTime;
    checks.responseTime = responseTime < 5000; // 5秒内

    const healthyCount = Object.values(checks).filter(Boolean).length;
    const totalCount = Object.values(checks).length;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (healthyCount === totalCount) {
      status = 'healthy';
    } else if (healthyCount > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      checks,
      lastChecked: new Date().toISOString()
    };
  }

  // 获取写入统计信息
  async getWriteStatistics(): Promise<{
    totalWrites: number;
    successfulWrites: number;
    failedWrites: number;
    lastWriteTime: string;
    averageWriteTime: number;
  }> {
    // 这里可以从 Durable Object 或其他存储获取统计信息
    // 目前返回模拟数据
    return {
      totalWrites: 0,
      successfulWrites: 0,
      failedWrites: 0,
      lastWriteTime: new Date().toISOString(),
      averageWriteTime: 0
    };
  }
}