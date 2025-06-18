import { LumaService, CalendarEvent } from './luma';
import { GoogleSheetsService } from './googleSheets';

// Cloudflare Workers 类型
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

interface KVNamespace {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
}

export interface SyncState {
  lastSyncTime: number;
  currentStage: 'events' | 'details' | 'guests' | 'completed';
  pendingEvents: string[];
  failedEvents: string[];
  lastProcessedIndex: number;
  eventDetails: { [key: string]: { name: string, hosts: any[] } };
  nextCursor?: string;  // 添加分页游标
  hasMore: boolean;     // 是否还有更多数据
  // 添加guests处理状态
  currentEventGuests?: {
    eventId: string;
    nextCursor?: string;
    hasMore: boolean;
    processedCount: number;
  };
}

export class SyncService {
  private readonly BATCH_SIZE = 1;
  private readonly EVENTS_PER_FETCH = 50;
  private readonly GUESTS_PER_FETCH = 50;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;

  constructor(
    private lumaService: LumaService,
    private sheetsService: GoogleSheetsService,
    private state: DurableObjectState
  ) {}

  // Initialize sync state
  private async initState(): Promise<SyncState> {
    let state = await this.state.storage.get<SyncState>('syncState');
    if (!state) {
      state = {
        lastSyncTime: 0,
        currentStage: 'events',
        pendingEvents: [],
        failedEvents: [],
        lastProcessedIndex: 0,
        eventDetails: {},
        hasMore: true
      };
      await this.state.storage.put('syncState', state);
    }
    return state;
  }

  // Update sync state
  private async updateState(updates: Partial<SyncState>): Promise<void> {
    const state = await this.initState();
    const newState = { ...state, ...updates };
    await this.state.storage.put('syncState', newState);
  }

  // Delay function
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get all events and start sync
  public async queueAllEvents(after?: string, before?: string): Promise<void> {
    try {
      await this.logWithTimestamp('Starting to fetch all events...');
      const eventsResponse = await this.lumaService.getAllEvents(
        'start_at',
        'desc',
        undefined,
        this.EVENTS_PER_FETCH,
        after,
        before
      );
      await this.logWithTimestamp(`Found ${eventsResponse.entries.length} events`);

      // 更新状态
      await this.updateState({
        currentStage: 'events',
        pendingEvents: eventsResponse.entries.map(e => e.event.api_id),
        lastProcessedIndex: 0,
        lastSyncTime: Date.now(),
        eventDetails: {},
        nextCursor: eventsResponse.next_cursor,
        hasMore: eventsResponse.has_more
      });

      // 写入 events 数据
      const eventsData = eventsResponse.entries.map(e => [
        e.event.api_id,
        e.event.calendar_api_id,
        e.event.name,
        e.event.description,
        e.event.description_md,
        e.event.cover_url,
        e.event.start_at,
        e.event.end_at,
        e.event.timezone,
        e.event.duration_interval,
        e.event.meeting_url,
        e.event.url,
        e.event.user_api_id,
        e.event.visibility,
        e.event.zoom_meeting_url,
        e.event.geo_address_json?.address || '',
        e.event.geo_latitude,
        e.event.geo_longitude,
        e.event.created_at,
        e.event.updated_at
      ]);
      await this.batchWriteToSheet('Events', eventsData);
      
      await this.logWithTimestamp('Events list synced to Google Sheets');

      // 开始处理事件
      await this.processPendingEvents();
    } catch (error) {
      await this.logWithTimestamp('Failed to fetch events list', error);
      throw error;
    }
  }

