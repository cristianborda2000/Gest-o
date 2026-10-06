-- Additive. Apply to the existing project; do not run supabase-setup.sql.
begin;
create table if not exists public.reminder_subscriptions (
  endpoint_hash text primary key check (endpoint_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null check (jsonb_typeof(subscription) = 'object'),
  key_id text not null check (key_id ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists reminder_subscriptions_account_idx on public.reminder_subscriptions(user_id, key_id, updated_at desc);
alter table public.reminder_subscriptions enable row level security;
alter table public.reminder_subscriptions force row level security;
-- Endpoint URLs and encryption keys are capability secrets. All access uses the
-- authenticated server API, never a browser query using the anonymous key.
revoke all on public.reminder_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.reminder_subscriptions to service_role;

create or replace function public.reminder_subscribe(p_user_id uuid, p_endpoint_hash text, p_subscription jsonb, p_key_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  if p_user_id is null or p_endpoint_hash is null or p_endpoint_hash !~ '^[a-f0-9]{64}$'
    or p_key_id is null or p_key_id !~ '^[a-f0-9]{64}$' or p_subscription is null
    or jsonb_typeof(p_subscription) <> 'object' or octet_length(p_subscription::text) > 8192 then
    raise exception 'REMINDER_INVALID_SUBSCRIPTION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 528));
  select user_id into v_owner from public.reminder_subscriptions where endpoint_hash = p_endpoint_hash for update;
  if v_owner is not null and v_owner <> p_user_id then raise exception 'REMINDER_SUBSCRIPTION_OWNED' using errcode = '23505'; end if;
  if v_owner is null and (select count(*) from public.reminder_subscriptions where user_id = p_user_id) >= 10 then
    raise exception 'REMINDER_DEVICE_LIMIT';
  end if;
  insert into public.reminder_subscriptions(endpoint_hash,user_id,subscription,key_id)
    values(p_endpoint_hash,p_user_id,p_subscription,p_key_id)
    on conflict(endpoint_hash) do update set subscription = excluded.subscription, key_id = excluded.key_id, updated_at = clock_timestamp()
    where public.reminder_subscriptions.user_id = excluded.user_id;
  if not found then raise exception 'REMINDER_SUBSCRIPTION_OWNED' using errcode = '23505'; end if;
end $$;

create or replace function public.reminder_accounts(p_key_id text, p_after uuid default null, p_limit integer default 100)
returns table(user_id uuid) language sql stable security definer set search_path = public, pg_temp as $$
  select distinct s.user_id from public.reminder_subscriptions s where s.key_id = p_key_id and (p_after is null or s.user_id > p_after)
  order by s.user_id limit greatest(1,least(coalesce(p_limit,100),500))
$$;

-- Shared durable receipt with claimCloudReminder in the open app. A concurrent
-- browser update uses the same app_state revision and loses its CAS if this wins.
-- The server validates that the reminder is still due in this exact revision.
create or replace function public.reminder_claim(p_user_id uuid, p_revision timestamptz, p_key text, p_now bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_state jsonb; v_revision timestamptz; v_receipts jsonb;
begin
  if p_user_id is null or p_revision is null or p_key is null or length(p_key) = 0 or length(p_key) > 1000
    or p_now is null or p_now < 0 then raise exception 'REMINDER_INVALID_CLAIM'; end if;
  select data,updated_at into v_state,v_revision from public.app_state where user_id = p_user_id for update;
  if not found or v_revision is distinct from p_revision then return false; end if;
  v_receipts := case when jsonb_typeof(v_state->'reminderReceipts') = 'object' then v_state->'reminderReceipts' else '{}'::jsonb end;
  if v_receipts ? p_key then return false; end if;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_receipts
    from jsonb_each(v_receipts) where case when jsonb_typeof(value) = 'number' then value::text::numeric >= p_now - 3024000000 else false end;
  v_receipts := v_receipts || jsonb_build_object(p_key,p_now);
  update public.app_state set data = jsonb_set(v_state,'{reminderReceipts}',v_receipts), updated_at = clock_timestamp() where user_id = p_user_id;
  return true;
end $$;
revoke all on function public.reminder_subscribe(uuid,text,jsonb,text), public.reminder_accounts(text,uuid,integer), public.reminder_claim(uuid,timestamptz,text,bigint) from public, anon, authenticated;
grant execute on function public.reminder_subscribe(uuid,text,jsonb,text), public.reminder_accounts(text,uuid,integer), public.reminder_claim(uuid,timestamptz,text,bigint) to service_role;
commit;
