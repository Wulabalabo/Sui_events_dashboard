import { LumaEvent, LumaHost, LumaGuest } from '../types/luma';

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private readonly minDelay: number; // 最小请求间隔（毫秒）
  private lastRequestTime: number;

  constructor(maxTokensPerMinute: number) {
    this.maxTokens = maxTokensPerMinute;
    this.tokens = maxTokensPerMinute;
    this.lastRefill = Date.now();
    this.lastRequestTime = 0;
    this.refillRate = maxTokensPerMinute / (60 * 1000);
    this.minDelay = 1000 / (maxTokensPerMinute / 60);
  }

  async acquireToken(): Promise<void> {
    while (true) {
      this.refillTokens();
      if (this.tokens > 0) {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minDelay) {
          // 使用更短的检查间隔，避免阻塞
          await new Promise(resolve => {
            const checkInterval = Math.min(100, this.minDelay - timeSinceLastRequest);
            const check = () => {
              if (Date.now() - this.lastRequestTime >= this.minDelay) {
                resolve(undefined);
              } else {
                setTimeout(check, checkInterval);
              }
            };
            check();
          });
        }
        
        this.tokens--;
        this.lastRequestTime = Date.now();
        return;
      }
      // 使用更短的检查间隔
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const newTokens = timePassed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

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
  private rateLimiter: RateLimiter;
  private readonly MAX_CONCURRENT_REQUESTS = 3; // 降低并发数
  private activeRequests = 0;
  private readonly REQUEST_TIMEOUT = 10000; // 10秒超时

  constructor(private apiKey: string) {
    this.rateLimiter = new RateLimiter(300);
  }

  private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    // 控制并发请求数
    while (this.activeRequests >= this.MAX_CONCURRENT_REQUESTS) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    this.activeRequests++;
    try {
      await this.rateLimiter.acquireToken();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'x-luma-api-key': this.apiKey,
          'accept': 'application/json',
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Luma API request failed: ${response.status} ${await response.text()}`);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    } finally {
      this.activeRequests--;
    }
  }

  // 修改分页获取方法，添加错误重试
  private async fetchWithRetry<T>(url: string, retries = 3): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await this.fetchWithAuth(url);
        return await response.json();
      } catch (error) {
        if (i === retries - 1) throw error;
        // 指数退避重试
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
    throw new Error('Max retries exceeded');
  }

  async getAllEvents(
    sortColumn: 'start_at' | 'created_at' = 'start_at',
    sortDirection: 'asc' | 'desc' = 'desc',
    paginationCursor?: string,
    paginationLimit: number = 50,
    after?: string,
    before?: string
  ): Promise<CalendarEventsResponse> {
    console.log('Fetching events list...', paginationCursor ? `(next page: ${paginationCursor})` : '');
    
    const queryParams = new URLSearchParams({
      sort_column: sortColumn,
      sort_direction: sortDirection,
      pagination_limit: paginationLimit.toString(),
      ...(paginationCursor && { pagination_cursor: paginationCursor }),
      ...(after && { after }),
      ...(before && { before })
    });

    const response = await this.fetchWithAuth(
      `https://api.lu.ma/public/v1/calendar/list-events?${queryParams}`
    );

    return await response.json() as CalendarEventsResponse;
  }

  async getEventGuests(
    eventId: string,
    paginationCursor?: string,
    limit: number = 50
  ): Promise<GuestsResponse> {
    console.log(`Fetching guests for event ${eventId}...`, paginationCursor ? `(next page: ${paginationCursor})` : '');
    
    const queryParams = new URLSearchParams({
      pagination_limit: limit.toString(),
      ...(paginationCursor && { pagination_cursor: paginationCursor })
    });

    const response = await this.fetchWithAuth(
      `https://public-api.lu.ma/public/v1/event/get-guests?event_api_id=${eventId}&${queryParams}`
    );

    return await response.json() as GuestsResponse;
  }

  async getEventDetails(eventId: string): Promise<EventDetailResponse> {
    console.log(`Fetching details for event ${eventId}...`);
    
    const response = await this.fetchWithAuth(
      `https://public-api.lu.ma/public/v1/event/get?api_id=${eventId}`
    );

    return await response.json() as EventDetailResponse;
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