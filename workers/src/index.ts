import { LumaService, CalendarEvent } from '../../src/services/luma';
import { GoogleSheetsService } from '../../src/services/google';
import { SupabaseService } from '../../src/services/supabase';
import { LumaGuest, LumaHost } from '../../src/types/luma';

interface Env {
  LUMA_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface SyncResult {
  success: boolean;
  message: string;
  stats?: {
    events: number;
    hosts: number;
    guests: number;
  };
  error?: string;
}

/**
 * 验证环境变量
 */
function validateEnv(env: Env): void {
  const required = {
    'LUMA_API_KEY': env.LUMA_API_KEY,
    'SUPABASE_URL': env.SUPABASE_URL,
    'SUPABASE_SERVICE_KEY': env.SUPABASE_SERVICE_KEY,
    'GOOGLE_SHEET_ID': env.GOOGLE_SHEET_ID,
    'GOOGLE_CLIENT_EMAIL': env.GOOGLE_CLIENT_EMAIL,
    'GOOGLE_PRIVATE_KEY': env.GOOGLE_PRIVATE_KEY
  };

  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`缺少必要的环境变量: ${missing.join(', ')}`);
  }
}

/**
 * 获取所有事件数据
 */
async function fetchAllEventData(lumaService: LumaService): Promise<{
  events: CalendarEvent[];
  hosts: LumaHost[];
  guests: LumaGuest[];
}> {
  console.log('获取所有事件...');
  const events = await lumaService.getAllEvents();
  console.log(`获取到 ${events.length} 个事件`);

  console.log('获取事件详情和嘉宾...');
  const hosts: LumaHost[] = [];
  const guests: LumaGuest[] = [];

  for (const event of events) {
    console.log(`处理事件: ${event.event.name}`);
    const details = await lumaService.getEventDetails(event.event.api_id);
    if (details.hosts && details.hosts.length > 0) {
      hosts.push(...details.hosts);
    }

    const eventGuests = await lumaService.getEventGuests(event.event.api_id);
    const guestsWithEventId = eventGuests.map(guest => ({
      ...guest,
      event_api_id: event.event.api_id
    }));
    guests.push(...guestsWithEventId);
  }

  console.log(`获取到 ${hosts.length} 个主办方和 ${guests.length} 个嘉宾`);
  return { events, hosts, guests };
}

/**
 * 同步数据到数据库
 */
async function syncToDatabase(env: Env): Promise<SyncResult> {
  try {
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const supabaseService = new SupabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const { events, hosts, guests } = await fetchAllEventData(lumaService);

    console.log('开始同步到数据库...');
    for (const event of events) {
      await supabaseService.syncEvents([event], hosts, guests, event.event.api_id);
    }
    console.log('数据库同步完成');

    return {
      success: true,
      message: '数据库同步成功',
      stats: {
        events: events.length,
        hosts: hosts.length,
        guests: guests.length
      }
    };
  } catch (error) {
    console.error('数据库同步失败:', error);
    return {
      success: false,
      message: '数据库同步失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

/**
 * 同步数据到 Google Sheets
 */
async function syncToGoogleSheets(env: Env): Promise<SyncResult> {
  try {
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const googleSheetsService = new GoogleSheetsService(
      env.GOOGLE_CLIENT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_SHEET_ID
    );

    const { events, hosts, guests } = await fetchAllEventData(lumaService);

    console.log('开始同步到 Google Sheets...');
    await googleSheetsService.syncEvents(events, hosts, guests);
    console.log('Google Sheets 同步完成');

    return {
      success: true,
      message: 'Google Sheets 同步成功',
      stats: {
        events: events.length,
        hosts: hosts.length,
        guests: guests.length
      }
    };
  } catch (error) {
    console.error('Google Sheets 同步失败:', error);
    return {
      success: false,
      message: 'Google Sheets 同步失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      validateEnv(env);

      console.log('开始同步数据...');
      const [dbResult, sheetsResult] = await Promise.all([
        syncToDatabase(env),
        syncToGoogleSheets(env)
      ]);

      if (!dbResult.success || !sheetsResult.success) {
        throw new Error(
          `同步失败:\n数据库: ${dbResult.error || '成功'}\nGoogle Sheets: ${sheetsResult.error || '成功'}`
        );
      }

      return new Response(JSON.stringify({
        success: true,
        message: '数据同步成功',
        stats: {
          database: dbResult.stats,
          googleSheets: sheetsResult.stats
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('同步过程中出错:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event: any, env: Env, ctx: ExecutionContext) {
    try {
      validateEnv(env);

      console.log('开始定时同步数据...');
      const [dbResult, sheetsResult] = await Promise.all([
        syncToDatabase(env),
        syncToGoogleSheets(env)
      ]);

      if (!dbResult.success || !sheetsResult.success) {
        throw new Error(
          `定时同步失败:\n数据库: ${dbResult.error || '成功'}\nGoogle Sheets: ${sheetsResult.error || '成功'}`
        );
      }

      console.log('定时同步完成', {
        database: dbResult.stats,
        googleSheets: sheetsResult.stats
      });
    } catch (error) {
      console.error('定时同步失败:', error);
      throw error;
    }
  }
}; 