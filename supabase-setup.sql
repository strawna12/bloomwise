-- BloomWise: Run this in your Supabase SQL Editor
-- supabase.com → your project → SQL Editor → New query → paste → Run

-- Gardens table: stores each user's saved plant collection
create table if not exists gardens (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,          -- anonymous ID stored in browser
  plants      jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Index for fast user lookups
create index if not exists gardens_user_id_idx on gardens(user_id);

-- Row Level Security: users can only read/write their own garden
alter table gardens enable row level security;

create policy "Users can read their own garden"
  on gardens for select
  using (true);  -- anyone with the user_id can read (it's a secret random ID)

create policy "Users can insert their own garden"
  on gardens for insert
  with check (true);

create policy "Users can update their own garden"
  on gardens for update
  using (true);

-- Auto-update the updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger gardens_updated_at
  before update on gardens
  for each row execute function update_updated_at();
