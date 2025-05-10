-- 删除现有表（如果存在）
DROP TABLE IF EXISTS guests;
DROP TABLE IF EXISTS hosts;
DROP TABLE IF EXISTS events;

-- 创建 events 表
CREATE TABLE events (
    api_id TEXT PRIMARY KEY,
    calendar_api_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    description_md TEXT,
    cover_url TEXT,
    start_at TIMESTAMP WITH TIME ZONE,
    end_at TIMESTAMP WITH TIME ZONE,
    timezone TEXT,
    duration_interval TEXT,
    meeting_url TEXT,
    url TEXT,
    user_api_id TEXT,
    visibility TEXT CHECK (visibility IN ('public', 'private')),
    zoom_meeting_url TEXT,
    geo_address_json JSONB,
    geo_latitude TEXT,
    geo_longitude TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 创建 hosts 表
CREATE TABLE hosts (
    api_id TEXT NOT NULL,
    event_api_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    email TEXT,
    name TEXT,
    first_name TEXT,
    last_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (api_id, event_api_id),
    FOREIGN KEY (event_api_id) REFERENCES events(api_id) ON DELETE CASCADE
);

-- 创建 guests 表
CREATE TABLE guests (
    api_id TEXT PRIMARY KEY,
    event_api_id TEXT NOT NULL,
    user_api_id TEXT,
    user_email TEXT,
    user_name TEXT,
    user_first_name TEXT,
    user_last_name TEXT,
    approval_status TEXT CHECK (approval_status IN ('approved', 'pending', 'rejected')),
    check_in_qr_code TEXT,
    checked_in_at TIMESTAMP WITH TIME ZONE,
    custom_source TEXT,
    eth_address TEXT,
    invited_at TIMESTAMP WITH TIME ZONE,
    joined_at TIMESTAMP WITH TIME ZONE,
    phone_number TEXT,
    registered_at TIMESTAMP WITH TIME ZONE,
    registration_answers JSONB,
    solana_address TEXT,
    event_tickets JSONB,
    event_ticket_orders JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_api_id) REFERENCES events(api_id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX idx_events_calendar_api_id ON events(calendar_api_id);
CREATE INDEX idx_hosts_event_api_id ON hosts(event_api_id);
CREATE INDEX idx_guests_event_api_id ON guests(event_api_id);
CREATE INDEX idx_guests_user_api_id ON guests(user_api_id);