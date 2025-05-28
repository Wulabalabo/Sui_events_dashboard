import { LumaService } from './services/luma';
import { SyncService } from './services/sync';
import { GoogleSheetsService } from './services/googleSheets';
import { Env } from './types';

// Cloudflare Workers 类型
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

interface SyncStatus {
  lastSyncTime: number;
  currentStage: string;
  totalEvents: number;
  processedEvents: number;
  failedEvents: number;
  progress: number;
}

// Durable Object 类
export class SyncState {
  private syncService: SyncService;
  private staticFiles: { [key: string]: string };
  private processingInterval: number | null = null;

  constructor(state: DurableObjectState, env: Env) {
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const sheetsService = new GoogleSheetsService(
      env.GOOGLE_CLIENT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_SHEET_ID
    );
    this.syncService = new SyncService(lumaService, sheetsService, state);

    // 初始化静态文件
    this.staticFiles = {
      'index.html': `<!DOCTYPE html>
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
                const response = await fetch('/api/sync/start', { 
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
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
    </script>
</body>
</html>`
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 处理内部处理请求
    if (path === '/process') {
      try {
        await this.syncService.processPendingEvents();
        // 如果处理完成，返回成功响应
        return new Response(JSON.stringify({ message: 'Processing completed' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Process events error:', error);
        return new Response(JSON.stringify({ error: 'Process events error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 处理静态文件
    if (path === '/' || path === '/index.html') {
      return new Response(this.staticFiles['index.html'], {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // API路由
    if (path.startsWith('/api/sync')) {
      return this.handleSyncApi(path, request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleSyncApi(path: string, request: Request): Promise<Response> {
    switch (path) {
      case '/api/sync/status':
        try {
          console.log('[API] Getting sync status...');
          const status = await this.syncService.getStatus();
          console.log('[API] Sync status:', status);
          return new Response(JSON.stringify(status), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Pragma': 'no-cache',
              'Expires': '0'
            }
          });
        } catch (error) {
          console.error('[API] Get status error:', error);
          return new Response(JSON.stringify({ error: 'get status error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }

      case '/api/sync/start':
        if (request.method === 'POST') {
          try {
            console.log('[API] Starting sync process...');
            await this.syncService.queueAllEvents();
            // 启动定时处理
            this.startProcessing();
            console.log('[API] Sync process started');
            return new Response(JSON.stringify({ message: 'sync started' }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('[API] Start sync error:', error);
            return new Response(JSON.stringify({
              error: 'start sync error: ' + (error instanceof Error ? error.message : String(error)),
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
              details: error
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
        break;

      case '/api/sync/stop':
        if (request.method === 'POST') {
          try {
            console.log('[API] Stopping sync process...');
            await this.syncService.stopSync();
            // 停止定时处理
            this.stopProcessing();
            console.log('[API] Sync process stopped');
            return new Response(JSON.stringify({ message: 'sync stopped' }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('[API] Stop sync error:', error);
            return new Response(JSON.stringify({ error: 'stop sync error' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
        break;

      case '/api/sync/reset':
        if (request.method === 'POST') {
          try {
            await this.syncService.resetSync();
            return new Response(JSON.stringify({ message: 'sync reset' }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('reset sync error:', error);
            return new Response(JSON.stringify({ error: 'reset sync error' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
        break;

      case '/api/sync/cleanup':
        if (request.method === 'POST') {
          try {
            // 清理所有状态
            await this.syncService.cleanup();
            return new Response(JSON.stringify({ message: 'Sync state cleaned up successfully' }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            console.error('cleanup sync state error:', error);
            return new Response(JSON.stringify({ error: 'cleanup sync state error' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
        break;
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  private startProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }

    // 每5秒处理一次
    this.processingInterval = setInterval(async () => {
      try {
        console.log('[Processing] Starting batch processing...');
        // 直接调用processPendingEvents，而不是通过fetch
        await this.syncService.processPendingEvents();
        console.log('[Processing] Batch processing completed');
      } catch (error) {
        console.error('[Processing] Error during batch processing:', error);
      }
    }, 5000) as unknown as number;
  }

  private stopProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }
}

// Worker 入口
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = env.SYNC_STATE.idFromName('sync-state');
    const syncState = env.SYNC_STATE.get(id);
    return syncState.fetch(request);
  },

  // Cron 触发器处理
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const id = env.SYNC_STATE.idFromName('sync-state');
    const syncState = env.SYNC_STATE.get(id);

    // 处理待同步的事件
    await syncState.fetch(new Request('http://internal/process'));
  }
}; 