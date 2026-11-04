-- REVIEW ONLY: not applied to the hosted database. Requires existing JARVIS migration.
begin;
create table public.dot_api_grants (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 128),
  resource text not null check (resource ~ '^https://[^/?#]+/[^?#]*$'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  allowed_tools text[] not null check (cardinality(allowed_tools) > 0 and array_position(allowed_tools, null) is null and allowed_tools <@ array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense']::text[]),
  not_before timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > not_before)
);
alter table public.dot_api_grants enable row level security;
alter table public.dot_api_grants force row level security;
-- Existing Supabase projects may grant writes through default privileges.
-- Clear those grants explicitly before allowing the runtime to read only.
revoke all on public.dot_api_grants from public, anon, authenticated, service_role;
grant select on public.dot_api_grants to service_role;
-- Only the database administrator provisions/rotates/revokes grants; runtime cannot issue keys.
create function public.dot_grant_version() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin new.version := old.version + 1; return new; end $$;
revoke all on function public.dot_grant_version() from public, anon, authenticated, service_role;
create trigger dot_grant_version before update on public.dot_api_grants for each row execute function public.dot_grant_version();

create function public.dot_guarded_commit(
  p_grant_id uuid, p_version integer, p_user_id uuid, p_client_id text, p_resource text, p_tool text,
  p_revision bigint, p_data jsonb, p_write_state boolean, p_state_revision timestamptz, p_state jsonb, p_unchanged boolean
) returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.dot_api_grants%rowtype;
begin
  -- Lock serializes revocation with commit. A commit winning this lock may finish;
  -- once revocation commits, no later guarded commit can use the old grant/version.
  select * into g from public.dot_api_grants where id = p_grant_id for share;
  if not found or g.revoked_at is not null or g.not_before > clock_timestamp() or g.expires_at <= clock_timestamp()
    or g.version is distinct from p_version or g.owner_id is distinct from p_user_id
    or g.client_id is distinct from p_client_id or g.resource is distinct from p_resource
    or p_tool is null or not (p_tool = any(g.allowed_tools)) then
    raise exception 'DOT_GRANT_DENIED' using errcode = '42501';
  end if;
  if p_unchanged is null then raise exception 'DOT_INVALID'; end if;
  if p_unchanged then return p_revision; end if;
  return public.jarvis_commit(p_user_id,p_revision,p_data,p_write_state,p_state_revision,p_state);
end $$;
revoke all on function public.dot_guarded_commit(uuid,integer,uuid,text,text,text,bigint,jsonb,boolean,timestamptz,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.dot_guarded_commit(uuid,integer,uuid,text,text,text,bigint,jsonb,boolean,timestamptz,jsonb,boolean) to service_role;
commit;
