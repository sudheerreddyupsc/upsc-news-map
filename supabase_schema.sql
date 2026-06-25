-- Run this once in the Supabase SQL editor to create the table.

create table if not exists news_items (
  id bigint generated always as identity primary key,
  article_id text unique not null,
  headline text not null,
  summary text,
  place text,
  category text,
  lat double precision,
  lon double precision,
  source_url text,
  source_name text,
  published_at timestamptz,
  created_at timestamptz default now()
);

-- Index for fetching "recent news" fast, which is what the frontend will query
create index if not exists idx_news_items_created_at on news_items (created_at desc);

-- Allow the frontend (using the public anon key) to READ this table.
-- Writing is only ever done by the backend script using the service_role key,
-- which bypasses RLS entirely — so this policy only needs to cover reads.
alter table news_items enable row level security;

create policy "Public can read news items"
  on news_items for select
  using (true);
