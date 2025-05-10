import { LumaEvent, LumaHost, LumaGuest } from '../types/luma';
import { CalendarEvent } from './luma';

export class GoogleSheetsService {
  private clientEmail: string;
  private privateKey: string;
  private sheetId: string;

  constructor(clientEmail: string, privateKey: string, sheetId: string) {
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
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
      iss: this.clientEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };

    console.log('准备生成 JWT...');
    console.log('Client Email:', this.clientEmail);
    console.log('Private Key 长度:', this.privateKey.length);
    console.log('Private Key 前50个字符:', this.privateKey.substring(0, 50));

    // 验证私钥格式
    if (!this.privateKey.includes('-----BEGIN PRIVATE KEY-----') || 
        !this.privateKey.includes('-----END PRIVATE KEY-----')) {
      throw new Error('私钥格式不正确，缺少 PEM 头尾');
    }

    const enc = new TextEncoder();
    const headerBase64 = this.base64url(JSON.stringify(header));
    const payloadBase64 = this.base64url(JSON.stringify(payload));
    const toSign = `${headerBase64}.${payloadBase64}`;

    console.log('准备导入私钥...');
    const keyData = this.str2ab(this.privateKey);
    console.log('私钥数据长度:', keyData.byteLength);
    console.log('私钥数据前50个字节:', new Uint8Array(keyData.slice(0, 50)));

    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        'pkcs8',
        keyData,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );
      console.log('私钥导入成功');
    } catch (error: unknown) {
      console.error('私钥导入失败:', error);
      throw new Error(`私钥导入失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log('准备签名...');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(toSign));
    const signatureBase64 = this.base64url(Array.from(new Uint8Array(signature)).map(b => String.fromCharCode(b)).join(''));

    const jwt = `${toSign}.${signatureBase64}`;
    console.log('JWT 生成成功');
    console.log('JWT 长度:', jwt.length);
    console.log('JWT 前50个字符:', jwt.substring(0, 50));

    // 验证 JWT 格式
    const jwtParts = jwt.split('.');
    if (jwtParts.length !== 3) {
      throw new Error('JWT 格式不正确，应该包含三部分');
    }

    // 验证 JWT 各部分长度
    if (jwtParts[0].length < 10 || jwtParts[1].length < 10 || jwtParts[2].length < 10) {
      throw new Error('JWT 各部分长度不正确');
    }

    console.log('准备请求访问令牌...');
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const tokenBody = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`;
    
    console.log('Token URL:', tokenUrl);
    console.log('Token Body 长度:', tokenBody.length);
    console.log('Token Body 前50个字符:', tokenBody.substring(0, 50));

    // 添加重试逻辑
    let retryCount = 0;
    const maxRetries = 3;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        const res = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          },
          body: tokenBody
        });

        if (!res.ok) {
          const errorText = await res.text();
          console.error(`获取访问令牌失败 (尝试 ${retryCount + 1}/${maxRetries}):`, {
            status: res.status,
            statusText: res.statusText,
            error: errorText,
            headers: Object.fromEntries(res.headers.entries())
          });
          
          // 如果是服务器错误，等待后重试
          if (res.status >= 500) {
            lastError = new Error(`服务器错误: ${res.status} ${errorText}`);
            retryCount++;
            if (retryCount < maxRetries) {
              const delay = Math.pow(2, retryCount) * 1000; // 指数退避
              console.log(`等待 ${delay}ms 后重试...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }
          
          throw new Error(`获取访问令牌失败: ${res.status} ${errorText}`);
        }

        const data = await res.json();
        if (!data.access_token) {
          console.error('响应中没有访问令牌:', data);
          throw new Error('响应中没有访问令牌');
        }

        console.log('成功获取访问令牌');
        return data.access_token;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`获取访问令牌时发生错误 (尝试 ${retryCount + 1}/${maxRetries}):`, lastError);
        
        retryCount++;
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 1000; // 指数退避
          console.log(`等待 ${delay}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('获取访问令牌失败，已达到最大重试次数');
  }

  // 清除工作表数据
  private async clearSheet(accessToken: string): Promise<void> {
    try {
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/Sheet1!A1:Z1000:clear`;
      const response = await fetch(clearUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`清除工作表失败: ${response.status} ${errorText}`);
      }
      console.log('成功清除工作表数据');
    } catch (error) {
      console.error('清除工作表时发生错误:', error);
      throw error;
    }
  }

  // 写入数据到指定工作表
  private async writeToSheet(sheetName: string, values: any[][]): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      console.log(`准备写入 ${sheetName} 工作表...`);
      
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1?valueInputOption=USER_ENTERED`;
      
      const requestBody = {
        range: `${sheetName}!A1`,
        majorDimension: 'ROWS',
        values: values
      };

      const response = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Google Sheets API 错误:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        throw new Error(`Google Sheets API 错误: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      console.log(`${sheetName} 工作表写入成功:`, result);
    } catch (error) {
      console.error(`写入 ${sheetName} 工作表时发生错误:`, error);
      throw error;
    }
  }

  // 主同步方法
  async syncEvents(events: CalendarEvent[], hosts: LumaHost[], guests: LumaGuest[]): Promise<void> {
    try {
      console.log('开始同步到 Google Sheets...');
      
      // 同步事件数据
      console.log('同步事件数据...');
      await this.syncEventsData(events);
      
      // 同步主持人数据
      console.log('同步主持人数据...');
      await this.syncHostsData(hosts);
      
      // 同步参与者数据
      console.log('同步参与者数据...');
      await this.syncGuestsData(guests);
      
      console.log('Google Sheets 同步完成');
    } catch (error) {
      console.error('同步到 Google Sheets 时发生错误:', error);
      throw error;
    }
  }

  // 同步事件数据
  private async syncEventsData(events: CalendarEvent[]): Promise<void> {
    const headers = [
      'API ID', 'Calendar API ID', 'Name', 'Description', 'Description MD',
      'Cover URL', 'Start At', 'End At', 'Timezone', 'Duration Interval',
      'Meeting URL', 'URL', 'User API ID', 'Visibility', 'Zoom Meeting URL',
      'Geo Address', 'Geo Latitude', 'Geo Longitude', 'Created At', 'Updated At'
    ];

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

    await this.writeToSheet('Events', [headers, ...rows]);
  }

  // 同步主持人数据
  private async syncHostsData(hosts: LumaHost[]): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      console.log('准备同步主持人数据...');

      // 准备表头
      const headers = [
        'Host ID',
        'Event ID',
        'Event Name',  // 添加事件名称
        'Host Name',
        'Email',
        'First Name',
        'Last Name',
        'Avatar URL',
        'Created At',
        'Updated At'
      ];

      // 按 event_api_id 分组 hosts
      const hostsByEvent = hosts.reduce((acc, host) => {
        if (!acc[host.event_api_id]) {
          acc[host.event_api_id] = [];
        }
        acc[host.event_api_id].push(host);
        return acc;
      }, {} as Record<string, LumaHost[]>);

      // 准备数据行
      const rows = Object.entries(hostsByEvent).flatMap(([eventId, eventHosts]) => {
        return eventHosts.map(host => [
          host.api_id,
          eventId,
          host.event_name || '',  // 需要从事件数据中获取
          host.name,
          host.email,
          host.first_name || '',
          host.last_name || '',
          host.avatar_url || '',
          host.created_at,
          host.updated_at
        ]);
      });

      // 写入数据
      await this.writeToSheet('Hosts', [headers, ...rows]);
      console.log(`成功同步 ${rows.length} 条主持人数据`);
    } catch (error) {
      console.error('同步主持人数据时发生错误:', error);
      throw error;
    }
  }

  // 同步参与者数据
  private async syncGuestsData(guests: LumaGuest[]): Promise<void> {
    const headers = [
      'API ID', 'Event API ID', 'User Name', 'User Email',
      'User First Name', 'User Last Name', 'Approval Status',
      'Checked In At', 'Check In QR Code', 'Created At', 'Updated At'
    ];

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

    await this.writeToSheet('Guests', [headers, ...rows]);
  }

  // 创建和初始化工作表
  async initializeSheets(): Promise<void> {
    try {
      console.log('开始初始化 Google Sheets...');
      const accessToken = await this.getAccessToken();

      // 创建三个工作表
      const createSheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}:batchUpdate`;
      const createSheetsBody = {
        requests: [
          {
            addSheet: {
              properties: {
                title: 'Events',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 20
                }
              }
            }
          },
          {
            addSheet: {
              properties: {
                title: 'Hosts',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 9
                }
              }
            }
          },
          {
            addSheet: {
              properties: {
                title: 'Guests',
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 11
                }
              }
            }
          }
        ]
      };

      const createResponse = await fetch(createSheetsUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(createSheetsBody)
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        console.error('创建工作表失败:', {
          status: createResponse.status,
          statusText: createResponse.statusText,
          error: errorText
        });
        throw new Error(`创建工作表失败: ${createResponse.status} ${errorText}`);
      }

      console.log('工作表创建成功');

      // 写入表头
      const eventsHeaders = [
        'API ID', 'Calendar API ID', 'Name', 'Description', 'Description MD',
        'Cover URL', 'Start At', 'End At', 'Timezone', 'Duration Interval',
        'Meeting URL', 'URL', 'User API ID', 'Visibility', 'Zoom Meeting URL',
        'Geo Address', 'Geo Latitude', 'Geo Longitude', 'Created At', 'Updated At'
      ];

      const hostsHeaders = [
        'API ID', 'Event API ID', 'Name', 'Email', 'First Name',
        'Last Name', 'Avatar URL', 'Created At', 'Updated At'
      ];

      const guestsHeaders = [
        'API ID', 'Event API ID', 'User Name', 'User Email',
        'User First Name', 'User Last Name', 'Approval Status',
        'Checked In At', 'Check In QR Code', 'Created At', 'Updated At'
      ];

      // 写入表头
      await this.writeToSheet('Events', [eventsHeaders]);
      await this.writeToSheet('Hosts', [hostsHeaders]);
      await this.writeToSheet('Guests', [guestsHeaders]);

      console.log('表头写入成功');
    } catch (error) {
      console.error('初始化工作表时发生错误:', error);
      throw error;
    }
  }
} 