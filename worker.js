var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/services/luma.ts
var RateLimiter = class {
  static {
    __name(this, "RateLimiter");
  }
  tokens;
  lastRefill;
  maxTokens;
  refillRate;
  // tokens per millisecond
  minDelay;
  // 最小请求间隔（毫秒）
  lastRequestTime;
  constructor(maxTokensPerMinute) {
    this.maxTokens = maxTokensPerMinute;
    this.tokens = maxTokensPerMinute;
    this.lastRefill = Date.now();
    this.lastRequestTime = 0;
    this.refillRate = maxTokensPerMinute / (60 * 1e3);
    this.minDelay = 1e3 / (maxTokensPerMinute / 60);
  }
  async acquireToken() {
    while (true) {
      this.refillTokens();
      if (this.tokens > 0) {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minDelay) {
          await new Promise((resolve) => {
            const checkInterval = Math.min(100, this.minDelay - timeSinceLastRequest);
            const check = /* @__PURE__ */ __name(() => {
              if (Date.now() - this.lastRequestTime >= this.minDelay) {
                resolve(void 0);
              } else {
                setTimeout(check, checkInterval);
              }
            }, "check");
            check();
          });
        }
        this.tokens--;
        this.lastRequestTime = Date.now();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  refillTokens() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const newTokens = timePassed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
};
var LumaService = class {
  // 10秒超时
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.rateLimiter = new RateLimiter(300);
  }
  static {
    __name(this, "LumaService");
  }
  rateLimiter;
  MAX_CONCURRENT_REQUESTS = 3;
  // 降低并发数
  activeRequests = 0;
  REQUEST_TIMEOUT = 1e4;
  async fetchWithAuth(url, options = {}) {
    while (this.activeRequests >= this.MAX_CONCURRENT_REQUESTS) {
      await new Promise((resolve) => setTimeout(resolve, 50));
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
          "x-luma-api-key": this.apiKey,
          "accept": "application/json",
          ...options.headers
        }
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Luma API request failed: ${response.status} ${await response.text()}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timeout");
      }
      throw error;
    } finally {
      this.activeRequests--;
    }
  }
  // 修改分页获取方法，添加错误重试
  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await this.fetchWithAuth(url);
        return await response.json();
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1e3));
      }
    }
    throw new Error("Max retries exceeded");
  }
  async getAllEvents(sortColumn = "start_at", sortDirection = "desc", paginationCursor, paginationLimit = 50, after, before) {
    console.log("Fetching events list...", paginationCursor ? `(next page: ${paginationCursor})` : "");
    const queryParams = new URLSearchParams({
      sort_column: sortColumn,
      sort_direction: sortDirection,
      pagination_limit: paginationLimit.toString(),
      ...paginationCursor && { pagination_cursor: paginationCursor },
      ...after && { after },
      ...before && { before }
    });
    const response = await this.fetchWithAuth(
      `https://api.lu.ma/public/v1/calendar/list-events?${queryParams}`
    );
    return await response.json();
  }
  async getEventGuests(eventId, paginationCursor, limit = 50) {
    console.log(`Fetching guests for event ${eventId}...`, paginationCursor ? `(next page: ${paginationCursor})` : "");
    const queryParams = new URLSearchParams({
      pagination_limit: limit.toString(),
      ...paginationCursor && { pagination_cursor: paginationCursor }
    });
    const response = await this.fetchWithAuth(
      `https://public-api.lu.ma/public/v1/event/get-guests?event_api_id=${eventId}&${queryParams}`
    );
    return await response.json();
  }
  async getEventDetails(eventId) {
    console.log(`Fetching details for event ${eventId}...`);
    const response = await this.fetchWithAuth(
      `https://public-api.lu.ma/public/v1/event/get?api_id=${eventId}`
    );
    return await response.json();
  }
  async getEvent(eventId) {
    const response = await fetch(`https://public-api.lu.ma/public/v1/event/get?event_id=${eventId}`, {
      headers: {
        "x-luma-api-key": this.apiKey,
        "accept": "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`\u83B7\u53D6\u4E8B\u4EF6\u8BE6\u60C5\u5931\u8D25: ${response.statusText}`);
    }
    const data = await response.json();
    return {
      event: data.event,
      hosts: data.hosts.map((host) => ({
        api_id: host.api_id,
        name: host.name,
        email: host.email,
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      }))
    };
  }
};

// src/services/sync.ts
var SyncService = class {
  constructor(lumaService, sheetsService, state) {
    this.lumaService = lumaService;
    this.sheetsService = sheetsService;
    this.state = state;
  }
  static {
    __name(this, "SyncService");
  }
  BATCH_SIZE = 1;
  EVENTS_PER_FETCH = 50;
  GUESTS_PER_FETCH = 50;
  MAX_RETRIES = 3;
  RETRY_DELAY = 1e3;
  // Initialize sync state
  async initState() {
    let state = await this.state.storage.get("syncState");
    if (!state) {
      state = {
        lastSyncTime: 0,
        currentStage: "events",
        pendingEvents: [],
        failedEvents: [],
        lastProcessedIndex: 0,
        eventDetails: {},
        hasMore: true
      };
      await this.state.storage.put("syncState", state);
    }
    return state;
  }
  // Update sync state
  async updateState(updates) {
    const state = await this.initState();
    const newState = { ...state, ...updates };
    await this.state.storage.put("syncState", newState);
  }
  // Delay function
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  // Get all events and start sync
  async queueAllEvents(after, before) {
    try {
      await this.logWithTimestamp("Starting to fetch all events...");
      const eventsResponse = await this.lumaService.getAllEvents(
        "start_at",
        "desc",
        void 0,
        this.EVENTS_PER_FETCH,
        after,
        before
      );
      await this.logWithTimestamp(`Found ${eventsResponse.entries.length} events`);
      await this.updateState({
        currentStage: "events",
        pendingEvents: eventsResponse.entries.map((e) => e.event.api_id),
        lastProcessedIndex: 0,
        lastSyncTime: Date.now(),
        eventDetails: {},
        nextCursor: eventsResponse.next_cursor,
        hasMore: eventsResponse.has_more
      });
      const eventsData = eventsResponse.entries.map((e) => [
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
        e.event.geo_address_json?.address || "",
        e.event.geo_latitude,
        e.event.geo_longitude,
        e.event.created_at,
        e.event.updated_at
      ]);
      await this.batchWriteToSheet("Events", eventsData);
      await this.logWithTimestamp("Events list synced to Google Sheets");
      await this.processPendingEvents();
    } catch (error) {
      await this.logWithTimestamp("Failed to fetch events list", error);
      throw error;
    }
  }
  // 添加详细的日志记录
  async logWithTimestamp(message, data) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data) : "");
  }
  // Process event details and hosts
  async processEventDetails(eventId) {
    try {
      await this.logWithTimestamp(`Starting to process details for event ${eventId}`);
      const details = await this.lumaService.getEventDetails(eventId);
      const state = await this.initState();
      if (details.hosts && details.hosts.length > 0) {
        const hostsData = details.hosts.map((host) => [
          host.api_id,
          eventId,
          host.event_name || "",
          host.name,
          host.email,
          host.first_name || "",
          host.last_name || "",
          host.avatar_url || "",
          host.created_at,
          host.updated_at
        ]);
        await this.batchWriteToSheet("Hosts", hostsData);
        await this.logWithTimestamp(`Wrote ${details.hosts.length} hosts for event ${eventId}`);
      }
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
  async processEventGuests(eventId) {
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
          nextCursor: void 0
        };
      }
      if (!guestsState.hasMore) {
        await this.logWithTimestamp(`All guests for event ${eventId} have been processed`);
        return;
      }
      const guestsResponse = await this.lumaService.getEventGuests(
        eventId,
        guestsState.nextCursor,
        this.GUESTS_PER_FETCH
      );
      if (guestsResponse.entries.length > 0) {
        const guestsData = guestsResponse.entries.map((entry) => [
          entry.guest.api_id,
          eventId,
          entry.guest.user_name,
          entry.guest.user_email,
          entry.guest.user_first_name || "",
          entry.guest.user_last_name || "",
          entry.guest.approval_status,
          entry.guest.checked_in_at || "",
          entry.guest.check_in_qr_code || "",
          entry.guest.created_at,
          entry.guest.updated_at
        ]);
        await this.batchWriteToSheet("Guests", guestsData);
        await this.logWithTimestamp(`Wrote ${guestsResponse.entries.length} guests for event ${eventId}`);
      }
      const newGuestsState = {
        eventId,
        nextCursor: guestsResponse.next_cursor,
        hasMore: guestsResponse.has_more,
        processedCount: guestsState.processedCount + guestsResponse.entries.length
      };
      await this.updateState({
        currentEventGuests: newGuestsState
      });
      if (!guestsResponse.has_more) {
        await this.logWithTimestamp(`All guests processed for event ${eventId}, moving to next event`);
        const currentState = await this.initState();
        await this.updateState({
          currentEventGuests: void 0,
          lastProcessedIndex: currentState.lastProcessedIndex + 1
        });
      }
    } catch (error) {
      await this.logWithTimestamp(`Failed to process guests for event ${eventId}`, error);
      throw error;
    }
  }
  // 获取下一批事件
  async fetchNextBatch() {
    const state = await this.initState();
    if (!state.hasMore && state.currentStage === "events") {
      console.log("All events have been fetched");
      return;
    }
    try {
      console.log("Fetching next batch of events...");
      const eventsResponse = await this.lumaService.getAllEvents(
        "start_at",
        "desc",
        state.nextCursor,
        this.EVENTS_PER_FETCH
      );
      await this.updateState({
        pendingEvents: [...state.pendingEvents, ...eventsResponse.entries.map((e) => e.event.api_id)],
        nextCursor: eventsResponse.next_cursor,
        hasMore: eventsResponse.has_more,
        lastSyncTime: Date.now()
      });
      const eventsData = eventsResponse.entries.map((e) => [
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
        e.event.geo_address_json?.address || "",
        e.event.geo_latitude,
        e.event.geo_longitude,
        e.event.created_at,
        e.event.updated_at
      ]);
      await this.sheetsService.writeToSheet("Events", eventsData);
      console.log(`Fetched and synced ${eventsResponse.entries.length} events`);
    } catch (error) {
      console.error("Failed to fetch events batch:", error);
      throw error;
    }
  }
  // Process pending events
  async processPendingEvents() {
    try {
      const state = await this.initState();
      const { pendingEvents, lastProcessedIndex, currentStage } = state;
      await this.logWithTimestamp(`Starting to process pending events, current stage: ${currentStage}, processed: ${lastProcessedIndex}, total: ${pendingEvents.length}`);
      if (lastProcessedIndex >= pendingEvents.length) {
        await this.logWithTimestamp(`Current batch processing completed, checking next stage`);
        if (currentStage === "events") {
          if (state.hasMore) {
            await this.logWithTimestamp(`More events available, fetching next batch`);
            await this.fetchNextBatch();
            return;
          }
          await this.logWithTimestamp(`Moving to details processing stage`);
          await this.updateState({
            currentStage: "details",
            lastProcessedIndex: 0
          });
          return;
        } else if (currentStage === "details") {
          await this.logWithTimestamp(`Moving to guests processing stage`);
          await this.updateState({
            currentStage: "guests",
            lastProcessedIndex: 0
          });
          return;
        } else if (currentStage === "guests") {
          await this.logWithTimestamp(`All stages completed`);
          await this.updateState({
            currentStage: "completed"
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
  async processBatch(stage) {
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
          if (stage === "details") {
            await this.processEventDetails(eventId);
          } else if (stage === "guests") {
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
      if (stage !== "guests" || !state.currentEventGuests) {
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
  async getStatus() {
    const state = await this.initState();
    const totalEvents = state.pendingEvents.length;
    const processedEvents = state.lastProcessedIndex;
    const progress = totalEvents > 0 ? processedEvents / totalEvents * 100 : 0;
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
  async stopSync() {
    const state = await this.initState();
    await this.updateState({
      currentStage: "completed",
      lastProcessedIndex: state.pendingEvents.length
    });
    console.log("Sync stopped");
  }
  // 重置同步状态
  async resetSync() {
    await this.updateState({
      lastSyncTime: 0,
      currentStage: "events",
      pendingEvents: [],
      failedEvents: [],
      lastProcessedIndex: 0,
      eventDetails: {},
      hasMore: true,
      currentEventGuests: void 0
    });
    console.log("Sync state reset");
  }
  async cleanup() {
    try {
      await this.state.storage.put("syncState", {
        lastSyncTime: 0,
        currentStage: "events",
        pendingEvents: [],
        failedEvents: [],
        lastProcessedIndex: 0,
        eventDetails: {},
        hasMore: true,
        currentEventGuests: void 0
      });
      console.log("Sync state cleaned up successfully");
    } catch (error) {
      console.error("Failed to cleanup sync state:", error);
      throw error;
    }
  }
  // 优化批量写入方法
  async batchWriteToSheet(sheetName, rows) {
    if (!rows || rows.length === 0) {
      await this.logWithTimestamp(`No data to write to ${sheetName}`);
      return;
    }
    const BATCH_SIZE = 50;
    const DELAY = 1e3;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      let retryCount = 0;
      while (retryCount < this.MAX_RETRIES) {
        try {
          await this.logWithTimestamp(`Writing batch ${i / BATCH_SIZE + 1} to ${sheetName}`);
          await this.sheetsService.writeToSheet(sheetName, batch);
          await this.logWithTimestamp(`Successfully wrote batch ${i / BATCH_SIZE + 1} to ${sheetName}`);
          break;
        } catch (error) {
          retryCount++;
          await this.logWithTimestamp(`Failed to write to ${sheetName}, retry ${retryCount}/${this.MAX_RETRIES}`, error);
          if (retryCount === this.MAX_RETRIES) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY * retryCount));
        }
      }
      if (i + BATCH_SIZE < rows.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY));
      }
    }
  }
};

// src/services/googleSheets.ts
var GoogleSheetsService = class {
  static {
    __name(this, "GoogleSheetsService");
  }
  credentials;
  sheetId;
  constructor(clientEmail, privateKey, sheetId) {
    this.credentials = {
      client_email: clientEmail,
      private_key: privateKey
    };
    this.sheetId = sheetId;
  }
  // 将 base64 字符串转换为 URL 安全的 base64
  base64url(source) {
    return btoa(source).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  // 将 PEM 格式私钥转为 ArrayBuffer
  str2ab(pem) {
    try {
      let base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\\n/g, "").replace(/\r?\n/g, "").replace(/\s+/g, "").trim();
      if (base64.length < 100) {
        console.error("\u79C1\u94A5\u53EF\u80FD\u88AB\u622A\u65AD\u4E86\uFF0C\u957F\u5EA6:", base64.length);
        throw new Error("\u79C1\u94A5\u683C\u5F0F\u4E0D\u6B63\u786E");
      }
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    } catch (error) {
      console.error("\u5904\u7406\u79C1\u94A5\u65F6\u51FA\u9519:", error);
      throw error;
    }
  }
  // 获取 Google OAuth2 Access Token
  async getAccessToken() {
    const now = Math.floor(Date.now() / 1e3);
    const header = {
      alg: "RS256",
      typ: "JWT"
    };
    const payload = {
      iss: this.credentials.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    };
    console.log("\u51C6\u5907\u751F\u6210 JWT...");
    console.log("Client Email:", this.credentials.client_email);
    console.log("Private Key \u957F\u5EA6:", this.credentials.private_key.length);
    if (!this.credentials.private_key.includes("-----BEGIN PRIVATE KEY-----") || !this.credentials.private_key.includes("-----END PRIVATE KEY-----")) {
      throw new Error("\u79C1\u94A5\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u7F3A\u5C11 PEM \u5934\u5C3E");
    }
    const enc = new TextEncoder();
    const headerBase64 = this.base64url(JSON.stringify(header));
    const payloadBase64 = this.base64url(JSON.stringify(payload));
    const toSign = `${headerBase64}.${payloadBase64}`;
    const keyData = this.str2ab(this.credentials.private_key);
    let key;
    try {
      key = await crypto.subtle.importKey(
        "pkcs8",
        keyData,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      );
    } catch (error) {
      console.error("\u79C1\u94A5\u5BFC\u5165\u5931\u8D25:", error);
      throw new Error(`\u79C1\u94A5\u5BFC\u5165\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}`);
    }
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(toSign));
    const signatureBase64 = this.base64url(Array.from(new Uint8Array(signature)).map((b) => String.fromCharCode(b)).join(""));
    const jwt = `${toSign}.${signatureBase64}`;
    let retryCount = 0;
    const maxRetries = 3;
    let lastError = null;
    while (retryCount < maxRetries) {
      try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json"
          },
          body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`
        });
        if (!res.ok) {
          const errorText = await res.text();
          console.error(`\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\u5931\u8D25 (\u5C1D\u8BD5 ${retryCount + 1}/${maxRetries}):`, {
            status: res.status,
            statusText: res.statusText,
            error: errorText
          });
          if (res.status >= 500) {
            lastError = new Error(`\u670D\u52A1\u5668\u9519\u8BEF: ${res.status} ${errorText}`);
            retryCount++;
            if (retryCount < maxRetries) {
              const delay = Math.pow(2, retryCount) * 1e3;
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
          }
          throw new Error(`\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\u5931\u8D25: ${res.status} ${errorText}`);
        }
        const data = await res.json();
        if (!data.access_token) {
          throw new Error("\u54CD\u5E94\u4E2D\u6CA1\u6709\u8BBF\u95EE\u4EE4\u724C");
        }
        return data.access_token;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount++;
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 1e3;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError || new Error("\u83B7\u53D6\u8BBF\u95EE\u4EE4\u724C\u5931\u8D25\uFF0C\u5DF2\u8FBE\u5230\u6700\u5927\u91CD\u8BD5\u6B21\u6570");
  }
  // 写入数据到指定工作表
  async writeToSheet(sheetName, values) {
    try {
      const accessToken = await this.getAccessToken();
      console.log(`\u51C6\u5907\u5199\u5165 ${sheetName} \u5DE5\u4F5C\u8868...`);
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1:Z1000?valueInputOption=USER_ENTERED`;
      await fetch(clearUrl, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ values: [] })
      });
      console.log(`${sheetName} \u5DE5\u4F5C\u8868\u6570\u636E\u5DF2\u6E05\u7A7A`);
      const headers = this.getHeaders(sheetName);
      const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A1?valueInputOption=USER_ENTERED`;
      await fetch(headerUrl, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ values: [headers] })
      });
      console.log(`${sheetName} \u5DE5\u4F5C\u8868\u8868\u5934\u5DF2\u5199\u5165`);
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${sheetName}!A2:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const requestBody = {
        range: `${sheetName}!A2`,
        majorDimension: "ROWS",
        values
      };
      const response = await fetch(appendUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google Sheets API \u9519\u8BEF: ${response.status} ${errorText}`);
      }
      const result = await response.json();
      console.log(`${sheetName} \u5DE5\u4F5C\u8868\u6570\u636E\u5199\u5165\u6210\u529F:`, result);
    } catch (error) {
      console.error(`\u5199\u5165 ${sheetName} \u5DE5\u4F5C\u8868\u65F6\u53D1\u751F\u9519\u8BEF:`, error);
      throw error;
    }
  }
  getHeaders(sheetName) {
    switch (sheetName) {
      case "Events":
        return [
          "API ID",
          "Calendar API ID",
          "Name",
          "Description",
          "Description MD",
          "Cover URL",
          "Start At",
          "End At",
          "Timezone",
          "Duration Interval",
          "Meeting URL",
          "URL",
          "User API ID",
          "Visibility",
          "Zoom Meeting URL",
          "Geo Address",
          "Geo Latitude",
          "Geo Longitude",
          "Created At",
          "Updated At"
        ];
      case "Hosts":
        return [
          "Host ID",
          "Event ID",
          "Event Name",
          "Host Name",
          "Email",
          "First Name",
          "Last Name",
          "Avatar URL",
          "Created At",
          "Updated At"
        ];
      case "Guests":
        return [
          "API ID",
          "Event API ID",
          "User Name",
          "User Email",
          "User First Name",
          "User Last Name",
          "Approval Status",
          "Checked In At",
          "Check In QR Code",
          "Created At",
          "Updated At"
        ];
      default:
        return [];
    }
  }
  // 主同步方法
  async syncEvents(events, hosts, guests) {
    try {
      console.log("\u5F00\u59CB\u540C\u6B65\u5230 Google Sheets...");
      console.log("\u540C\u6B65\u4E8B\u4EF6\u6570\u636E...");
      await this.syncEventsData(events);
      console.log("\u540C\u6B65\u4E3B\u6301\u4EBA\u6570\u636E...");
      await this.syncHostsData(hosts);
      console.log("\u540C\u6B65\u53C2\u4E0E\u8005\u6570\u636E...");
      await this.syncGuestsData(guests);
      console.log("Google Sheets \u540C\u6B65\u5B8C\u6210");
    } catch (error) {
      console.error("\u540C\u6B65\u5230 Google Sheets \u65F6\u53D1\u751F\u9519\u8BEF:", error);
      throw error;
    }
  }
  // 同步事件数据
  async syncEventsData(events) {
    const headers = [
      "API ID",
      "Calendar API ID",
      "Name",
      "Description",
      "Description MD",
      "Cover URL",
      "Start At",
      "End At",
      "Timezone",
      "Duration Interval",
      "Meeting URL",
      "URL",
      "User API ID",
      "Visibility",
      "Zoom Meeting URL",
      "Geo Address",
      "Geo Latitude",
      "Geo Longitude",
      "Created At",
      "Updated At"
    ];
    const rows = events.map((event) => [
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
    await this.writeToSheet("Events", [headers, ...rows]);
  }
  // 同步主持人数据
  async syncHostsData(hosts) {
    const headers = [
      "Host ID",
      "Event ID",
      "Event Name",
      "Host Name",
      "Email",
      "First Name",
      "Last Name",
      "Avatar URL",
      "Created At",
      "Updated At"
    ];
    const rows = hosts.map((host) => [
      host.api_id,
      host.event_api_id,
      host.event_name || "",
      host.name,
      host.email,
      host.first_name || "",
      host.last_name || "",
      host.avatar_url || "",
      host.created_at,
      host.updated_at
    ]);
    await this.writeToSheet("Hosts", [headers, ...rows]);
  }
  // 同步参与者数据
  async syncGuestsData(guests) {
    const headers = [
      "API ID",
      "Event API ID",
      "User Name",
      "User Email",
      "User First Name",
      "User Last Name",
      "Approval Status",
      "Checked In At",
      "Check In QR Code",
      "Created At",
      "Updated At"
    ];
    const rows = guests.map((guest) => [
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
    await this.writeToSheet("Guests", [headers, ...rows]);
  }
  // 创建和初始化工作表
  async initializeSheets() {
    try {
      console.log("\u5F00\u59CB\u521D\u59CB\u5316 Google Sheets...");
      const accessToken = await this.getAccessToken();
      const createSheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}:batchUpdate`;
      const createSheetsBody = {
        requests: [
          {
            addSheet: {
              properties: {
                title: "Events",
                gridProperties: {
                  rowCount: 1e3,
                  columnCount: 20
                }
              }
            }
          },
          {
            addSheet: {
              properties: {
                title: "Hosts",
                gridProperties: {
                  rowCount: 1e3,
                  columnCount: 10
                }
              }
            }
          },
          {
            addSheet: {
              properties: {
                title: "Guests",
                gridProperties: {
                  rowCount: 1e3,
                  columnCount: 11
                }
              }
            }
          }
        ]
      };
      const createResponse = await fetch(createSheetsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(createSheetsBody)
      });
      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`\u521B\u5EFA\u5DE5\u4F5C\u8868\u5931\u8D25: ${createResponse.status} ${errorText}`);
      }
      console.log("\u5DE5\u4F5C\u8868\u521B\u5EFA\u6210\u529F");
      const eventsHeaders = [
        "API ID",
        "Calendar API ID",
        "Name",
        "Description",
        "Description MD",
        "Cover URL",
        "Start At",
        "End At",
        "Timezone",
        "Duration Interval",
        "Meeting URL",
        "URL",
        "User API ID",
        "Visibility",
        "Zoom Meeting URL",
        "Geo Address",
        "Geo Latitude",
        "Geo Longitude",
        "Created At",
        "Updated At"
      ];
      const hostsHeaders = [
        "Host ID",
        "Event ID",
        "Event Name",
        "Host Name",
        "Email",
        "First Name",
        "Last Name",
        "Avatar URL",
        "Created At",
        "Updated At"
      ];
      const guestsHeaders = [
        "API ID",
        "Event API ID",
        "User Name",
        "User Email",
        "User First Name",
        "User Last Name",
        "Approval Status",
        "Checked In At",
        "Check In QR Code",
        "Created At",
        "Updated At"
      ];
      await this.writeToSheet("Events", [eventsHeaders]);
      await this.writeToSheet("Hosts", [hostsHeaders]);
      await this.writeToSheet("Guests", [guestsHeaders]);
      console.log("\u8868\u5934\u5199\u5165\u6210\u529F");
    } catch (error) {
      console.error("\u521D\u59CB\u5316\u5DE5\u4F5C\u8868\u65F6\u53D1\u751F\u9519\u8BEF:", error);
      throw error;
    }
  }
};

// src/index.ts
var SyncState = class {
  static {
    __name(this, "SyncState");
  }
  syncService;
  staticFiles;
  processingInterval = null;
  constructor(state, env) {
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const sheetsService = new GoogleSheetsService(
      env.GOOGLE_CLIENT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_SHEET_ID
    );
    this.syncService = new SyncService(lumaService, sheetsService, state);
    this.staticFiles = {
      "index.html": `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sui Events Sync Status</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .status-card {
            margin-bottom: 20px;
            padding: 15px;
            border-radius: 6px;
            background-color: #f8f9fa;
        }
        .progress-bar {
            width: 100%;
            height: 20px;
            background-color: #e9ecef;
            border-radius: 10px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            height: 100%;
            background-color: #007bff;
            transition: width 0.3s ease;
        }
        .button {
            background-color: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin-right: 10px;
        }
        .button:hover {
            background-color: #0056b3;
        }
        .error {
            color: #dc3545;
        }
        .success {
            color: #28a745;
        }
        .timestamp {
            color: #6c757d;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Sui Events Sync Status</h1>
        
        <div class="status-card">
            <h2>Current Status</h2>
            <p>Stage: <span id="currentStage">-</span></p>
            <p>Progress: <span id="progress">0</span>%</p>
            <div class="progress-bar">
                <div class="progress-fill" id="progressBar" style="width: 0%"></div>
            </div>
            <p>Processed Events: <span id="processedEvents">0</span> / <span id="totalEvents">0</span></p>
            <p>Failed Events: <span id="failedEvents">0</span></p>
            <p>Last Sync: <span id="lastSyncTime">-</span></p>
        </div>

        <div class="status-card">
            <h2>Actions</h2>
            <div style="margin-bottom: 15px;">
                <label for="startDate" style="margin-right: 10px;">start date:</label>
                <input type="datetime-local" id="startDate" style="padding: 5px; border-radius: 4px; border: 1px solid #ccc;">
                <label for="endDate" style="margin-left: 15px; margin-right: 10px;">end date:</label>
                <input type="datetime-local" id="endDate" style="padding: 5px; border-radius: 4px; border: 1px solid #ccc;">
            </div>
            <button class="button" onclick="startSync()">Start Sync</button>
            <button class="button" onclick="stopSync()">Stop Sync</button>
            <button class="button" onclick="resetSync()">Reset Sync</button>
            <button class="button" onclick="cleanupSync()" style="background-color: #dc3545;">Cleanup State</button>
        </div>

        <div class="status-card">
            <h2>Logs</h2>
            <div id="logs" style="max-height: 200px; overflow-y: auto;"></div>
        </div>
    </div>

    <script>
        // Global variables
        let isPolling = false;
        let pollInterval = undefined;
        let lastError = null;
        let lastStatus = null;

        // Format date
        function formatDate(timestamp) {
            if (!timestamp) return '-';
            return new Date(timestamp).toLocaleString();
        }

        // Add log
        function addLog(message, type = 'info') {
            const logs = document.getElementById('logs');
            if (!logs) return;
            
            const logEntry = document.createElement('p');
            logEntry.className = type;
            logEntry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
            logs.insertBefore(logEntry, logs.firstChild);
        }

        // Update status
        async function updateStatus() {
            try {
                const response = await fetch('/api/sync/status', {
                    headers: {
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    }
                });
                
                if (!response.ok) {
                    throw new Error('HTTP error! status: ' + response.status);
                }
                
                const status = await response.json();
                
                // Update UI
                const currentStage = document.getElementById('currentStage');
                const progress = document.getElementById('progress');
                const progressBar = document.getElementById('progressBar');
                const processedEvents = document.getElementById('processedEvents');
                const totalEvents = document.getElementById('totalEvents');
                const failedEvents = document.getElementById('failedEvents');
                const lastSyncTime = document.getElementById('lastSyncTime');

                if (currentStage) currentStage.textContent = status.currentStage || '-';
                if (progress) progress.textContent = status.progress ? status.progress.toFixed(2) : '0';
                if (progressBar) progressBar.style.width = (status.progress || 0) + '%';
                if (processedEvents) processedEvents.textContent = String(status.processedEvents || '0');
                if (totalEvents) totalEvents.textContent = String(status.totalEvents || '0');
                if (failedEvents) failedEvents.textContent = String(status.failedEvents || '0');
                if (lastSyncTime) lastSyncTime.textContent = formatDate(status.lastSyncTime);

                // Log status changes
                if (status.currentStage !== lastStatus?.currentStage) {
                    addLog('Stage changed to: ' + status.currentStage, 'info');
                }
                if (status.progress !== lastStatus?.progress) {
                    addLog('Progress updated: ' + status.progress.toFixed(2) + '%', 'info');
                }

                // Check if completed
                if (status.currentStage === 'completed') {
                    stopPolling();
                    addLog('Sync completed!', 'success');
                }

                lastStatus = status;
                lastError = null;
            } catch (error) {
                const err = error;
                if (err.message !== lastError?.message) {
                    addLog('Failed to get status: ' + err.message, 'error');
                    lastError = err;
                }
            }
        }

        // Start polling
        function startPolling() {
            if (!isPolling) {
                isPolling = true;
                pollInterval = window.setInterval(updateStatus, 2000);
                addLog('Started polling for status updates');
                updateStatus(); // Execute immediately
            }
        }

        // Stop polling
        function stopPolling() {
            if (isPolling && pollInterval) {
                isPolling = false;
                clearInterval(pollInterval);
                addLog('Stopped polling for status updates');
            }
        }

        // Start sync
        async function startSync() {
            try {
                const startDate = document.getElementById('startDate').value;
                const endDate = document.getElementById('endDate').value;
                
                // \u8F6C\u6362\u4E3AISO 8601\u683C\u5F0F
                const after = startDate ? new Date(startDate).toISOString() : undefined;
                const before = endDate ? new Date(endDate).toISOString() : undefined;
                
                const response = await fetch('/api/sync/start', { 
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ after, before })
                });
                
                if (!response.ok) {
                    throw new Error('HTTP error! status: ' + response.status + ', body: ' + await response.text());
                }
                
                const result = await response.json();
                addLog(result.message || 'Sync started');
                startPolling();
            } catch (error) {
                const err = error;
                addLog('Failed to start sync: ' + err.message, 'error');
            }
        }

        // Stop sync
        async function stopSync() {
            try {
                const response = await fetch('/api/sync/stop', { 
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!response.ok) {
                    throw new Error('HTTP error! status: ' + response.status);
                }
                
                const result = await response.json();
                addLog(result.message || 'Sync stopped');
                stopPolling();
            } catch (error) {
                const err = error;
                addLog('Failed to stop sync: ' + err.message, 'error');
            }
        }

        // Reset sync
        async function resetSync() {
            try {
                const response = await fetch('/api/sync/reset', { 
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!response.ok) {
                    throw new Error('HTTP error! status: ' + response.status);
                }
                
                const result = await response.json();
                addLog(result.message || 'Sync reset');
                updateStatus();
            } catch (error) {
                const err = error;
                addLog('Failed to reset sync: ' + err.message, 'error');
            }
        }

        // Clean up sync state
        async function cleanupSync() {
            try {
                const response = await fetch('/api/sync/cleanup', { 
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!response.ok) {
                    throw new Error('HTTP error! status: ' + response.status);
                }
                
                const result = await response.json();
                addLog(result.message || 'Sync state cleaned up');
                updateStatus();
            } catch (error) {
                const err = error;
                addLog('Failed to cleanup sync state: ' + err.message, 'error');
            }
        }

        // Initial status load
        updateStatus();
    <\/script>
</body>
</html>`
    };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/process") {
      try {
        await this.syncService.processPendingEvents();
        return new Response(JSON.stringify({ message: "Processing completed" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Process events error:", error);
        return new Response(JSON.stringify({ error: "Process events error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    if (path === "/" || path === "/index.html") {
      return new Response(this.staticFiles["index.html"], {
        headers: { "Content-Type": "text/html" }
      });
    }
    if (path.startsWith("/api/sync")) {
      return this.handleSyncApi(path, request);
    }
    return new Response("Not Found", { status: 404 });
  }
  async handleSyncApi(path, request) {
    switch (path) {
      case "/api/sync/status":
        try {
          console.log("[API] Getting sync status...");
          const status = await this.syncService.getStatus();
          console.log("[API] Sync status:", status);
          return new Response(JSON.stringify(status), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "Pragma": "no-cache",
              "Expires": "0"
            }
          });
        } catch (error) {
          console.error("[API] Get status error:", error);
          return new Response(JSON.stringify({ error: "get status error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      case "/api/sync/start":
        if (request.method === "POST") {
          try {
            console.log("[API] Starting sync process...");
            const body = await request.json();
            const { after, before } = body;
            await this.syncService.queueAllEvents(after, before);
            this.startProcessing();
            console.log("[API] Sync process started");
            return new Response(JSON.stringify({ message: "sync started" }), {
              headers: { "Content-Type": "application/json" }
            });
          } catch (error) {
            console.error("[API] Start sync error:", error);
            return new Response(JSON.stringify({
              error: "start sync error: " + (error instanceof Error ? error.message : String(error)),
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : void 0,
              details: error
            }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
        break;
      case "/api/sync/stop":
        if (request.method === "POST") {
          try {
            console.log("[API] Stopping sync process...");
            await this.syncService.stopSync();
            this.stopProcessing();
            console.log("[API] Sync process stopped");
            return new Response(JSON.stringify({ message: "sync stopped" }), {
              headers: { "Content-Type": "application/json" }
            });
          } catch (error) {
            console.error("[API] Stop sync error:", error);
            return new Response(JSON.stringify({ error: "stop sync error" }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
        break;
      case "/api/sync/reset":
        if (request.method === "POST") {
          try {
            await this.syncService.resetSync();
            return new Response(JSON.stringify({ message: "sync reset" }), {
              headers: { "Content-Type": "application/json" }
            });
          } catch (error) {
            console.error("reset sync error:", error);
            return new Response(JSON.stringify({ error: "reset sync error" }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
        break;
      case "/api/sync/cleanup":
        if (request.method === "POST") {
          try {
            await this.syncService.cleanup();
            return new Response(JSON.stringify({ message: "Sync state cleaned up successfully" }), {
              headers: { "Content-Type": "application/json" }
            });
          } catch (error) {
            console.error("cleanup sync state error:", error);
            return new Response(JSON.stringify({ error: "cleanup sync state error" }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
        break;
    }
    return new Response("Method Not Allowed", { status: 405 });
  }
  startProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    this.processingInterval = setInterval(async () => {
      try {
        console.log("[Processing] Starting batch processing...");
        await this.syncService.processPendingEvents();
        console.log("[Processing] Batch processing completed");
      } catch (error) {
        console.error("[Processing] Error during batch processing:", error);
      }
    }, 5e3);
  }
  stopProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }
};
var index_default = {
  async fetch(request, env, ctx) {
    const id = env.SYNC_STATE.idFromName("sync-state");
    const syncState = env.SYNC_STATE.get(id);
    return syncState.fetch(request);
  },
  // Cron 触发器处理
  async scheduled(event, env, ctx) {
    const id = env.SYNC_STATE.idFromName("sync-state");
    const syncState = env.SYNC_STATE.get(id);
    await syncState.fetch(new Request("http://internal/process"));
  }
};
export {
  SyncState,
  index_default as default
};
//# sourceMappingURL=index.js.map
