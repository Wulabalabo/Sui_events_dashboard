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
  eventDetails: { [key: string]: { name: string, processed: boolean } };
  nextCursor?: string;  // 添加分页游标
  hasMore: boolean;     // 是否还有更多数据
  // 日期范围参数（用于分页查询时保持一致性）
  dateRange?: {
    after?: string;
    before?: string;
  };
  // 添加guests处理状态
  currentEventGuests?: {
    eventId: string;
    nextCursor?: string;
    hasMore: boolean;
    processedCount: number;
  };
  // 累积所有guests数据
  allGuestsData: any[][];
  // Guests表是否已完成初始化写入（用于首批清空/后续追加）
  guestsSheetInitialized?: boolean;
}

export class SyncService {
  private readonly BATCH_SIZE = 1;
  private readonly EVENTS_PER_FETCH = 50;
  private readonly GUESTS_PER_FETCH = 50;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;
  private readonly GUESTS_FLUSH_THRESHOLD = 500;

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
        hasMore: true,
        dateRange: undefined,
        allGuestsData: [],
        guestsSheetInitialized: false
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

  // 验证同步环境
  private async validateSyncEnvironment(): Promise<void> {
    try {
      await this.logWithTimestamp('Validating sync environment...');
      
      // 检查Google Sheets设置
      const validation = await (this.sheetsService as any).validateSheetsSetup();
      
      if (!validation.isValid) {
        await this.logWithTimestamp('Missing required sheets, attempting to create them...');
        
        // 尝试自动创建缺失的工作表
        await (this.sheetsService as any).ensureAllSheetsExist();
        
        await this.logWithTimestamp('Successfully created missing sheets');
      } else {
        await this.logWithTimestamp('All required sheets exist');
      }
      
    } catch (error) {
      await this.logWithTimestamp('Failed to validate sync environment', error);
      throw new Error(`Sync environment validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Get all events and start sync - 添加环境验证
  public async queueAllEvents(after?: string, before?: string): Promise<void> {
    try {
      // 验证同步环境
      await this.validateSyncEnvironment();
      
      await this.logWithTimestamp('Starting to fetch all events...');
      
      let allEvents: any[] = [];
      let nextCursor: string | undefined = undefined;
      let hasMore = true;
      let batchCount = 0;
      let isFirst = true;
      
      // 循环获取所有事件数据
      while (hasMore) {
        batchCount++;
        await this.logWithTimestamp(`Fetching events batch ${batchCount}...`);
        let eventsResponse;
        if (isFirst) {
          eventsResponse = await this.lumaService.getAllEvents(
            'start_at',
            'desc',
            undefined,
            this.EVENTS_PER_FETCH,
            after,
            before
          );
          isFirst = false;
        } else {
          // 后续分页查询也需要传递日期范围参数
          eventsResponse = await this.lumaService.getAllEvents(
            'start_at',
            'desc',
            nextCursor,
            this.EVENTS_PER_FETCH,
            after,
            before
          );
        }
        
        await this.logWithTimestamp(`Batch ${batchCount}: Found ${eventsResponse.entries.length} events`);
        
        // 累积所有事件数据
        allEvents = allEvents.concat(eventsResponse.entries);
        
        // 更新分页状态
        nextCursor = eventsResponse.next_cursor;
        hasMore = eventsResponse.has_more;
        
        // 添加延迟避免API限制
        if (hasMore) {
          await this.delay(1000);
        }
      }
      
      await this.logWithTimestamp(`Total events fetched: ${allEvents.length} in ${batchCount} batches`);

      // 更新状态 - 保留分页信息用于后续增量同步
      await this.updateState({
        currentStage: 'events',
        pendingEvents: allEvents.map(e => e.event.api_id),
        lastProcessedIndex: 0,
        lastSyncTime: Date.now(),
        eventDetails: {},
        nextCursor: nextCursor,  // 保留最后的 cursor
        hasMore: hasMore,        // 保留 hasMore 状态
        // 保存日期范围参数，用于后续分页查询
        dateRange: {
          after: after,
          before: before
        },
        // 新一轮同步，重置 Guests 写入状态
        guestsSheetInitialized: false,
        allGuestsData: []
      });

      // 写入所有 events 数据
      const eventsData = allEvents.map(e => [
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
      
      await this.logWithTimestamp('All events synced to Google Sheets');

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

  // Process event details - 移除hosts处理逻辑
  private async processEventDetails(eventId: string): Promise<void> {
    try {
      await this.logWithTimestamp(`Starting to process details for event ${eventId}`);
      const details = await this.lumaService.getEventDetails(eventId);
      const state = await this.initState();
      
      // 只保存事件详细信息，不再处理hosts数据
      await this.updateState({
        eventDetails: {
          ...state.eventDetails,
          [eventId]: { 
            name: details.event.name,
            processed: true
          }
        }
      });
      
      await this.logWithTimestamp(`Event ${eventId} details processed successfully`);
    } catch (error) {
      await this.logWithTimestamp(`Failed to process event ${eventId} details`, error);
      throw error;
    }
  }

  // Process event guests
  private async processEventGuests(eventId: string): Promise<void> {
    try {
      await this.logWithTimestamp(`Starting to process guests for event ${eventId}`);
      const state = await this.initState();

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
        
        // 使用原子操作更新状态，避免竞态条件
        // 先读取当前状态，然后原子性地更新
        const currentState = await this.initState();
        
        // 去重：检查是否已经存在相同的guest（基于api_id）
        const existingGuestIds = new Set(
          currentState.allGuestsData.map(row => row[0]) // api_id是第0列
        );
        const newGuestsData = guestsData.filter(row => !existingGuestIds.has(row[0]));
        
        if (newGuestsData.length === 0) {
          await this.logWithTimestamp(`All ${guestsResponse.entries.length} guests for event ${eventId} are duplicates, skipping`);
        } else {
          // 累积去重后的guests数据到状态中
          const updatedAllGuestsData = [...currentState.allGuestsData, ...newGuestsData];
          await this.updateState({ allGuestsData: updatedAllGuestsData });
          await this.logWithTimestamp(`Accumulated ${newGuestsData.length} new guests for event ${eventId} (${guestsResponse.entries.length - newGuestsData.length} duplicates skipped), total guests: ${updatedAllGuestsData.length}`);

          // 达到阈值则分批写入（流式冲洗）
          // 注意：传递当前要写入的数据，而不是从状态重新读取
          if (updatedAllGuestsData.length >= this.GUESTS_FLUSH_THRESHOLD) {
            await this.flushGuestsBuffer(false);
          }
        }
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

  // 冲洗 Guests 缓冲区（首批清空，后续追加）
  // 使用原子操作确保不会重复写入
  private async flushGuestsBuffer(isFinal: boolean): Promise<void> {
    // 原子性地读取并清空缓冲区
    const currentState = await this.initState();
    const buffer = currentState.allGuestsData || [];
    
    if (!buffer.length) {
      await this.logWithTimestamp(`No guests buffer to flush${isFinal ? ' (final)' : ''}`);
      return;
    }

    // 立即清空缓冲区，避免重复写入
    await this.updateState({ allGuestsData: [] });

    const initialized = Boolean(currentState.guestsSheetInitialized);
    await this.logWithTimestamp(`Flushing guests buffer (${buffer.length} rows) - initialized: ${initialized}, final: ${isFinal}`);

    try {
      if (!initialized) {
        // 首次：清空并写入
        await this.sheetsService.batchWriteToSheet('Guests', buffer, false);
        await this.updateState({ guestsSheetInitialized: true });
      } else {
        // 追加写入
        await this.sheetsService.batchWriteToSheet('Guests', buffer, true);
      }
      
      await this.logWithTimestamp(`Successfully flushed ${buffer.length} guests rows to Google Sheets`);
    } catch (error) {
      // 如果写入失败，恢复缓冲区以便重试
      await this.logWithTimestamp(`Failed to flush guests buffer, restoring buffer for retry`, error);
      const stateAfterError = await this.initState();
      await this.updateState({ allGuestsData: [...stateAfterError.allGuestsData, ...buffer] });
      throw error;
    }
  }

  // 获取下一批事件
  // 注意：这个方法现在只用于增量同步场景，正常情况下不会调用
  // queueAllEvents已经一次性获取并写入了所有事件
  public async fetchNextBatch(): Promise<void> {
    const state = await this.initState();
    
    if (!state.hasMore && state.currentStage === 'events') {
      await this.logWithTimestamp('All events have been fetched');
      return;
    }

    try {
      await this.logWithTimestamp('Fetching next batch of events...');
      
      // 从状态中读取日期范围参数
      const dateRange = state.dateRange;
      
      const eventsResponse = await this.lumaService.getAllEvents(
        'start_at',
        'desc',
        state.nextCursor,
        this.EVENTS_PER_FETCH,
        dateRange?.after,
        dateRange?.before
      );

      await this.logWithTimestamp(`Fetched ${eventsResponse.entries.length} events in this batch`);

      // 更新状态
      await this.updateState({
        pendingEvents: [...state.pendingEvents, ...eventsResponse.entries.map(e => e.event.api_id)],
        nextCursor: eventsResponse.next_cursor,
        hasMore: eventsResponse.has_more,
        lastSyncTime: Date.now()
      });

      // 注意：这里不应该再次写入Events数据，因为queueAllEvents已经一次性写入了所有事件
      // 如果这是增量同步场景，应该只在获取完所有事件后再写入
      // 为了安全起见，我们不再在这里写入Events数据，避免重复
      await this.logWithTimestamp(`Fetched ${eventsResponse.entries.length} events (not writing to avoid duplicates)`);
    } catch (error) {
      await this.logWithTimestamp('Failed to fetch events batch', error);
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
          // queueAllEvents已经一次性获取并写入了所有事件，直接进入guests阶段
          // 不再调用fetchNextBatch，因为所有事件已经处理完成
          await this.logWithTimestamp(`All events processed, moving directly to guests processing stage`);
          await this.updateState({
            currentStage: 'guests',
            lastProcessedIndex: 0
          });
          return;
        } else if (currentStage === 'details') {
          // 兼容旧状态：如果还在 details，则直接进入 guests
          await this.logWithTimestamp(`Skipping details stage, moving to guests processing stage`);
          await this.updateState({
            currentStage: 'guests',
            lastProcessedIndex: 0
          });
          return;
        } else if (currentStage === 'guests') {
          await this.logWithTimestamp(`Guests processing completed, flushing remaining guests buffer`);
          await this.flushGuestsBuffer(true);
          
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
    
    // 计算整体进度，考虑所有阶段
    let overallProgress = 0;
    
    if (totalEvents > 0) {
      const processedEvents = state.lastProcessedIndex;
      const eventsWeight = 0.2;
      const guestsWeight = 0.8;

      if (state.currentStage === 'events') {
        overallProgress = (processedEvents / totalEvents) * eventsWeight * 100;
      } else if (state.currentStage === 'guests') {
        const baseProgress = eventsWeight * 100; // 事件阶段视为已完成
        let guestsProgress = (processedEvents / totalEvents) * guestsWeight * 100;
        if (state.currentEventGuests && state.currentEventGuests.processedCount > 0) {
          // 给正在处理的当前事件一点额外进度权重（粗略估算）
          guestsProgress = Math.min(guestsProgress + (guestsWeight * 100) / totalEvents * 0.5, guestsWeight * 100);
        }
        overallProgress = baseProgress + guestsProgress;
      } else if (state.currentStage === 'completed') {
        overallProgress = 100;
      }
    }
    
    // 确保进度在0-100之间
    overallProgress = Math.max(0, Math.min(100, overallProgress));

    return {
      lastSyncTime: state.lastSyncTime,
      currentStage: state.currentStage,
      totalEvents,
      processedEvents: state.lastProcessedIndex,
      failedEvents: state.failedEvents.length,
      progress: overallProgress
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
      dateRange: undefined,
      currentEventGuests: undefined,
      allGuestsData: [],
      guestsSheetInitialized: false
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
        dateRange: undefined,
        currentEventGuests: undefined,
        allGuestsData: [],
        guestsSheetInitialized: false
      });
      
      console.log('Sync state cleaned up successfully');
    } catch (error) {
      console.error('Failed to cleanup sync state:', error);
      throw error;
    }
  }

  // 优化批量写入方法
  private async batchWriteToSheet(sheetName: string, rows: any[][], useOptimized: boolean = true) {
    if (!rows || rows.length === 0) {
      await this.logWithTimestamp(`No data to write to ${sheetName}`);
      return;
    }

    try {
      await this.logWithTimestamp(`Starting to write ${rows.length} rows to ${sheetName}`);
      
      if (useOptimized) {
        // 使用优化的批量写入方法
        await this.sheetsService.batchWriteToSheet(sheetName, rows);
      } else {
        // 使用传统的分批写入方法
        await this.legacyBatchWrite(sheetName, rows);
      }
      
      await this.logWithTimestamp(`Successfully wrote all ${rows.length} rows to ${sheetName}`);
    } catch (error) {
      await this.logWithTimestamp(`Failed to write to ${sheetName}`, error);
      throw error;
    }
  }

  // 传统的分批写入方法（作为备用）
  private async legacyBatchWrite(sheetName: string, rows: any[][]) {
    const BATCH_SIZE = 50;
    const DELAY = 1000;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      let retryCount = 0;
      
      while (retryCount < this.MAX_RETRIES) {
        try {
          await this.logWithTimestamp(`Writing batch ${Math.floor(i/BATCH_SIZE) + 1} to ${sheetName}`);
          
          // 使用 GoogleSheetsService 的 writeToSheet 方法
          await this.sheetsService.writeToSheet(sheetName, batch);
          
          await this.logWithTimestamp(`Successfully wrote batch ${Math.floor(i/BATCH_SIZE) + 1} to ${sheetName}`);
          break;
        } catch (error) {
          retryCount++;
          await this.logWithTimestamp(`Failed to write batch to ${sheetName}, retry ${retryCount}/${this.MAX_RETRIES}`, error);
          
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

  // 优化的事件同步方法 - 移除hosts参数
  public async syncEventsOptimized(events: any[], guests: any[], useIncremental: boolean = false): Promise<void> {
    try {
      await this.logWithTimestamp('Starting optimized events sync...');
      
      if (useIncremental) {
        // 使用增量更新
        await (this.sheetsService as any).syncEventsOptimized(events, guests, true);
      } else {
        // 使用批量更新
        await (this.sheetsService as any).syncEventsOptimized(events, guests, false);
      }
      
      await this.logWithTimestamp('Optimized events sync completed');
    } catch (error) {
      await this.logWithTimestamp('Failed to sync events optimized', error);
      throw error;
    }
  }

  // 简化的事件同步方法 - 移除hosts参数
  public async syncEvents(events: any[], guests: any[]): Promise<void> {
    try {
      await this.logWithTimestamp('Starting events sync...');
      
      // 使用传统同步方法
      await (this.sheetsService as any).syncEvents(events, guests);
      
      await this.logWithTimestamp('Events sync completed');
    } catch (error) {
      await this.logWithTimestamp('Failed to sync events', error);
      throw error;
    }
  }
} 