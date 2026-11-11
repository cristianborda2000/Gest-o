-- REVIEW DRAFT ONLY. Never apply without an explicitly approved rollout.
-- Additive v2 namespace beside deployed dot_oauth_families/refresh v1.
-- Requires deployed grants, direct expenses and 20261104174518 refresh v1.
-- Existing functions, tables, grants and refresh credentials remain unchanged.
-- New codes opt in with allow_refresh_v2; no backfill or conversion.
begin;

alter table public.dot_oauth_codes add column allow_refresh_v2 boolean not null default false;

create table public.dot_oauth_v2_sessions (
  grant_id uuid primary key references public.dot_api_grants(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  resource text not null,
  allowed_tools text[] not null check (cardinality(allowed_tools) > 0 and array_position(allowed_tools,null) is null),
  created_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  check (absolute_expires_at > created_at and idle_expires_at <= absolute_expires_at)
);
create table public.dot_oauth_v2_refresh_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  grant_id uuid not null references public.dot_oauth_v2_sessions(grant_id) on delete cascade,
  access_token_hash text not null unique check (access_token_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at and token_hash <> access_token_hash)
);
create index dot_oauth_v2_refresh_tokens_grant_idx on public.dot_oauth_v2_refresh_tokens(grant_id);
create index dot_oauth_v2_sessions_expiry_idx on public.dot_oauth_v2_sessions(absolute_expires_at);
alter table public.dot_oauth_v2_sessions enable row level security;
alter table public.dot_oauth_v2_sessions force row level security;
alter table public.dot_oauth_v2_refresh_tokens enable row level security;
alter table public.dot_oauth_v2_refresh_tokens force row level security;
-- Clear inherited Supabase default privileges as well as PUBLIC defaults.
revoke all on public.dot_oauth_v2_sessions, public.dot_oauth_v2_refresh_tokens from public, anon, authenticated, service_role;

