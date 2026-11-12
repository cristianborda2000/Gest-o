-- Add explicit, separate permission to cancel agenda events without deleting history.
-- Requires deployed OAuth, direct expenses, refresh V1 and refresh V2 migrations.
-- Existing grants/families/sessions are not updated or broadened.
-- Existing authorization codes default to no cancellation permission.
-- RPC signatures and all expiry, locking, replay and revocation rules are preserved.
-- DOT_AGENDA_CANCEL_ENABLED gates metadata, consent and MCP execution in the server.
-- Disabling that flag does not revoke an already approved grant.
begin;

alter table public.dot_oauth_codes add column allow_agenda_cancel boolean not null default false;
alter table public.dot_api_grants drop constraint dot_api_grants_allowed_tools_check;
alter table public.dot_api_grants add constraint dot_api_grants_allowed_tools_check
  check(cardinality(allowed_tools)>0 and array_position(allowed_tools,null) is null
    and allowed_tools <@ array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense','record_expense','cancel_agenda_event']::text[]);

-- A new code is the only path to a newly approved cancellation permission.
create or replace function public.dot_oauth_exchange(p_code_hash text,p_owner uuid,p_client text,p_resource text,p_redirect text,p_challenge text,p_grant uuid,p_token_hash text,p_direct_enabled boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare c public.dot_oauth_codes%rowtype; family uuid;
begin
 select * into c from public.dot_oauth_codes where code_hash=p_code_hash for update;
 if not found or c.owner_id is distinct from p_owner or c.client_id is distinct from p_client
 or c.resource is distinct from p_resource or c.redirect_uri is distinct from p_redirect
 or c.challenge is distinct from p_challenge then return false; end if;
 if c.used_grant_id is not null then
   select oauth_family_id into family from public.dot_api_grants where id=c.used_grant_id;
   if family is not null then perform public.dot_oauth_revoke_family(family); end if;
   update public.dot_api_grants set revoked_at=clock_timestamp() where id=c.used_grant_id and revoked_at is null;
   return false;
 end if;
 if c.expires_at <= clock_timestamp() then return false; end if;
 insert into public.dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at)
 values(p_grant,c.owner_id,c.client_id,c.resource,p_token_hash,
 array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense'] || case when c.allow_direct_expense and p_direct_enabled then array['record_expense']::text[] else array[]::text[] end
 || case when c.allow_agenda_cancel then array['cancel_agenda_event']::text[] else array[]::text[] end,clock_timestamp()+interval '1 hour');
 update public.dot_oauth_codes set used_grant_id=p_grant where code_hash=p_code_hash;
 return true;
end $$;

create or replace function public.dot_oauth_refresh(p_refresh_hash text,p_owner uuid,p_client text,p_resource text,p_grant uuid,p_token_hash text,p_next_refresh_hash text,p_direct_enabled boolean default false,p_scope text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.dot_oauth_refresh_tokens%rowtype; f public.dot_oauth_families%rowtype; g public.dot_api_grants%rowtype;
 next_tools text[]; requested text[]; access_expiry timestamptz; stamp timestamptz;
begin
 -- Hash proof precedes family lookup. Knowing a family UUID cannot revoke it.
 select * into r from public.dot_oauth_refresh_tokens where token_hash=p_refresh_hash;
 if not found then return null; end if;
 select * into f from public.dot_oauth_families where id=r.family_id for update;
 if not found or f.owner_id is distinct from p_owner or f.client_id is distinct from p_client or f.resource is distinct from p_resource then return null; end if;
 select * into r from public.dot_oauth_refresh_tokens where token_hash=p_refresh_hash for update;
 if r.used_at is not null then perform public.dot_oauth_revoke_family(f.id); return null; end if;
 if f.revoked_at is not null then return null; end if;
 stamp:=clock_timestamp();
 select * into g from public.dot_api_grants where id=f.current_grant_id for update;
 -- An expired access token is expected; revocation or administrator changes are not.
 if not found or f.idle_expires_at<=stamp
 or g.revoked_at is not null or g.not_before>stamp or g.version is distinct from f.current_grant_version
 or g.owner_id is distinct from f.owner_id or g.client_id is distinct from f.client_id or g.resource is distinct from f.resource
 or g.oauth_family_id is distinct from f.id or g.allowed_tools is distinct from f.allowed_tools then
   perform public.dot_oauth_revoke_family(f.id); return null;
 end if;
 next_tools:=f.allowed_tools;
 if p_direct_enabled is not true then next_tools:=array_remove(next_tools,'record_expense'); end if;
 if p_scope is not null then
   requested:=string_to_array(p_scope,' ');
   if not ('zama:private'=any(requested)) or array_position(requested,'') is not null
     or cardinality(requested) <> (select count(distinct v) from unnest(requested) as a(v))
     or not (requested <@ array['zama:private','zama:expenses:write','zama:agenda:cancel']::text[])
     or ('zama:expenses:write'=any(requested) and not ('record_expense'=any(next_tools)))
     or ('zama:agenda:cancel'=any(requested) and not ('cancel_agenda_event'=any(next_tools))) then return null; end if;
   if not ('zama:expenses:write'=any(requested)) then next_tools:=array_remove(next_tools,'record_expense'); end if;
   if not ('zama:agenda:cancel'=any(requested)) then next_tools:=array_remove(next_tools,'cancel_agenda_event'); end if;
 end if;
 access_expiry:=stamp+interval '1 hour';
 update public.dot_oauth_refresh_tokens set used_at=stamp where token_hash=p_refresh_hash;
 update public.dot_api_grants set revoked_at=stamp where id=g.id;
 insert into public.dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at,oauth_family_id)
 values(p_grant,f.owner_id,f.client_id,f.resource,p_token_hash,next_tools,access_expiry,f.id);
 insert into public.dot_oauth_refresh_tokens(token_hash,family_id) values(p_next_refresh_hash,f.id);
 update public.dot_oauth_families set current_grant_id=p_grant,current_grant_version=1,allowed_tools=next_tools,last_used_at=stamp,idle_expires_at=stamp+interval '30 days' where id=f.id;
 return jsonb_build_object('allowed_tools',next_tools,'expires_in',greatest(1,floor(extract(epoch from access_expiry-stamp))::integer));
end $$;

create or replace function public.dot_oauth_v2_exchange_refresh(
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
    'scope','zama:private'||case when 'record_expense'=any(g.allowed_tools) then ' zama:expenses:write' else '' end
      ||case when 'cancel_agenda_event'=any(g.allowed_tools) then ' zama:agenda:cancel' else '' end);
end $$;

create or replace function public.dot_oauth_v2_refresh(
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
      or not (requested <@ array['zama:private','zama:expenses:write','zama:agenda:cancel']::text[])
      or ('zama:expenses:write'=any(requested) and not ('record_expense'=any(permitted)))
      or ('zama:agenda:cancel'=any(requested) and not ('cancel_agenda_event'=any(permitted))) then
      return jsonb_build_object('error','invalid_scope');
    end if;
    if not ('zama:expenses:write'=any(requested)) then permitted := array_remove(permitted,'record_expense'); end if;
    if not ('zama:agenda:cancel'=any(requested)) then permitted := array_remove(permitted,'cancel_agenda_event'); end if;
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
  issued_scope := 'zama:private'||case when 'record_expense'=any(permitted) then ' zama:expenses:write' else '' end
    ||case when 'cancel_agenda_event'=any(permitted) then ' zama:agenda:cancel' else '' end;
  return jsonb_build_object('grant_id',g.id,'expires_in',floor(extract(epoch from access_expiry-t))::integer,
    'refresh_token_expires_in',floor(extract(epoch from idle_expiry-t))::integer,'scope',issued_scope);
end $$;

-- Reassert the server-only RPC surface; preserve forced RLS and table privileges.
revoke all on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text) from public,anon,authenticated,service_role;
revoke all on function public.dot_oauth_v2_exchange_refresh(text,uuid,text,text,text,text,uuid,text,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.dot_oauth_v2_refresh(text,uuid,uuid,text,text,text,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean) to service_role;
grant execute on function public.dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text) to service_role;
grant execute on function public.dot_oauth_v2_exchange_refresh(text,uuid,text,text,text,text,uuid,text,text,boolean) to service_role;
grant execute on function public.dot_oauth_v2_refresh(text,uuid,uuid,text,text,text,text,text,boolean) to service_role;
commit;
