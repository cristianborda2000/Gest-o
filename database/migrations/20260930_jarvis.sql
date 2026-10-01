-- Additive migration. Run on the existing Supabase project; never run the legacy setup script.
begin;
create table if not exists public.jarvis_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.jarvis_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null,
  started_at timestamptz not null,
  hits integer not null default 0,
  primary key (user_id, bucket)
);
alter table public.jarvis_accounts enable row level security;
alter table public.jarvis_accounts force row level security;
alter table public.jarvis_rate_limits enable row level security;
alter table public.jarvis_rate_limits force row level security;
revoke all on public.jarvis_accounts, public.jarvis_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.jarvis_accounts, public.jarvis_rate_limits to service_role;

-- Called ONLY by the trusted API after validating the Supabase access token.
-- Both rows are locked and checked; an audit record can never commit without its mutation.
create or replace function public.jarvis_commit(
  p_user_id uuid, p_revision bigint, p_data jsonb,
  p_write_state boolean, p_state_revision timestamptz, p_state jsonb
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_revision bigint; v_state_revision timestamptz;
begin
  if p_user_id is null or p_revision is null or p_revision < 0 or p_write_state is null
     or p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 8388608 then
    raise exception 'JARVIS_INVALID_DATA';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 391));
  insert into public.jarvis_accounts(user_id) values(p_user_id) on conflict do nothing;
  select revision into v_revision from public.jarvis_accounts where user_id = p_user_id for update;
  if v_revision <> p_revision then raise exception 'JARVIS_CONFLICT' using errcode = '40001'; end if;
  if p_write_state then
    if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'JARVIS_INVALID_STATE'; end if;
    select updated_at into v_state_revision from public.app_state where user_id = p_user_id for update;
    if v_state_revision is distinct from p_state_revision then raise exception 'JARVIS_CONFLICT' using errcode = '40001'; end if;
    if v_state_revision is null then
      insert into public.app_state(user_id, data) values(p_user_id, p_state);
    else
      update public.app_state set data = p_state, updated_at = clock_timestamp() where user_id = p_user_id;
    end if;
  end if;
  update public.jarvis_accounts set data = p_data, revision = revision + 1, updated_at = clock_timestamp() where user_id = p_user_id;
  return v_revision + 1;
end $$;
revoke all on function public.jarvis_commit(uuid,bigint,jsonb,boolean,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.jarvis_commit(uuid,bigint,jsonb,boolean,timestamptz,jsonb) to service_role;

create or replace function public.jarvis_consume_rate(p_user_id uuid, p_bucket text, p_limit integer, p_window integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hits integer;
begin
  if p_user_id is null or p_limit is null or p_limit < 1 or p_window is null or p_window < 1
     or p_bucket is null or length(btrim(p_bucket)) = 0 or length(p_bucket) > 80 then
    raise exception 'JARVIS_INVALID_RATE';
  end if;
  insert into public.jarvis_rate_limits as r(user_id,bucket,started_at,hits)
    values(p_user_id,p_bucket,clock_timestamp(),1)
    on conflict(user_id,bucket) do update set
      hits = case when r.started_at + make_interval(secs => p_window) <= clock_timestamp() then 1 else r.hits + 1 end,
      started_at = case when r.started_at + make_interval(secs => p_window) <= clock_timestamp() then clock_timestamp() else r.started_at end
    returning hits into v_hits;
  return v_hits <= p_limit;
end $$;
revoke all on function public.jarvis_consume_rate(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function public.jarvis_consume_rate(uuid,text,integer,integer) to service_role;
commit;
