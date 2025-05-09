-- 删除旧表
DROP TABLE IF EXISTS guests;
DROP TABLE IF EXISTS hosts;
DROP TABLE IF EXISTS events;

-- 创建事件表
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  api_id TEXT UNIQUE NOT NULL,
  calendar_api_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  description_md TEXT,
  cover_url TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  duration_interval TEXT,
  meeting_url TEXT,
  url TEXT,
  user_api_id TEXT,
  visibility TEXT,
  zoom_meeting_url TEXT,
  geo_address_json JSONB,
  geo_latitude TEXT,
  geo_longitude TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 创建主持人表
CREATE TABLE IF NOT EXISTS hosts (
  id BIGSERIAL PRIMARY KEY,
  api_id TEXT UNIQUE NOT NULL,
  event_api_id TEXT NOT NULL REFERENCES events(api_id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 创建参与者表
CREATE TABLE IF NOT EXISTS guests (
  id BIGSERIAL PRIMARY KEY,
  api_id TEXT UNIQUE NOT NULL,
  event_api_id TEXT NOT NULL REFERENCES events(api_id),
  user_name TEXT NOT NULL,
  user_email TEXT NOT NULL,
  user_first_name TEXT,
  user_last_name TEXT,
  approval_status TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ,
  check_in_qr_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_events_api_id ON events(api_id);
CREATE INDEX IF NOT EXISTS idx_events_calendar_api_id ON events(calendar_api_id);
CREATE INDEX IF NOT EXISTS idx_hosts_api_id ON hosts(api_id);
CREATE INDEX IF NOT EXISTS idx_hosts_event_api_id ON hosts(event_api_id);
CREATE INDEX IF NOT EXISTS idx_guests_api_id ON guests(api_id);
CREATE INDEX IF NOT EXISTS idx_guests_event_api_id ON guests(event_api_id); 