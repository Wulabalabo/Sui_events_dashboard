import { LumaEvent, LumaHost, LumaGuest } from '../../src/types/luma';

interface Env {
  LUMA_API_KEY: string;
}

interface EventTag {
  api_id: string;
  name: string;
}

interface CalendarEvent {
  api_id: string;
  event: LumaEvent;
  tags: EventTag[];
}

interface CalendarEventsResponse {
  entries: CalendarEvent[];
  has_more: boolean;
  next_cursor?: string;
}

interface EventDetailResponse {
  event: LumaEvent;
  hosts: LumaHost[];
}

interface GuestEntry {
  api_id: string;
  guest: LumaGuest;
}

interface GuestsResponse {
  entries: GuestEntry[];
  has_more: boolean;
  next_cursor?: string;
}

async function getEventGuests(env: Env, eventId: string): Promise<LumaGuest[]> {
  const allGuests: LumaGuest[] = [];
  let nextCursor: string | undefined;
  
  do {
    console.log(`正在获取事件 ${eventId} 的参与者...`, nextCursor ? `(下一页: ${nextCursor})` : '');
    
    // 构建查询参数
    const queryParams = new URLSearchParams({
      ...(nextCursor && { cursor: nextCursor })
    });

    const response = await fetch(`https://public-api.lu.ma/public/v1/event/get-guests?event_api_id=${eventId}`, {
      headers: {
        'x-luma-api-key': env.LUMA_API_KEY,
        'accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`获取参与者列表失败: ${response.status} ${await response.text()}`);
    }

    const responseData = await response.json() as GuestsResponse;
    console.log(`获取到 ${responseData.entries.length} 个参与者`);
    
    allGuests.push(...responseData.entries.map(entry => entry.guest));
    nextCursor = responseData.next_cursor;
    
  } while (nextCursor);

  console.log(`总共获取到 ${allGuests.length} 个参与者`);
  return allGuests;
}

async function getEventDetails(env: Env, eventId: string): Promise<EventDetailResponse> {
  console.log(`正在获取事件 ${eventId} 的详细信息...`);
  
  const response = await fetch(`https://public-api.lu.ma/public/v1/event/get?api_id=${eventId}`, {
    headers: {
      'x-luma-api-key': env.LUMA_API_KEY,
      'accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`获取事件详情失败: ${response.status} ${await response.text()}`);
  }

  return await response.json() as EventDetailResponse;
}

async function getAllEvents(env: Env, sortBy: 'start_at' | 'created_at' = 'start_at', order: 'asc' | 'desc' = 'desc'): Promise<CalendarEvent[]> {
  const allEvents: CalendarEvent[] = [];
  let nextCursor: string | undefined;
  
  do {
    console.log('正在获取事件列表...', nextCursor ? `(下一页: ${nextCursor})` : '');
    
    // 构建查询参数
    const queryParams = new URLSearchParams({
      sort_by: sortBy,
      order: order,
      ...(nextCursor && { cursor: nextCursor })
    });

    const eventsResponse = await fetch(`https://api.lu.ma/public/v1/calendar/list-events?${queryParams}`, {
      headers: {
        'x-luma-api-key': env.LUMA_API_KEY,
        'accept': 'application/json'
      }
    });

    if (!eventsResponse.ok) {
      throw new Error(`获取事件列表失败: ${eventsResponse.status} ${await eventsResponse.text()}`);
    }

    const responseData = await eventsResponse.json() as CalendarEventsResponse;
    console.log(`获取到 ${responseData.entries.length} 个事件`);
    
    allEvents.push(...responseData.entries);
    nextCursor = responseData.next_cursor;
    
  } while (nextCursor);

  console.log(`总共获取到 ${allEvents.length} 个事件`);
  return allEvents;
}

async function testLumaApi(env: Env) {
  try {
    // 获取所有事件（按开始时间降序排列，获取最新的）
    const events = await getAllEvents(env, 'start_at', 'desc');
    
    if (events.length > 0) {
      // 获取第一个事件的详细信息
      const firstEvent = events[0];
      const eventDetails = await getEventDetails(env, firstEvent.event.api_id);
      
      console.log('事件详细信息:', JSON.stringify(eventDetails, null, 2));
      console.log('主持人数量:', eventDetails.hosts.length);

      // 获取该事件的所有参与者
      const guests = await getEventGuests(env, firstEvent.event.api_id);
      console.log('参与者总数:', guests.length);
      
      if (guests.length > 0) {
        console.log('第一个参与者示例:', JSON.stringify(guests[0], null, 2));
      }
    }

  } catch (error) {
    console.error('测试过程中发生错误:', error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await testLumaApi(env);
    return new Response('测试完成，请查看控制台输出');
  }
}; 