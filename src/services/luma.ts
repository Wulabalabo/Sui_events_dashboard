import { LumaEvent, LumaHost, LumaGuest } from '../types/luma';

export interface EventTag {
  api_id: string;
  name: string;
}

export interface CalendarEvent {
  api_id: string;
  event: LumaEvent;
  tags: EventTag[];
}

export interface CalendarEventsResponse {
  entries: CalendarEvent[];
  has_more: boolean;
  next_cursor?: string;
}

export interface EventDetailResponse {
  event: LumaEvent;
  hosts: LumaHost[];
}

export interface GuestEntry {
  api_id: string;
  guest: LumaGuest;
}

export interface GuestsResponse {
  entries: GuestEntry[];
  has_more: boolean;
  next_cursor?: string;
}

export class LumaService {
  constructor(private apiKey: string) {}

  private async fetchWithAuth(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'x-luma-api-key': this.apiKey,
        'accept': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Luma API 请求失败: ${response.status} ${await response.text()}`);
    }

    return response;
  }

  async getEventGuests(eventId: string): Promise<LumaGuest[]> {
    const allGuests: LumaGuest[] = [];
    let nextCursor: string | undefined;
    
    do {
      console.log(`正在获取事件 ${eventId} 的参与者...`, nextCursor ? `(下一页: ${nextCursor})` : '');
      
      const queryParams = new URLSearchParams({
        ...(nextCursor && { cursor: nextCursor })
      });

      const response = await this.fetchWithAuth(
        `https://public-api.lu.ma/public/v1/event/get-guests?event_api_id=${eventId}&${queryParams}`
      );

      const responseData = await response.json() as GuestsResponse;
      console.log(`获取到 ${responseData.entries.length} 个参与者`);
      
      allGuests.push(...responseData.entries.map(entry => entry.guest));
      nextCursor = responseData.next_cursor;
      
    } while (nextCursor);

    console.log(`总共获取到 ${allGuests.length} 个参与者`);
    return allGuests;
  }

  async getEventDetails(eventId: string): Promise<EventDetailResponse> {
    console.log(`正在获取事件 ${eventId} 的详细信息...`);
    
    const response = await this.fetchWithAuth(
      `https://public-api.lu.ma/public/v1/event/get?api_id=${eventId}`
    );

    return await response.json() as EventDetailResponse;
  }

  async getAllEvents(sortBy: 'start_at' | 'created_at' = 'start_at', order: 'asc' | 'desc' = 'desc'): Promise<CalendarEvent[]> {
    const allEvents: CalendarEvent[] = [];
    let nextCursor: string | undefined;
    
    do {
      console.log('正在获取事件列表...', nextCursor ? `(下一页: ${nextCursor})` : '');
      
      const queryParams = new URLSearchParams({
        sort_by: sortBy,
        order: order,
        ...(nextCursor && { cursor: nextCursor })
      });

      const response = await this.fetchWithAuth(
        `https://api.lu.ma/public/v1/calendar/list-events?${queryParams}`
      );

      const responseData = await response.json() as CalendarEventsResponse;
      console.log(`获取到 ${responseData.entries.length} 个事件`);
      
      allEvents.push(...responseData.entries);
      nextCursor = responseData.next_cursor;
      
    } while (nextCursor);

    console.log(`总共获取到 ${allEvents.length} 个事件`);
    return allEvents;
  }

  async getEvent(eventId: string): Promise<{ event: LumaEvent; hosts: LumaHost[] }> {
    const response = await fetch(`https://public-api.lu.ma/public/v1/event/get?event_id=${eventId}`, {
      headers: {
        'x-luma-api-key': this.apiKey,
        'accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`获取事件详情失败: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      event: data.event,
      hosts: data.hosts.map((host: any) => ({
        api_id: host.api_id,
        name: host.name,
        email: host.email,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }))
    };
  }
} 