-- Privileged RPCs deliberately expose no direct table access. The trusted server
-- supplies its configured owner/client/resource; client sessions cannot call them.
create function public.dot_oauth_v2_exchange_refresh(
  p_code_hash text,p_owner uuid,p_client text,p_resource text,p_redirect text,p_challenge text,
  p_grant uuid,p_token_hash text,p_refresh_hash text,p_direct_enabled boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.dot_oauth_codes%rowtype; g public.dot_api_grants%rowtype; ok boolean; t timestamptz;
begin
  select * into c from public.dot_oauth_codes where code_hash=p_code_hash for update;
  if not found or not c.allow_refresh_v2 or c.owner_id is distinct from p_owner
    or c.client_id is distinct from p_client or c.resource is distinct from p_resource
    or c.redirect_uri is distinct from p_redirect or c.challenge is distinct from p_challenge then
    return jsonb_build_object('error','invalid_grant');
  end if;
  -- The legacy exchange also revokes this same stable grant on a proven code replay.
  select public.dot_oauth_exchange(p_code_hash,p_owner,p_client,p_resource,p_redirect,p_challenge,p_grant,p_token_hash,p_direct_enabled) into ok;
  if ok is distinct from true then return jsonb_build_object('error','invalid_grant'); end if;
  select * into strict g from public.dot_api_grants where id=p_grant for update;
  t := clock_timestamp();
  insert into public.dot_oauth_v2_sessions(grant_id,owner_id,client_id,resource,allowed_tools,created_at,absolute_expires_at,idle_expires_at)
    values(g.id,g.owner_id,g.client_id,g.resource,g.allowed_tools,t,t+interval '30 days',t+interval '7 days');
  insert into public.dot_oauth_v2_refresh_tokens(token_hash,grant_id,access_token_hash,access_expires_at,created_at,expires_at)
    values(p_refresh_hash,g.id,p_token_hash,g.expires_at,t,t+interval '7 days');
  return jsonb_build_object('grant_id',g.id,'expires_in',3600,'refresh_token_expires_in',604800,
    'scope','zama:private'||case when 'record_expense'=any(g.allowed_tools) then ' zama:expenses:write' else '' end);
end $$;

create function public.dot_oauth_v2_refresh(
  p_refresh_hash text,p_grant uuid,p_owner uuid,p_client text,p_resource text,
  p_token_hash text,p_next_refresh_hash text,p_scope text default null,p_direct_enabled boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  g public.dot_api_grants%rowtype; s public.dot_oauth_v2_sessions%rowtype; r public.dot_oauth_v2_refresh_tokens%rowtype;
  permitted text[]; requested text[]; issued_scope text; t timestamptz; access_expiry timestamptz; idle_expiry timestamptz;
begin
  -- All rotation/revocation operations lock this row FIRST. It is also the row
  -- locked by guarded writes and administrator revocation. One family = one grant.
  select * into g from public.dot_api_grants where id=p_grant for update;
  if not found or g.owner_id is distinct from p_owner or g.client_id is distinct from p_client
    or g.resource is distinct from p_resource then return jsonb_build_object('error','invalid_grant'); end if;
  select * into s from public.dot_oauth_v2_sessions where grant_id=g.id for update;
  if not found or s.owner_id is distinct from g.owner_id or s.client_id is distinct from g.client_id
    or s.resource is distinct from g.resource then return jsonb_build_object('error','invalid_grant'); end if;
  select * into r from public.dot_oauth_v2_refresh_tokens where token_hash=p_refresh_hash and grant_id=g.id;
  if not found then return jsonb_build_object('error','invalid_grant'); end if;
  t := clock_timestamp();
  if g.revoked_at is not null or g.not_before > t or s.absolute_expires_at <= t or s.idle_expires_at <= t then
    return jsonb_build_object('error','invalid_grant');
  end if;
  if r.used_at is not null then
    -- Return an error VALUE: raising here would roll back the replay revocation.
    update public.dot_api_grants set revoked_at=t where id=g.id;
    return jsonb_build_object('error','invalid_grant');
  end if;
  -- Access expiry is intentionally not checked: its short lifetime is why refresh exists.
  -- A separately rotated administrative access token must not be overwritten by refresh.
  if r.expires_at <= t or r.access_token_hash is distinct from g.token_hash
    or r.access_expires_at is distinct from g.expires_at then return jsonb_build_object('error','invalid_grant'); end if;
  select array_agg(v order by ord) into permitted
    from unnest(g.allowed_tools) with ordinality as a(v,ord)
    where v=any(s.allowed_tools) and (v <> 'record_expense' or coalesce(p_direct_enabled,false));
  if coalesce(cardinality(permitted),0)=0 then return jsonb_build_object('error','invalid_grant'); end if;
  if p_scope is not null then
    requested := string_to_array(p_scope,' ');
    if not ('zama:private'=any(requested)) or array_position(requested,'') is not null
      or cardinality(requested) <> (select count(distinct v) from unnest(requested) as a(v))
      or not (requested <@ array['zama:private','zama:expenses:write']::text[])
      or ('zama:expenses:write'=any(requested) and not ('record_expense'=any(permitted))) then
      return jsonb_build_object('error','invalid_scope');
    end if;
    if not ('zama:expenses:write'=any(requested)) then permitted := array_remove(permitted,'record_expense'); end if;
  end if;
  if coalesce(cardinality(permitted),0)=0 then return jsonb_build_object('error','invalid_grant'); end if;
  -- No grace window: replay revokes the connection. Clients must serialize refresh.
  if p_next_refresh_hash is not distinct from p_refresh_hash or p_token_hash is not distinct from g.token_hash then
    return jsonb_build_object('error','invalid_grant');
  end if;
  access_expiry := least(t+interval '1 hour',s.absolute_expires_at);
  idle_expiry := least(t+interval '7 days',s.absolute_expires_at);
  -- Do not issue a token whose advertised lifetime would be zero seconds.
  if floor(extract(epoch from access_expiry-t)) < 1 then return jsonb_build_object('error','invalid_grant'); end if;
  update public.dot_oauth_v2_refresh_tokens set used_at=t where token_hash=p_refresh_hash;
  insert into public.dot_oauth_v2_refresh_tokens(token_hash,grant_id,access_token_hash,access_expires_at,created_at,expires_at)
    values(p_next_refresh_hash,g.id,p_token_hash,access_expiry,t,idle_expiry);
  update public.dot_oauth_v2_sessions set idle_expires_at=idle_expiry,allowed_tools=permitted where grant_id=g.id;
  -- The existing version trigger invalidates any principal authenticated before rotation.
  update public.dot_api_grants set token_hash=p_token_hash,expires_at=access_expiry,allowed_tools=permitted where id=g.id;
  issued_scope := 'zama:private'||case when 'record_expense'=any(permitted) then ' zama:expenses:write' else '' end;
  return jsonb_build_object('grant_id',g.id,'expires_in',floor(extract(epoch from access_expiry-t))::integer,
    'refresh_token_expires_in',floor(extract(epoch from idle_expiry-t))::integer,'scope',issued_scope);
end $$;

create function public.dot_oauth_v2_revoke(p_token_hash text,p_owner uuid,p_client text,p_resource text)
returns boolean language plpgsql security definer set search_path='' as $$
declare target uuid; g public.dot_api_grants%rowtype;
begin
  -- Retired access/refresh hashes remain revocable for the lifetime of the family.
  select grant_id into target from public.dot_oauth_v2_refresh_tokens
    where token_hash=p_token_hash or access_token_hash=p_token_hash limit 1;
  if target is null then return true; end if;
  select * into g from public.dot_api_grants where id=target for update;
  if not found or g.owner_id is distinct from p_owner or g.client_id is distinct from p_client
    or g.resource is distinct from p_resource then return true; end if;
  if g.revoked_at is null then update public.dot_api_grants set revoked_at=clock_timestamp() where id=g.id; end if;
  return true;
end $$;

revoke all on function public.dot_oauth_v2_exchange_refresh(text,uuid,text,text,text,text,uuid,text,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.dot_oauth_v2_refresh(text,uuid,uuid,text,text,text,text,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.dot_oauth_v2_revoke(text,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.dot_oauth_v2_exchange_refresh(text,uuid,text,text,text,text,uuid,text,text,boolean) to service_role;
grant execute on function public.dot_oauth_v2_refresh(text,uuid,uuid,text,text,text,text,text,boolean) to service_role;
grant execute on function public.dot_oauth_v2_revoke(text,uuid,text,text) to service_role;
-- Compatibility revocation: keep the deployed v1 rotation and issuance RPCs intact.
-- A proven retired access/refresh token revokes its entire v1 family. Locking the
-- family first matches deployed v1 rotation, including a concurrent successor.
create function public.dot_oauth_v1_revoke_by_token(p_token_hash text,p_owner uuid,p_client text,p_resource text)
returns boolean language plpgsql security definer set search_path='' as $$
declare target uuid; legacy_grant uuid; f public.dot_oauth_families%rowtype; g public.dot_api_grants%rowtype;
begin
  select family_id into target from public.dot_oauth_refresh_tokens where token_hash=p_token_hash;
  if target is null then
    select oauth_family_id,id into target,legacy_grant from public.dot_api_grants where token_hash=p_token_hash;
  end if;
  if target is not null then
    select * into f from public.dot_oauth_families where id=target for update;
    if not found or f.owner_id is distinct from p_owner or f.client_id is distinct from p_client
      or f.resource is distinct from p_resource then return true; end if;
    perform public.dot_oauth_revoke_family(f.id);
    return true;
  end if;
  if legacy_grant is null then return true; end if;
  -- Nonrenewable legacy grants remain revocable, but never handle a v2 grant here.
  if exists(select 1 from public.dot_oauth_v2_sessions where grant_id=legacy_grant) then return true; end if;
  select * into g from public.dot_api_grants where id=legacy_grant for update;
  if not found or g.token_hash is distinct from p_token_hash or g.oauth_family_id is not null
    or g.owner_id is distinct from p_owner or g.client_id is distinct from p_client
    or g.resource is distinct from p_resource then return true; end if;
  if g.revoked_at is null then
    update public.dot_api_grants set revoked_at=clock_timestamp() where id=g.id;
  end if;
  return true;
end $$;
revoke all on function public.dot_oauth_v1_revoke_by_token(text,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.dot_oauth_v1_revoke_by_token(text,uuid,text,text) to service_role;

-- One uniform endpoint for v1, v2 and nonrenewable legacy credentials.
-- Both steps commit together; a database failure never reports false success.
create function public.dot_oauth_revoke_compatible(p_token_hash text,p_owner uuid,p_client text,p_resource text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform public.dot_oauth_v1_revoke_by_token(p_token_hash,p_owner,p_client,p_resource);
  perform public.dot_oauth_v2_revoke(p_token_hash,p_owner,p_client,p_resource);
  return true;
end $$;
revoke all on function public.dot_oauth_revoke_compatible(text,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.dot_oauth_revoke_compatible(text,uuid,text,text) to service_role;

commit;
