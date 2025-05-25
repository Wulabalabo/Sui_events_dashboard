import { createClient } from '@supabase/supabase-js';
import { Database } from '../types/database';
import { CalendarEvent } from './luma';
import { LumaHost, LumaGuest, LumaEventTicket } from '../types/luma';

export class SupabaseService {
  private supabase;

  constructor(url: string, serviceKey: string) {
    this.supabase = createClient<Database>(url, serviceKey);
  }

  async syncEvents(events: CalendarEvent[], hosts: LumaHost[], guests: LumaGuest[], eventApiId: string): Promise<void> {
    try {
      console.log(`开始同步事件 ${eventApiId} 的数据...`);

      // 同步事件数据
      const event = events[0].event;
      console.log(`同步事件 ${event.name} 的数据，calendar_api_id: ${events[0].api_id}, event_api_id: ${event.api_id}`);
      
      const { error: eventError } = await this.supabase
        .from('events')
        .upsert({
          api_id: event.api_id,
          calendar_api_id: events[0].api_id,
          name: event.name,
          description: event.description,
          description_md: event.description_md,
          cover_url: event.cover_url,
          start_at: event.start_at,
          end_at: event.end_at,
          timezone: event.timezone,
          duration_interval: event.duration_interval,
          meeting_url: event.meeting_url,
          url: event.url,
          user_api_id: event.user_api_id,
          visibility: event.visibility,
          zoom_meeting_url: event.zoom_meeting_url,
          geo_address_json: event.geo_address_json,
          geo_latitude: event.geo_latitude,
          geo_longitude: event.geo_longitude,
          created_at: event.created_at,
          updated_at: event.updated_at || event.created_at
        }, {
          onConflict: 'api_id'
        });

      if (eventError) {
        console.error('同步事件数据失败:', eventError);
        throw eventError;
      }
      console.log(`成功同步事件 ${event.name} 的数据`);

      // 同步主持人数据
      for (const host of hosts) {
        console.log(`同步主持人 ${host.name} 的数据`);
        const now = new Date().toISOString();
        const { error: hostError } = await this.supabase
          .from('hosts')
          .upsert({
            api_id: host.api_id,
            event_api_id: eventApiId,
            event_name: event.name,
            name: host.name,
            email: host.email,
            first_name: host.first_name,
            last_name: host.last_name,
            avatar_url: host.avatar_url,
            created_at: now,
            updated_at: now
          }, {
            onConflict: 'api_id,event_api_id'
          });

        if (hostError) {
          console.error('同步主持人数据失败:', hostError);
          throw hostError;
        }
        console.log(`成功同步主持人 ${host.name} 的数据`);
      }

      // 同步参与者数据
      for (const guest of guests) {
        console.log(`同步参与者 ${guest.user_name} 的数据`);
        const { error: guestError } = await this.supabase
          .from('guests')
          .upsert({
            api_id: guest.api_id,
            event_api_id: eventApiId,
            user_name: guest.user_name,
            user_email: guest.user_email,
            user_first_name: guest.user_first_name,
            user_last_name: guest.user_last_name,
            approval_status: guest.approval_status,
            checked_in_at: guest.checked_in_at,
            check_in_qr_code: guest.check_in_qr_code,
            created_at: guest.created_at,
            updated_at: guest.updated_at || guest.created_at
          }, {
            onConflict: 'api_id'
          });

        if (guestError) {
          console.error('同步参与者数据失败:', guestError);
          throw guestError;
        }
        console.log(`成功同步参与者 ${guest.user_name} 的数据`);
      }

      console.log('数据同步完成');
    } catch (error) {
      console.error('同步到 Supabase 时发生错误:', error);
      throw error;
    }
  }
} 