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
            font-weight: bold;
        }
        .success {
            color: #28a745;
            font-weight: bold;
        }
        .warning {
            color: #ffc107;
            font-weight: bold;
        }
        .info {
            color: #17a2b8;
            font-weight: bold;
        }
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 5px;
        }
        .status-indicator.success {
            background-color: #28a745;
        }
        .status-indicator.error {
            background-color: #dc3545;
        }
        .status-indicator.warning {
            background-color: #ffc107;
        }
        .status-indicator.info {
            background-color: #17a2b8;
        }
        .timestamp {
            color: #6c757d;
            font-size: 0.9em;
        }
        #logs p {
            margin: 5px 0;
            padding: 5px;
            border-radius: 3px;
            font-size: 12px;
            line-height: 1.3;
        }
        #logs p.error {
            background-color: #f8d7da;
            border: 1px solid #f1aeb5;
        }
        #logs p.success {
            background-color: #dff0d8;
            border: 1px solid #bce8f1;
        }
        #logs p.warning {
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
        }
        #logs p.info {
            background-color: #cce7ff;
            border: 1px solid #bee5eb;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Sui Events Dashboard - Sync Status</h1>
        
        <div class="status-card">
            <h2>Current Status</h2>
            <div class="status-info">
                <p><strong>Stage:</strong> <span id="currentStage">-</span></p>
                <p><strong>Progress:</strong> <span id="progress">0</span>%</p>
                <div class="progress-bar">
                    <div class="progress-fill" id="progressBar" style="width: 0%"></div>
                </div>
                <p><strong>Processed Events:</strong> <span id="processedEvents">0</span></p>
                <p><strong>Total Events:</strong> <span id="totalEvents">0</span></p>
                <p><strong>Failed Events:</strong> <span id="failedEvents">0</span></p>
                <p><strong>Last Sync:</strong> <span id="lastSyncTime">-</span></p>
            </div>
        </div>

        <div class="status-card">
            <h2>Actions</h2>
            <div style="margin-bottom: 15px;">
                <label for="startDate" style="margin-right: 10px;">start date:</label>
                <input type="datetime-local" id="startDate" style="padding: 5px; border-radius: 4px; border: 1px solid #ccc;">
                <label for="endDate" style="margin-left: 15px; margin-right: 10px;">end date:</label>
                <input type="datetime-local" id="endDate" style="padding: 5px; border-radius: 4px; border: 1px solid #ccc;">
            </div>
            <div style="margin-bottom: 15px;">
                <button class="button" onclick="startSync()">Start Sync</button>
                <button class="button" onclick="stopSync()">Stop Sync</button>
                <button class="button" onclick="resetSync()">Reset Sync</button>
                <button class="button" onclick="cleanupSync()" style="background-color: #dc3545;">Cleanup State</button>
            </div>
            <div style="margin-bottom: 15px;">
                <button class="button" onclick="validateSheets()" style="background-color: #17a2b8;">Validate Sheets</button>
                <button class="button" onclick="initializeSheets()" style="background-color: #28a745;">Initialize Sheets</button>
                <button class="button" onclick="checkHealth()" style="background-color: #ffc107; color: #000;">Health Check</button>
            </div>
        </div>

        <div class="status-card">
            <h2>System Status</h2>
            <div id="systemStatus" style="margin-bottom: 15px;">
                <p>Sheets Status: <span id="sheetsStatus">Unknown</span></p>
                <p>Health Status: <span id="healthStatus">Unknown</span></p>
                <p>Last Check: <span id="lastCheck">-</span></p>
            </div>
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

        // Add log with better styling
        function addLog(message, type) {
            type = type || 'info';
            const logs = document.getElementById('logs');
            if (!logs) return;
            
            const logEntry = document.createElement('p');
            logEntry.className = type;
            logEntry.innerHTML = '<span class="status-indicator ' + type + '"></span>[' + new Date().toLocaleTimeString() + '] ' + message;
            logs.insertBefore(logEntry, logs.firstChild);
            
            // Keep only last 50 log entries
            while (logs.children.length > 50) {
                logs.removeChild(logs.lastChild);
            }
        }

        // Update status with better formatting
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
                
                // Update UI elements with better formatting
                document.getElementById('currentStage').textContent = status.currentStage || '-';
                document.getElementById('progress').textContent = Math.round(status.progress || 0);
                document.getElementById('progressBar').style.width = (status.progress || 0) + '%';
                document.getElementById('processedEvents').textContent = status.processedEvents || 0;
                document.getElementById('totalEvents').textContent = status.totalEvents || 0;
                document.getElementById('failedEvents').textContent = status.failedEvents || 0;
                document.getElementById('lastSyncTime').textContent = formatDate(status.lastSyncTime);
                
                // Add color coding for failed events
                const failedElement = document.getElementById('failedEvents');
                if (status.failedEvents > 0) {
                    failedElement.className = 'error';
                } else {
                    failedElement.className = 'success';
                }
                
                // Log significant status changes
                if (status.currentStage !== (lastStatus && lastStatus.currentStage)) {
                    addLog('Stage changed to: ' + status.currentStage, 'info');
                }
                
                if (status.currentStage === 'completed' && (lastStatus && lastStatus.currentStage !== 'completed')) {
                    addLog('Sync completed successfully!', 'success');
                    stopPolling();
                }
                
                if (status.currentStage === 'failed' && (lastStatus && lastStatus.currentStage !== 'failed')) {
                    addLog('Sync failed!', 'error');
                    stopPolling();
                }
                
                lastStatus = status;
                lastError = null;
            } catch (error) {
                console.error('Failed to update status:', error);
                lastError = error.message;
                addLog('Failed to update status: ' + error.message, 'error');
            }
        }

        // Start sync
        async function startSync() {
            try {
                const startDate = document.getElementById('startDate').value;
                const endDate = document.getElementById('endDate').value;
                
                const body = {};
                if (startDate) body.after = new Date(startDate).toISOString();
                if (endDate) body.before = new Date(endDate).toISOString();
                
                addLog('Starting sync...');
                const response = await fetch('/api/sync/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    addLog(result.message || 'Sync started successfully', 'success');
                    startPolling();
                } else {
                    addLog('Failed to start sync: ' + (result.error || result.message), 'error');
                    console.error('Start sync error:', result);
                }
            } catch (error) {
                addLog('Failed to start sync: ' + error.message, 'error');
                console.error('Start sync error:', error);
            }
        }

        // Stop sync
        async function stopSync() {
            try {
                addLog('Stopping sync...');
                const response = await fetch('/api/sync/stop', {
                    method: 'POST'
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    addLog(result.message || 'Sync stopped', 'success');
                    stopPolling();
                } else {
                    addLog('Failed to stop sync: ' + (result.error || result.message), 'error');
                }
            } catch (error) {
                addLog('Failed to stop sync: ' + error.message, 'error');
            }
        }

        // Reset sync
        async function resetSync() {
            try {
                addLog('Resetting sync state...');
                const response = await fetch('/api/sync/reset', {
                    method: 'POST'
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    addLog(result.message || 'Sync state reset', 'success');
                    await updateStatus();
                } else {
                    addLog('Failed to reset sync: ' + (result.error || result.message), 'error');
                }
            } catch (error) {
                addLog('Failed to reset sync: ' + error.message, 'error');
            }
        }

        // Cleanup sync
        async function cleanupSync() {
            try {
                addLog('Cleaning up sync state...');
                const response = await fetch('/api/sync/cleanup', {
                    method: 'POST'
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    addLog(result.message || 'Sync state cleaned up', 'success');
                    await updateStatus();
                } else {
                    addLog('Failed to cleanup sync: ' + (result.error || result.message), 'error');
                }
            } catch (error) {
                addLog('Failed to cleanup sync: ' + error.message, 'error');
            }
        }

        // Validate sheets
        async function validateSheets() {
            try {
                addLog('Validating sheets setup...');
                const response = await fetch('/api/sync/validate');
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    const validation = result.validation;
                    if (validation.isValid) {
                        addLog('All sheets are valid', 'success');
                        document.getElementById('sheetsStatus').textContent = 'Valid';
                        document.getElementById('sheetsStatus').className = 'success';
                    } else {
                        addLog('Invalid sheets found: ' + validation.missingSheets.join(', '), 'error');
                        document.getElementById('sheetsStatus').textContent = 'Invalid - Missing: ' + validation.missingSheets.join(', ');
                        document.getElementById('sheetsStatus').className = 'error';
                    }
                    document.getElementById('lastCheck').textContent = formatDate(Date.now());
                } else {
                    addLog('Failed to validate sheets: ' + (result.error || 'Unknown error'), 'error');
                    document.getElementById('sheetsStatus').textContent = 'Error';
                    document.getElementById('sheetsStatus').className = 'error';
                }
            } catch (error) {
                addLog('Failed to validate sheets: ' + error.message, 'error');
                document.getElementById('sheetsStatus').textContent = 'Error';
                document.getElementById('sheetsStatus').className = 'error';
            }
        }

        // Initialize sheets
        async function initializeSheets() {
            try {
                addLog('Initializing sheets...');
                const response = await fetch('/api/sync/initialize', {
                    method: 'POST'
                });
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    addLog(result.message || 'Sheets initialized successfully', 'success');
                    document.getElementById('sheetsStatus').textContent = 'Initialized';
                    document.getElementById('sheetsStatus').className = 'success';
                    document.getElementById('lastCheck').textContent = formatDate(Date.now());
                } else {
                    addLog('Failed to initialize sheets: ' + (result.error || result.message), 'error');
                    document.getElementById('sheetsStatus').textContent = 'Error';
                    document.getElementById('sheetsStatus').className = 'error';
                }
            } catch (error) {
                addLog('Failed to initialize sheets: ' + error.message, 'error');
                document.getElementById('sheetsStatus').textContent = 'Error';
                document.getElementById('sheetsStatus').className = 'error';
            }
        }

        // Check health
        async function checkHealth() {
            try {
                addLog('Checking system health...');
                const response = await fetch('/api/sync/health');
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    const health = result.health;
                    addLog('Health check completed: ' + health.status, health.status === 'healthy' ? 'success' : 'error');
                    document.getElementById('healthStatus').textContent = health.status;
                    document.getElementById('healthStatus').className = health.status === 'healthy' ? 'success' : 'error';
                    document.getElementById('lastCheck').textContent = formatDate(Date.now());
                } else {
                    addLog('Health check failed: ' + (result.error || 'Unknown error'), 'error');
                    document.getElementById('healthStatus').textContent = 'Error';
                    document.getElementById('healthStatus').className = 'error';
                }
            } catch (error) {
                addLog('Health check failed: ' + error.message, 'error');
                document.getElementById('healthStatus').textContent = 'Error';
                document.getElementById('healthStatus').className = 'error';
            }
        }

        // Start polling
        function startPolling() {
            if (isPolling) return;
            isPolling = true;
            addLog('Started status polling');
            
            updateStatus(); // Initial update
            pollInterval = setInterval(updateStatus, 2000); // Update every 2 seconds
        }

        // Stop polling
        function stopPolling() {
            if (!isPolling) return;
            isPolling = false;
            addLog('Stopped status polling');
            
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = undefined;
            }
        }

        // Page visibility change handler
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') {
                // Page became visible, start polling if not already
                if (!isPolling) {
                    updateStatus();
                }
            }
        });

        // Initialize on page load
        document.addEventListener('DOMContentLoaded', function() {
            addLog('Dashboard loaded');
            
            // Test API connectivity
            testAPIConnectivity();
            
            updateStatus();
            
            // Auto-validate sheets on load
            setTimeout(validateSheets, 1000);
        });

        // Test API connectivity
        async function testAPIConnectivity() {
            try {
                addLog('Testing API connectivity...', 'info');
                
                const response = await fetch('/api/sync/status');
                if (response.ok) {
                    addLog('API connectivity test passed', 'success');
                } else {
                    addLog('API connectivity test failed: ' + response.status, 'error');
                }
            } catch (error) {
                addLog('API connectivity test failed: ' + error.message, 'error');
            }
        }

        // Cleanup on page unload
        window.addEventListener('beforeunload', function() {
            stopPolling();
        });
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
      // 移除前缀，传递相对路径到处理器
      const apiPath = path.replace('/api/sync', '');
      return this.handleSyncApi(apiPath, request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleSyncApi(path: string, request: Request): Promise<Response> {
    try {
      const method = request.method;

      switch (path) {
        case '/status':
          if (method !== 'GET') {
            return new Response('Method not allowed', { status: 405 });
          }
          const status = await this.syncService.getStatus();
          return new Response(JSON.stringify(status), {
            headers: { 'Content-Type': 'application/json' }
          });

        case '/start':
          if (method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }
          
          try {
            const body = await request.json();
            const { after, before } = body;
            await this.syncService.queueAllEvents(after, before);
            
            // 启动定时处理器
            this.startProcessing();
            
            return new Response(JSON.stringify({ 
              success: true, 
              message: 'Sync started successfully' 
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error: unknown) {
            console.error('Failed to start sync:', error);
            return new Response(JSON.stringify({ 
              error: 'start sync error: ' + (error instanceof Error ? error.message : String(error)),
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
              details: {}
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/stop':
          if (method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }
          await this.syncService.stopSync();
          
          // 停止定时处理器
          this.stopProcessing();
          
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Sync stopped' 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });

        case '/reset':
          if (method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }
          await this.syncService.resetSync();
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Sync state reset' 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });

        case '/cleanup':
          if (method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }
          await this.syncService.cleanup();
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Sync state cleaned up' 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });

        case '/validate':
          if (method !== 'GET') {
            return new Response('Method not allowed', { status: 405 });
          }
          
          try {
            const validation = await (this.syncService as any).sheetsService.validateSheetsSetup();
            return new Response(JSON.stringify({
              success: true,
              validation
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error: unknown) {
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/initialize':
          if (method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }
          
          try {
            await (this.syncService as any).sheetsService.initializeSheets();
            return new Response(JSON.stringify({
              success: true,
              message: 'Sheets initialized successfully'
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error: unknown) {
            console.error('Failed to initialize sheets:', error);
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
              message: 'Failed to initialize sheets'
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        case '/health':
          if (method !== 'GET') {
            return new Response('Method not allowed', { status: 405 });
          }
          
          try {
            const health = await (this.syncService as any).sheetsService.healthCheck();
            return new Response(JSON.stringify({
              success: true,
              health
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error: unknown) {
            return new Response(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error: unknown) {
      console.error('API handler error:', error);
      return new Response(JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private startProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }

    // 每3秒处理一次（加快处理速度）
    this.processingInterval = setInterval(async () => {
      try {
        console.log('[Processing] Starting batch processing...');
        
        // 检查同步状态
        const status = await this.syncService.getStatus();
        
        if (status.currentStage === 'completed') {
          console.log('[Processing] Sync completed, stopping processing...');
          this.stopProcessing();
          return;
        }
        
        // 直接调用processPendingEvents，而不是通过fetch
        await this.syncService.processPendingEvents();
        console.log('[Processing] Batch processing completed');
      } catch (error) {
        console.error('[Processing] Error during batch processing:', error);
        // 如果出现错误，也停止处理
        this.stopProcessing();
      }
    }, 3000) as unknown as number;
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