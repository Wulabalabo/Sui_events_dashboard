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
  private readonly BATCH_SIZE = 3; // 每批处理3个事件
  private readonly DELAY_BETWEEN_EVENTS = 1000; // Delay between events in milliseconds
  private readonly EVENTS_PER_FETCH = 50; // 每次获取的事件数量
  private readonly GUESTS_PER_FETCH = 50; // 每次获取50个guests

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
  public async queueAllEvents(): Promise<void> {
    try {
      console.log('[Queue] Starting to fetch all events...');
      const eventsResponse = await this.lumaService.getAllEvents('start_at', 'desc');
      console.log(`[Queue] Found ${eventsResponse.entries.length} events`);

      // Update state
      await this.updateState({
        currentStage: 'events',
        pendingEvents: eventsResponse.entries.map(e => e.event.api_id),
        lastProcessedIndex: 0,
        lastSyncTime: Date.now(),
        eventDetails: {},
        nextCursor: eventsResponse.next_cursor,
        hasMore: eventsResponse.has_more
      });
      console.log('[Queue] State updated with initial events');

      // Sync events list to Google Sheets
      await (this.sheetsService as any).writeToSheet('Events', eventsResponse.entries.map(e => [
        e.event.api_id,
        e.event.name,
        e.event.start_at,
        e.event.end_at
      ]));
      
      console.log('[Queue] Events list synced to Google Sheets');

      // 立即开始处理事件
      console.log('[Queue] Starting initial event processing...');
      await this.processPendingEvents();
      console.log('[Queue] Initial event processing completed');
    } catch (error) {
      console.error('[Queue] Failed to fetch events list:', error);
      throw error;
    }
  }

  // Process event details and hosts
  private async processEventDetails(eventId: string): Promise<void> {
    try {
      console.log(`[Details] Starting to fetch details for event ${eventId}`);
      const details = await this.lumaService.getEventDetails(eventId);
      console.log(`[Details] Successfully fetched details for event "${details.event.name}"`);
      
      const state = await this.initState();
      
      // Save event details
      await this.updateState({
        eventDetails: {
          ...state.eventDetails,
          [eventId]: {
            name: details.event.name,
            hosts: details.hosts
          }
        }
      });
      console.log(`[Details] Updated state with event details for "${details.event.name}"`);

      // Sync hosts data
      console.log(`[Details] Preparing to write ${details.hosts.length} hosts to Google Sheets`);
      const hostsData = details.hosts.map(host => [
        host.api_id,
        host.name,
        host.email,
        eventId,
        details.event.name
      ]);
      console.log('[Details] Hosts data prepared:', JSON.stringify(hostsData));
      
      await (this.sheetsService as any).writeToSheet('Hosts', hostsData);
      console.log(`[Details] Successfully wrote hosts data to Google Sheets for event "${details.event.name}"`);
    } catch (error) {
      console.error(`[Details] Failed to process details for event ${eventId}:`, error);
      throw error;
    }
  }

  // Process event guests
  private async processEventGuests(eventId: string): Promise<void> {
    try {
      console.log(`[Guests] Starting to process guests for event ${eventId}`);
      const state = await this.initState();
      const eventDetail = state.eventDetails[eventId];
      
      if (!eventDetail) {
        console.error(`[Guests] Event details not found for ${eventId}`);
        throw new Error(`Event details not found for ${eventId}`);
      }

      // 获取或初始化当前事件的guests处理状态
      let guestsState = state.currentEventGuests;
      if (!guestsState || guestsState.eventId !== eventId) {
        console.log(`[Guests] Initializing guests state for event "${eventDetail.name}"`);
        guestsState = {
          eventId,
          hasMore: true,
          processedCount: 0
        };
      }

      // 如果这个事件的所有guests都处理完了，返回
      if (!guestsState.hasMore) {
        console.log(`[Guests] All guests for event "${eventDetail.name}" have been processed`);
        return;
      }

      // 获取一批guests
      console.log(`[Guests] Fetching guests for event "${eventDetail.name}" with cursor: ${guestsState.nextCursor}`);
      const guestsResponse = await this.lumaService.getEventGuests(
        eventId,
        guestsState.nextCursor,
        this.GUESTS_PER_FETCH
      );
      console.log(`[Guests] Fetched ${guestsResponse.entries.length} guests for event "${eventDetail.name}"`);

      // 同步到Google Sheets
      const guestsData = guestsResponse.entries.map(entry => [
        entry.guest.api_id,
        entry.guest.user_name,
        entry.guest.user_email,
        eventId,
        eventDetail.name
      ]);
      console.log('[Guests] Prepared guests data:', JSON.stringify(guestsData));
      
      await (this.sheetsService as any).writeToSheet('Guests', guestsData);
      console.log(`[Guests] Successfully wrote guests data to Google Sheets for event "${eventDetail.name}"`);

      // 更新guests处理状态
      await this.updateState({
        currentEventGuests: {
          eventId,
          nextCursor: guestsResponse.next_cursor,
          hasMore: guestsResponse.has_more,
          processedCount: guestsState.processedCount + guestsResponse.entries.length
        }
      });
      console.log(`[Guests] Updated guests state for event "${eventDetail.name}"`);

      // 如果还有更多guests，不更新lastProcessedIndex，这样下次还会处理这个事件
      if (guestsResponse.has_more) {
        console.log(`[Guests] More guests available for event "${eventDetail.name}"`);
        return;
      }

      // 如果这个事件的所有guests都处理完了，清除guests状态并更新lastProcessedIndex
      console.log(`[Guests] All guests processed for event "${eventDetail.name}", moving to next event`);
      await this.updateState({
        currentEventGuests: undefined,
        lastProcessedIndex: state.lastProcessedIndex + 1
      });

    } catch (error) {
      console.error(`[Guests] Failed to process guests for event ${eventId}:`, error);
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

      // 同步到 Google Sheets
      await (this.sheetsService as any).writeToSheet('Events', eventsResponse.entries.map(e => [
        e.event.api_id,
        e.event.name,
        e.event.start_at,
        e.event.end_at
      ]));

      console.log(`Fetched and synced ${eventsResponse.entries.length} events`);
    } catch (error) {
      console.error('Failed to fetch events batch:', error);
      throw error;
    }
  }

  // Process pending events
  public async processPendingEvents(): Promise<void> {
    const state = await this.initState();
    const { pendingEvents, lastProcessedIndex, currentStage } = state;
    
    console.log(`[Process] Current stage: ${currentStage}, Last processed index: ${lastProcessedIndex}, Total events: ${pendingEvents.length}`);
    
    if (lastProcessedIndex >= pendingEvents.length) {
      console.log(`[Process] Last processed index (${lastProcessedIndex}) >= Total events (${pendingEvents.length})`);
      
      if (currentStage === 'events') {
        if (state.hasMore) {
          console.log('[Process] More events available, fetching next batch...');
          await this.fetchNextBatch();
          return;
        }
        // 开始处理事件详情
        console.log('[Process] Moving to details stage...');
        await this.updateState({
          currentStage: 'details',
          lastProcessedIndex: 0
        });
        return;
      } else if (currentStage === 'details') {
        // 开始处理参与者
        console.log('[Process] Moving to guests stage...');
        await this.updateState({
          currentStage: 'guests',
          lastProcessedIndex: 0
        });
        return;
      } else if (currentStage === 'guests') {
        console.log('[Process] All stages completed');
        await this.updateState({
          currentStage: 'completed'
        });
        return;
      }
    }

    // 处理当前批次
    await this.processBatch(currentStage);
  }

  private async processBatch(stage: string): Promise<void> {
    const state = await this.initState();
    const { pendingEvents, lastProcessedIndex } = state;
    
    console.log(`[Batch] Processing ${stage} stage, starting from index ${lastProcessedIndex}`);
    
    const batch = pendingEvents.slice(
      lastProcessedIndex,
      lastProcessedIndex + this.BATCH_SIZE
    );

    console.log(`[Batch] Processing batch of ${batch.length} events`);

    for (const eventId of batch) {
      try {
        if (stage === 'details') {
          console.log(`[Batch] Processing details for event ${eventId}`);
          await this.processEventDetails(eventId);
        } else if (stage === 'guests') {
          console.log(`[Batch] Processing guests for event ${eventId}`);
          await this.processEventGuests(eventId);
        }
      } catch (error) {
        console.error(`[Batch] Failed to process event ${eventId}:`, error);
        await this.updateState({
          failedEvents: [...state.failedEvents, eventId]
        });
      }
    }

    // guests 阶段只在没有 currentEventGuests 时才更新 lastProcessedIndex
    if (stage !== 'guests' || !state.currentEventGuests) {
      const newIndex = lastProcessedIndex + batch.length;
      console.log(`[Batch] Updating lastProcessedIndex from ${lastProcessedIndex} to ${newIndex}`);
      await this.updateState({
        lastProcessedIndex: newIndex
      });
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
} 