// 事件相关类型
export interface LumaGeoAddress {
  address: string;
}

export interface LumaHost {
  api_id: string;
  event_api_id: string;
  event_name?: string;
  name: string;
  email: string;
  first_name?: string;
  last_name?: string;
  avatar_url?: string;
  created_at: string;
  updated_at: string;
}

export interface LumaEvent {
  api_id: string;
  name: string;
  description: string;
  description_md?: string;
  cover_url: string;
  start_at: string;
  end_at: string;
  timezone: string;
  duration_interval?: string;
  meeting_url?: string;
  url?: string;
  user_api_id?: string;
  visibility?: 'public' | 'private';
  zoom_meeting_url?: string;
  geo_address_json?: {
    address: string;
    latitude: number;
    longitude: number;
  };
  geo_latitude?: string;
  geo_longitude?: string;
  created_at: string;
  updated_at: string;
}

export interface LumaEventResponse {
  event: LumaEvent;
  hosts: LumaHost[];
}

// 参与者相关类型
export interface LumaRegistrationAnswer {
  answer: boolean | string | string[];
  label: string;
  question_id: string;
  question_type: 'agree-check' | 'dropdown' | 'multi-select' | 'phone-number' | 'terms' | 'company' | 'url';
}

export interface LumaEventTicket {
  api_id: string;
  event_ticket_type_api_id: string;
  name: string;
  amount: number;
  amount_discount: number;
  amount_tax: number;
  currency: string;
  checked_in_at: string | null;
  is_captured: boolean;
  event_api_id: string;
}

export interface LumaCouponInfo {
  api_id: string;
  percent_off: number;
  cents_off: number;
  currency: string;
  code: string;
}

export interface LumaEventTicketOrder {
  api_id: string;
  amount: number;
  amount_discount: number;
  amount_tax: number;
  currency: string;
  coupon_info: LumaCouponInfo;
  is_captured: boolean;
}

export interface LumaGuest {
  api_id: string;
  event_api_id: string;
  user_name: string;
  user_email: string;
  user_first_name?: string;
  user_last_name?: string;
  approval_status: string;
  checked_in_at?: string;
  check_in_qr_code?: string;
  created_at: string;
  updated_at: string;
}

export interface LumaGuestResponse {
  guest: LumaGuest;
}

// API 响应通用类型
export interface LumaApiResponse<T> {
  data: T;
  meta?: {
    total: number;
    page: number;
    perPage: number;
  };
} 