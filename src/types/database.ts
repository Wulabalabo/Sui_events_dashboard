export interface Database {
  public: {
    Tables: {
      events: {
        Row: {
          api_id: string;
          created_at: string;
          cover_url: string;
          calendar_api_id: string;
          description: string;
          description_md: string;
          duration_interval: string;
          end_at: string;
          geo_address: string;
          geo_latitude: string;
          geo_longitude: string;
          meeting_url: string;
          name: string;
          start_at: string;
          timezone: string;
          url: string;
          user_api_id: string;
          visibility: 'public' | 'private';
          zoom_meeting_url: string;
        };
        Insert: {
          api_id: string;
          created_at: string;
          cover_url: string;
          calendar_api_id: string;
          description: string;
          description_md: string;
          duration_interval: string;
          end_at: string;
          geo_address: string;
          geo_latitude: string;
          geo_longitude: string;
          meeting_url: string;
          name: string;
          start_at: string;
          timezone: string;
          url: string;
          user_api_id: string;
          visibility: 'public' | 'private';
          zoom_meeting_url: string;
        };
        Update: {
          api_id?: string;
          created_at?: string;
          cover_url?: string;
          calendar_api_id?: string;
          description?: string;
          description_md?: string;
          duration_interval?: string;
          end_at?: string;
          geo_address?: string;
          geo_latitude?: string;
          geo_longitude?: string;
          meeting_url?: string;
          name?: string;
          start_at?: string;
          timezone?: string;
          url?: string;
          user_api_id?: string;
          visibility?: 'public' | 'private';
          zoom_meeting_url?: string;
        };
      };
      hosts: {
        Row: {
          api_id: string;
          event_api_id: string;
          email: string;
          name: string;
          first_name: string;
          last_name: string;
          avatar_url: string;
        };
        Insert: {
          api_id: string;
          event_api_id: string;
          email: string;
          name: string;
          first_name: string;
          last_name: string;
          avatar_url: string;
        };
        Update: {
          api_id?: string;
          event_api_id?: string;
          email?: string;
          name?: string;
          first_name?: string;
          last_name?: string;
          avatar_url?: string;
        };
      };
      guests: {
        Row: {
          api_id: string;
          event_api_id: string;
          user_api_id: string;
          user_email: string;
          user_name: string;
          user_first_name: string;
          user_last_name: string;
          approval_status: 'approved' | 'pending' | 'rejected';
          check_in_qr_code: string;
          checked_in_at: string | null;
          custom_source: string;
          eth_address: string;
          invited_at: string;
          joined_at: string;
          phone_number: string;
          registered_at: string;
          registration_answers: Record<string, any>;
          solana_address: string;
          event_tickets: Record<string, any>;
          event_ticket_orders: Record<string, any>;
        };
        Insert: {
          api_id: string;
          event_api_id: string;
          user_api_id: string;
          user_email: string;
          user_name: string;
          user_first_name: string;
          user_last_name: string;
          approval_status: 'approved' | 'pending' | 'rejected';
          check_in_qr_code: string;
          checked_in_at: string | null;
          custom_source: string;
          eth_address: string;
          invited_at: string;
          joined_at: string;
          phone_number: string;
          registered_at: string;
          registration_answers: Record<string, any>;
          solana_address: string;
          event_tickets: Record<string, any>;
          event_ticket_orders: Record<string, any>;
        };
        Update: {
          api_id?: string;
          event_api_id?: string;
          user_api_id?: string;
          user_email?: string;
          user_name?: string;
          user_first_name?: string;
          user_last_name?: string;
          approval_status?: 'approved' | 'pending' | 'rejected';
          check_in_qr_code?: string;
          checked_in_at?: string | null;
          custom_source?: string;
          eth_address?: string;
          invited_at?: string;
          joined_at?: string;
          phone_number?: string;
          registered_at?: string;
          registration_answers?: Record<string, any>;
          solana_address?: string;
          event_tickets?: Record<string, any>;
          event_ticket_orders?: Record<string, any>;
        };
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
} 