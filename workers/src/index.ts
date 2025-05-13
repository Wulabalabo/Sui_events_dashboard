import { LumaService, CalendarEvent } from '../../src/services/luma';
import { GoogleSheetsService } from '../../src/services/google';
import { SupabaseService } from '../../src/services/supabase';
import { LumaGuest, LumaHost } from '../../src/types/luma';

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

interface SyncResult {
  success: boolean;
  message: string;
  stats?: {
    events: number;
    hosts: number;
    guests: number;
  };
  error?: string;
}

/**
 * Validate environment variables
 */
function validateEnv(env: Env): void {
  const required = {
    'LUMA_API_KEY': env.LUMA_API_KEY,
    'SUPABASE_URL': env.SUPABASE_URL,
    'SUPABASE_SERVICE_KEY': env.SUPABASE_SERVICE_KEY,
    'GOOGLE_SHEET_ID': env.GOOGLE_SHEET_ID,
    'GOOGLE_CLIENT_EMAIL': env.GOOGLE_CLIENT_EMAIL,
    'GOOGLE_PRIVATE_KEY': env.GOOGLE_PRIVATE_KEY
  };

  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Fetch all event data
 */
async function fetchAllEventData(lumaService: LumaService): Promise<{
  events: CalendarEvent[];
  hosts: LumaHost[];
  guests: LumaGuest[];
}> {
  console.log('Fetching all events...');
  const events = await lumaService.getAllEvents();
  console.log(`Retrieved ${events.length} events`);

  console.log('Fetching event details and guests...');
  const hosts: LumaHost[] = [];
  const guests: LumaGuest[] = [];

  for (const event of events) {
    console.log(`Processing event: ${event.event.name}`);
    const details = await lumaService.getEventDetails(event.event.api_id);
    if (details.hosts && details.hosts.length > 0) {
      const hostsWithEventInfo = details.hosts.map(host => ({
        ...host,
        event_api_id: event.event.api_id,
        event_name: event.event.name
      }));
      hosts.push(...hostsWithEventInfo);
    }

    const eventGuests = await lumaService.getEventGuests(event.event.api_id);
    const guestsWithEventId = eventGuests.map(guest => ({
      ...guest,
      event_api_id: event.event.api_id
    }));
    guests.push(...guestsWithEventId);
  }

  const uniqueHosts = hosts.reduce((acc, host) => {
    const existingHost = acc.find(h => h.api_id === host.api_id && h.event_api_id === host.event_api_id);
    if (!existingHost || new Date(host.updated_at) > new Date(existingHost.updated_at)) {
      return [...acc.filter(h => !(h.api_id === host.api_id && h.event_api_id === host.event_api_id)), host];
    }
    return acc;
  }, [] as LumaHost[]);

  console.log(`Retrieved ${uniqueHosts.length} hosts and ${guests.length} guests`);
  return { events, hosts: uniqueHosts, guests };
}

/**
 * Sync data to database
 */
async function syncToDatabase(env: Env): Promise<SyncResult> {
  try {
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const supabaseService = new SupabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const { events, hosts, guests } = await fetchAllEventData(lumaService);

    console.log('Starting database sync...');
    for (const event of events) {
      await supabaseService.syncEvents([event], hosts, guests, event.event.api_id);
    }
    console.log('Database sync completed');

    return {
      success: true,
      message: 'Database sync successful',
      stats: {
        events: events.length,
        hosts: hosts.length,
        guests: guests.length
      }
    };
  } catch (error) {
    console.error('Database sync failed:', error);
    return {
      success: false,
      message: 'Database sync failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Sync data to Google Sheets
 */
async function syncToGoogleSheets(env: Env): Promise<SyncResult> {
  try {
    const lumaService = new LumaService(env.LUMA_API_KEY);
    const googleSheetsService = new GoogleSheetsService(
      env.GOOGLE_CLIENT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_SHEET_ID
    );

    const { events, hosts, guests } = await fetchAllEventData(lumaService);

    console.log('Starting Google Sheets sync...');
    await googleSheetsService.syncEvents(events, hosts, guests);
    console.log('Google Sheets sync completed');

    return {
      success: true,
      message: 'Google Sheets sync successful',
      stats: {
        events: events.length,
        hosts: hosts.length,
        guests: guests.length
      }
    };
  } catch (error) {
    console.error('Google Sheets sync failed:', error);
    return {
      success: false,
      message: 'Google Sheets sync failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      validateEnv(env);

      console.log('Starting data sync...');
      const [dbResult, sheetsResult] = await Promise.all([
        syncToDatabase(env),
        syncToGoogleSheets(env)
      ]);

      if (!dbResult.success || !sheetsResult.success) {
        throw new Error(
          `Sync failed:\nDatabase: ${dbResult.error || 'success'}\nGoogle Sheets: ${sheetsResult.error || 'success'}`
        );
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Data sync successful',
        stats: {
          database: dbResult.stats,
          googleSheets: sheetsResult.stats
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error during sync:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async scheduled(event: any, env: Env, ctx: ExecutionContext) {
    try {
      validateEnv(env);

      console.log('Starting scheduled sync...');
      const [dbResult, sheetsResult] = await Promise.all([
        syncToDatabase(env),
        syncToGoogleSheets(env)
      ]);

      if (!dbResult.success || !sheetsResult.success) {
        throw new Error(
          `Scheduled sync failed:\nDatabase: ${dbResult.error || 'success'}\nGoogle Sheets: ${sheetsResult.error || 'success'}`
        );
      }

      console.log('Scheduled sync completed', {
        database: dbResult.stats,
        googleSheets: sheetsResult.stats
      });
    } catch (error) {
      console.error('Scheduled sync failed:', error);
      throw error;
    }
  }
}; 