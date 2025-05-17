import { LumaService, CalendarEvent } from '../../src/services/luma';
import { GoogleSheetsService } from '../../src/services/googleSheets';
import { LumaGuest, LumaHost } from '../../src/types/luma';

interface Env {
  LUMA_API_KEY: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
}

const DELAY_BETWEEN_EVENTS = 400; // 每个event间隔400ms

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  // 定时任务
  async scheduled(event: any, env: Env, ctx: any) {
    console.log('Starting scheduled sync...');
    await syncAllEvents(env);
  },

  // HTTP 接口
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    
    // 手动触发同步的端点
    if (url.pathname === '/sync' && request.method === 'POST') {
      try {
        console.log('Starting manual sync...');
        await syncAllEvents(env);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Sync completed successfully',
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error: any) {
        console.error('Manual sync failed:', error);
        return new Response(JSON.stringify({
          success: false,
          error: error.message || 'Unknown error',
          timestamp: new Date().toISOString()
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

// 同步所有事件
async function syncAllEvents(env: Env) {
  const lumaService = new LumaService(env.LUMA_API_KEY);
  const googleSheetsService = new GoogleSheetsService(
    env.GOOGLE_CLIENT_EMAIL,
    env.GOOGLE_PRIVATE_KEY,
    env.GOOGLE_SHEET_ID
  );

  try {
    // 1. 获取所有事件
    console.log('Fetching all events...');
    const allEvents = await lumaService.getAllEvents();
    console.log(`Found ${allEvents.length} events`);

    // 2. 初始化 Google Sheets
    console.log('Initializing Google Sheets...');
    await googleSheetsService.initializeSheets();

    // 3. 同步事件数据
    console.log('Syncing events...');
    await googleSheetsService.syncEvents(allEvents.map(e => e.event), 'Events');

    // 4. 处理每个事件的详细数据
    const hosts: LumaHost[] = [];
    const guests: LumaGuest[] = [];

    for (const event of allEvents) {
      console.log(`Processing event: ${event.event.name} (${event.event.api_id})`);
      
      // 获取事件详情
      const details = await lumaService.getEventDetails(event.event.api_id);
      if (details.hosts && details.hosts.length > 0) {
        hosts.push(...details.hosts.map(h => ({ 
          ...h, 
          event_api_id: event.event.api_id, 
          event_name: event.event.name 
        })));
      }

      // 获取事件嘉宾
      const eventGuests = await lumaService.getEventGuests(event.event.api_id);
      guests.push(...eventGuests.map(g => ({ 
        ...g, 
        event_api_id: event.event.api_id 
      })));

      await delay(DELAY_BETWEEN_EVENTS);
    }

    // 5. 同步主持人和嘉宾数据
    console.log('Syncing hosts...');
    await googleSheetsService.syncHosts(hosts, 'Hosts');
    
    console.log('Syncing guests...');
    await googleSheetsService.syncAllGuests(guests, 'Guests');

    console.log('Sync completed successfully');
  } catch (error) {
    console.error('Sync failed:', error);
    throw error;
  }
} 