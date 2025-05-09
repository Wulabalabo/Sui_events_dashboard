import { LumaService } from '../../src/services/luma';
import { GoogleSheetsService } from '../../src/services/google';
import { SupabaseService } from '../../src/services/supabase';
import { LumaGuest, LumaHost } from '@/types/luma';

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

/**
 * 同步数据到 Google Sheets
 * 此方法会：
 * 1. 从 Luma API 获取所有事件
 * 2. 获取每个事件的详情和嘉宾信息
 * 3. 将数据同步到 Google Sheets
 * 
 * @param env - 环境变量对象
 * @returns 同步结果统计信息
 */
async function syncToGoogleSheets(env: Env): Promise<{
  success: boolean;
  message: string;
  stats?: {
    events: number;
    hosts: number;
    guests: number;
  };
  error?: string;
}> {
  try {
    // 检查 Google Sheets 环境变量
    if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY || !env.GOOGLE_SHEET_ID) {
      throw new Error('缺少 Google Sheets 相关环境变量');
    }

    // 初始化服务
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const googleSheetsService = new GoogleSheetsService(
      env.GOOGLE_CLIENT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_SHEET_ID
    );
    
    // 获取所有事件
    console.log('获取所有事件...');
    const events = await lumaService.getAllEvents();
    console.log(`获取到 ${events.length} 个事件`);
    
    // 获取事件详情和嘉宾
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
      // 为每个嘉宾添加 event_api_id
      const guestsWithEventId = eventGuests.map(guest => ({
        ...guest,
        event_api_id: event.event.api_id
      }));
      guests.push(...guestsWithEventId);
    }
    
    console.log(`获取到 ${hosts.length} 个主办方和 ${guests.length} 个嘉宾`);
    
    // 同步到 Google Sheets
    console.log('开始同步到 Google Sheets...');
    await googleSheetsService.syncEvents(events, hosts, guests);
    console.log('Google Sheets 同步完成');

    return {
      success: true,
      message: '数据同步成功',
      stats: {
        events: events.length,
        hosts: hosts.length,
        guests: guests.length
      }
    };
  } catch (error) {
    console.error('同步过程中出错:', error);
    return {
      success: false,
      message: '数据同步失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // 检查必要的环境变量
      if (!env.LUMA_API_KEY) {
        throw new Error('缺少 LUMA_API_KEY 环境变量');
      }
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
        throw new Error('缺少 Supabase 相关环境变量');
      }

      // 测试数据库同步
      console.log('开始测试数据库同步...');
      const result = await syncToDatabase(env);
      
      if (!result.success) {
        throw new Error(result.error || '数据库同步失败');
      }

      return new Response(JSON.stringify({
        success: true,
        message: '数据库同步成功',
        stats: result.stats
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('发生错误:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

/**
 * 同步数据到数据库
 * 此方法会：
 * 1. 从 Luma API 获取所有事件
 * 2. 获取每个事件的详情和嘉宾信息
 * 3. 将数据同步到 Supabase 数据库
 * 
 * @param env - 环境变量对象
 * @returns 同步结果统计信息
 */
async function syncToDatabase(env: Env): Promise<{
  success: boolean;
  message: string;
  stats?: {
    events: number;
    hosts: number;
    guests: number;
  };
  error?: string;
}> {
  try {
    // 检查 Supabase 环境变量
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
      throw new Error('缺少 Supabase 相关环境变量');
    }

    // 初始化服务
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const supabaseService = new SupabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    
    // 获取所有事件
    console.log('获取所有事件...');
    const events = await lumaService.getAllEvents();
    console.log(`获取到 ${events.length} 个事件`);
    
    // 获取事件详情和嘉宾
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
      // 为每个嘉宾添加 event_api_id
      const guestsWithEventId = eventGuests.map(guest => ({
        ...guest,
        event_api_id: event.event.api_id
      }));
      guests.push(...guestsWithEventId);
    }
    
    console.log(`获取到 ${hosts.length} 个主办方和 ${guests.length} 个嘉宾`);
    
    // 同步到 Supabase
    console.log('开始同步到 Supabase...');
    for (const event of events) {
      console.log(`同步事件 ${event.event.name} 的数据...`);
      const eventHosts = hosts.filter(h => h.api_id === event.event.user_api_id);
      const eventGuests = guests.filter(g => g.event_api_id === event.event.api_id);
      
      await supabaseService.syncEvents([event], eventHosts, eventGuests, event.event.api_id);
      console.log(`事件 ${event.event.name} 同步完成`);
    }
    console.log('Supabase 同步完成');

    return {
      success: true,
      message: '数据同步成功',
      stats: {
        events: events.length,
        hosts: hosts.length,
        guests: guests.length
      }
    };
  } catch (error) {
    console.error('同步过程中出错:', error);
    return {
      success: false,
      message: '数据同步失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
} 