  // 添加详细的日志记录
  private async logWithTimestamp(message: string, data?: any) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data) : '');
  }

  // Process event details and hosts
  private async processEventDetails(eventId: string): Promise<void> {
    try {
      await this.logWithTimestamp(`Starting to process details for event ${eventId}`);
      const details = await this.lumaService.getEventDetails(eventId);
      const state = await this.initState();
      
      // 写入 hosts 数据
      if (details.hosts && details.hosts.length > 0) {
        const hostsData = details.hosts.map(host => [
          host.api_id,
          eventId,
          host.event_name || '',
          host.name,
          host.email,
          host.first_name || '',
          host.last_name || '',
          host.avatar_url || '',
          host.created_at,
          host.updated_at
        ]);
        await this.batchWriteToSheet('Hosts', hostsData);
        await this.logWithTimestamp(`Wrote ${details.hosts.length} hosts for event ${eventId}`);
      }

      // 更新状态
      await this.updateState({
        eventDetails: {
          ...state.eventDetails,
          [eventId]: {
            name: details.event.name,
            hosts: details.hosts
          }
        }
      });

      await this.logWithTimestamp(`Completed processing details for event ${eventId}`);
    } catch (error) {
      await this.logWithTimestamp(`Failed to process details for event ${eventId}`, error);
      throw error;
    }
  }

  // Process event guests
  private async processEventGuests(eventId: string): Promise<void> {
    try {
      await this.logWithTimestamp(`Starting to process guests for event ${eventId}`);
      const state = await this.initState();
      const eventDetail = state.eventDetails[eventId];
      
      if (!eventDetail) {
        throw new Error(`Event details not found for ${eventId}`);
      }

      let guestsState = state.currentEventGuests;
      if (!guestsState || guestsState.eventId !== eventId) {
        guestsState = {
          eventId,
          hasMore: true,
          processedCount: 0,
          nextCursor: undefined
        };
      }

      // 如果已经处理完所有 guests，直接返回
      if (!guestsState.hasMore) {
        await this.logWithTimestamp(`All guests for event ${eventId} have been processed`);
        return;
      }

      // 获取一批 guests
      const guestsResponse = await this.lumaService.getEventGuests(
        eventId,
        guestsState.nextCursor,
        this.GUESTS_PER_FETCH
      );

      if (guestsResponse.entries.length > 0) {
        const guestsData = guestsResponse.entries.map(entry => [
          entry.guest.api_id,
          eventId,
          entry.guest.user_name,
          entry.guest.user_email,
          entry.guest.user_first_name || '',
          entry.guest.user_last_name || '',
          entry.guest.approval_status,
          entry.guest.checked_in_at || '',
          entry.guest.check_in_qr_code || '',
          entry.guest.created_at,
          entry.guest.updated_at
        ]);
        await this.batchWriteToSheet('Guests', guestsData);
        await this.logWithTimestamp(`Wrote ${guestsResponse.entries.length} guests for event ${eventId}`);
      }

      // 更新状态
      const newGuestsState = {
        eventId,
        nextCursor: guestsResponse.next_cursor,
        hasMore: guestsResponse.has_more,
        processedCount: guestsState.processedCount + guestsResponse.entries.length
      };

      await this.updateState({
        currentEventGuests: newGuestsState
      });

      // 如果这个事件的所有 guests 都处理完了，清除 guests 状态并更新 lastProcessedIndex
      if (!guestsResponse.has_more) {
        await this.logWithTimestamp(`All guests processed for event ${eventId}, moving to next event`);
        const currentState = await this.initState();
        await this.updateState({
          currentEventGuests: undefined,
          lastProcessedIndex: currentState.lastProcessedIndex + 1
        });
      }

    } catch (error) {
      await this.logWithTimestamp(`Failed to process guests for event ${eventId}`, error);
      throw error;
    }
  }

  // 获取下一批事件
  public async fetchNextBatch(): Promise<void> {
    const state = await this.initState();
    
    if (!state.hasMore && state.currentStage === 'events') {
      console.log('All events have been fetched');
      return;
    }

    try {
      console.log('Fetching next batch of events...');
      const eventsResponse = await this.lumaService.getAllEvents(
        'start_at',
        'desc',
        state.nextCursor,
        this.EVENTS_PER_FETCH
      );

      // 更新状态
      await this.updateState({
        pendingEvents: [...state.pendingEvents, ...eventsResponse.entries.map(e => e.event.api_id)],
        nextCursor: eventsResponse.next_cursor,
        hasMore: eventsResponse.has_more,
        lastSyncTime: Date.now()
      });

      // 修正 events 表写入字段顺序
      const eventsData = eventsResponse.entries.map(e => [
        e.event.api_id,
        e.event.calendar_api_id,
        e.event.name,
        e.event.description,
        e.event.description_md,
        e.event.cover_url,
        e.event.start_at,
        e.event.end_at,
        e.event.timezone,
        e.event.duration_interval,
        e.event.meeting_url,
        e.event.url,
        e.event.user_api_id,
        e.event.visibility,
        e.event.zoom_meeting_url,
        e.event.geo_address_json?.address || '',
        e.event.geo_latitude,
        e.event.geo_longitude,
        e.event.created_at,
        e.event.updated_at
      ]);
      await (this.sheetsService as any).writeToSheet('Events', eventsData);

      console.log(`Fetched and synced ${eventsResponse.entries.length} events`);
    } catch (error) {
      console.error('Failed to fetch events batch:', error);
      throw error;
    }
  }

  // Process pending events
  public async processPendingEvents(): Promise<void> {
    try {
      const state = await this.initState();
      const { pendingEvents, lastProcessedIndex, currentStage } = state;
      
      await this.logWithTimestamp(`Starting to process pending events, current stage: ${currentStage}, processed: ${lastProcessedIndex}, total: ${pendingEvents.length}`);
      
      if (lastProcessedIndex >= pendingEvents.length) {
        await this.logWithTimestamp(`Current batch processing completed, checking next stage`);
        
        if (currentStage === 'events') {
          if (state.hasMore) {
            await this.logWithTimestamp(`More events available, fetching next batch`);
            await this.fetchNextBatch();
            return;
          }
          await this.logWithTimestamp(`Moving to details processing stage`);
          await this.updateState({
            currentStage: 'details',
            lastProcessedIndex: 0
          });
          return;
        } else if (currentStage === 'details') {
          await this.logWithTimestamp(`Moving to guests processing stage`);
          await this.updateState({
            currentStage: 'guests',
            lastProcessedIndex: 0
          });
          return;
        } else if (currentStage === 'guests') {
          await this.logWithTimestamp(`All stages completed`);
          await this.updateState({
            currentStage: 'completed'
          });
          return;
        }
      }

      await this.processBatch(currentStage);
    } catch (error) {
      await this.logWithTimestamp(`Failed to process pending events`, error);
      throw error;
    }
  }

  private async processBatch(stage: string): Promise<void> {
    try {
      const state = await this.initState();
      const { pendingEvents, lastProcessedIndex } = state;
      
      await this.logWithTimestamp(`Starting batch processing, stage: ${stage}, start index: ${lastProcessedIndex}`);
      
      const batch = pendingEvents.slice(
        lastProcessedIndex,
        lastProcessedIndex + this.BATCH_SIZE
      );

      await this.logWithTimestamp(`Processing ${batch.length} events in this batch`);

      for (const eventId of batch) {
        try {
          if (stage === 'details') {
            await this.processEventDetails(eventId);
          } else if (stage === 'guests') {
            await this.processEventGuests(eventId);
          }
        } catch (error) {
          await this.logWithTimestamp(`Failed to process event ${eventId}`, error);
          const currentState = await this.initState();
          await this.updateState({
            failedEvents: [...currentState.failedEvents, eventId]
          });
        }
      }

      if (stage !== 'guests' || !state.currentEventGuests) {
        const newIndex = lastProcessedIndex + batch.length;
        await this.logWithTimestamp(`Updating processing index: ${lastProcessedIndex} -> ${newIndex}`);
        await this.updateState({
          lastProcessedIndex: newIndex
        });
      }
    } catch (error) {
      await this.logWithTimestamp(`Batch processing failed`, error);
      throw error;
    }
  }

  // Get sync status
  public async getStatus(): Promise<{
    lastSyncTime: number;
    currentStage: string;
    totalEvents: number;
    processedEvents: number;
    failedEvents: number;
    progress: number;
  }> {
    const state = await this.initState();
    const totalEvents = state.pendingEvents.length;
    const processedEvents = state.lastProcessedIndex;
    const progress = totalEvents > 0 ? (processedEvents / totalEvents) * 100 : 0;

    return {
      lastSyncTime: state.lastSyncTime,
      currentStage: state.currentStage,
      totalEvents,
      processedEvents,
      failedEvents: state.failedEvents.length,
      progress
    };
  }

  // 停止同步
  public async stopSync(): Promise<void> {
    const state = await this.initState();
    await this.updateState({
      currentStage: 'completed',
      lastProcessedIndex: state.pendingEvents.length
    });
    console.log('Sync stopped');
  }

  // 重置同步状态
  public async resetSync(): Promise<void> {
    await this.updateState({
      lastSyncTime: 0,
      currentStage: 'events',
      pendingEvents: [],
      failedEvents: [],
      lastProcessedIndex: 0,
      eventDetails: {},
      hasMore: true,
      currentEventGuests: undefined
    });
    console.log('Sync state reset');
  }

  async cleanup(): Promise<void> {
    try {
      // 清理所有状态
      await this.state.storage.put('syncState', {
        lastSyncTime: 0,
        currentStage: 'events',
        pendingEvents: [],
        failedEvents: [],
        lastProcessedIndex: 0,
        eventDetails: {},
        hasMore: true,
        currentEventGuests: undefined
      });
      
      console.log('Sync state cleaned up successfully');
    } catch (error) {
      console.error('Failed to cleanup sync state:', error);
      throw error;
    }
  }

  // 优化批量写入方法
  private async batchWriteToSheet(sheetName: string, rows: any[][]) {
    if (!rows || rows.length === 0) {
      await this.logWithTimestamp(`No data to write to ${sheetName}`);
      return;
    }

    const BATCH_SIZE = 50;
    const DELAY = 1000;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      let retryCount = 0;
      
      while (retryCount < this.MAX_RETRIES) {
        try {
          await this.logWithTimestamp(`Writing batch ${i/BATCH_SIZE + 1} to ${sheetName}`);
          await (this.sheetsService as any).writeToSheet(sheetName, batch);
          await this.logWithTimestamp(`Successfully wrote batch ${i/BATCH_SIZE + 1} to ${sheetName}`);
          break;
        } catch (error) {
          retryCount++;
          await this.logWithTimestamp(`Failed to write to ${sheetName}, retry ${retryCount}/${this.MAX_RETRIES}`, error);
          
          if (retryCount === this.MAX_RETRIES) {
            throw error;
          }
          
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * retryCount));
        }
      }

      if (i + BATCH_SIZE < rows.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY));
      }
    }
  }
} 