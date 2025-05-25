import { LumaEvent, LumaHost, LumaGuest } from '../types/luma';
import { CalendarEvent } from './luma';

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
          
          throw new Error(`获取访问令牌失败: ${res.status} ${errorText}`);
        }

        const data = await res.json();
        if (!data.access_token) {
          throw new Error('响应中没有访问令牌');
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

    throw lastError || new Error('获取访问令牌失败，已达到最大重试次数');
  }

  // 写入数据到指定工作表
  private async writeToSheet(sheetName: string, values: any[][]): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      console.log(`准备写入 ${sheetName} 工作表...`);
      
      // 先清空工作表数据
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1:Z1000?valueInputOption=USER_ENTERED`;
      await fetch(clearUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [] })
      });
      console.log(`${sheetName} 工作表数据已清空`);
      
      // 写入表头
      const headers = this.getHeaders(sheetName);
      const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1?valueInputOption=USER_ENTERED`;
      await fetch(headerUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [headers] })
      });
      console.log(`${sheetName} 工作表表头已写入`);
      
      // 追加数据
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A2:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const requestBody = {
        range: `${sheetName}!A2`,
        majorDimension: 'ROWS',
        values: values
      };

      const response = await fetch(appendUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google Sheets API 错误: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      console.log(`${sheetName} 工作表数据写入成功:`, result);
    } catch (error) {
      console.error(`写入 ${sheetName} 工作表时发生错误:`, error);
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
      case 'Hosts':
        return [
          'Host ID', 'Event ID', 'Event Name', 'Host Name', 'Email',
          'First Name', 'Last Name', 'Avatar URL', 'Created At', 'Updated At'
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
    const headers = [
      'Host ID',
      'Event ID',
      'Event Name',
      'Host Name',
      'Email',
      'First Name',
      'Last Name',
      'Avatar URL',
      'Created At',
      'Updated At'
    ];

    const rows = hosts.map(host => [
      host.api_id,
      host.event_api_id,
      host.event_name || '',
      host.name,
      host.email,
      host.first_name || '',
      host.last_name || '',
      host.avatar_url || '',
      host.created_at,
      host.updated_at
    ]);

    await this.writeToSheet('Hosts', [headers, ...rows]);
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
                  columnCount: 10
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
        'Host ID', 'Event ID', 'Event Name', 'Host Name', 'Email',
        'First Name', 'Last Name', 'Avatar URL', 'Created At', 'Updated At'
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