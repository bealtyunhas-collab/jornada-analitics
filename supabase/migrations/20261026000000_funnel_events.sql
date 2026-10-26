-- Jornada Analytics: private event ingestion with atomic idempotency and rate limiting.
create extension if not exists pgcrypto;

create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  visitor_id text not null check (length(visitor_id) between 16 and 128),
  session_id text not null check (length(session_id) between 16 and 128),
  event_name text not null check (event_name in (
    'quiz_view','quiz_start','quiz_question_view','quiz_completed',
    'result_view','loading_view','growth_view','vsl_view',
    'vsl_playing','offer_view','checkout_click'
  )),
  step_id text check (step_id is null or length(step_id) <= 64),
  step_index integer check (step_index is null or step_index between 0 and 100),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  device_type text check (device_type in ('mobile','tablet','desktop','unknown')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists funnel_events_created_idx on public.funnel_events(created_at desc);
create index if not exists funnel_events_name_created_idx on public.funnel_events(event_name, created_at desc);
create index if not exists funnel_events_session_idx on public.funnel_events(session_id);
create index if not exists funnel_events_step_idx on public.funnel_events(step_id) where step_id is not null;

alter table public.funnel_events enable row level security;
revoke all on public.funnel_events from public, anon, authenticated;
-- No public RLS policies: only the backend service role can ingest or query events.

create table if not exists public.ingestion_rate_limits (
  key_hash text not null,
  bucket timestamptz not null,
  hits integer not null default 0,
  primary key(key_hash, bucket)
);
alter table public.ingestion_rate_limits enable row level security;
revoke all on public.ingestion_rate_limits from public, anon, authenticated;

-- Atomic rate limiting and insertion, only callable by the trusted service role.
create or replace function public.ingest_funnel_event(
  p_event_id uuid, p_visitor_id text, p_session_id text, p_event_name text,
  p_step_id text, p_step_index integer, p_utm_source text, p_utm_medium text,
  p_utm_campaign text, p_utm_content text, p_device_type text,
  p_metadata jsonb, p_rate_key text
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_hits integer;
begin
  if p_event_name not in (
    'quiz_view','quiz_start','quiz_question_view','quiz_completed',
    'result_view','loading_view','growth_view','vsl_view','vsl_playing','offer_view','checkout_click'
  ) then return 'invalid'; end if;

  -- Keep individual clients from overwhelming the analytics endpoint.
  insert into public.ingestion_rate_limits(key_hash, bucket, hits)
  values (p_rate_key, date_trunc('minute', now()), 1)
  on conflict(key_hash, bucket)
  do update set hits = public.ingestion_rate_limits.hits + 1
  returning hits into v_hits;
  if v_hits > 30 then return 'rate_limited'; end if;

  insert into public.funnel_events (
    event_id, visitor_id, session_id, event_name, step_id, step_index,
    utm_source, utm_medium, utm_campaign, utm_content, device_type, metadata
  ) values (
    p_event_id, p_visitor_id, p_session_id, p_event_name, p_step_id, p_step_index,
    p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_device_type,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict(event_id) do nothing;

  if found then return 'created'; else return 'duplicate'; end if;
end;
$$;

revoke all on function public.ingest_funnel_event(uuid,text,text,text,text,integer,text,text,text,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.ingest_funnel_event(uuid,text,text,text,text,integer,text,text,text,text,text,jsonb,text) to service_role;

-- Authorized dashboard access must be implemented separately with explicit admin identities.
-- Prune expired rate limit buckets periodically using an admin-only scheduled task.
