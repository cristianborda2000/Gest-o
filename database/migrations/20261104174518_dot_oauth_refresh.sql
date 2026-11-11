-- Additive refresh sessions; requires dot_direct_expenses already applied.
-- Existing grants remain usable and are never upgraded to refresh sessions.
begin;

create table public.dot_oauth_families (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 client_id text not null,
 resource text not null,
 allowed_tools text[] not null check (cardinality(allowed_tools)>0 and array_position(allowed_tools,null) is null),
 current_grant_id uuid not null references public.dot_api_grants(id),
 current_grant_version integer not null check (current_grant_version>0),
 created_at timestamptz not null default clock_timestamp(),
 last_used_at timestamptz not null default clock_timestamp(),
 idle_expires_at timestamptz not null default (clock_timestamp()+interval '30 days'),
 revoked_at timestamptz
);
alter table public.dot_oauth_families enable row level security;
alter table public.dot_oauth_families force row level security;
revoke all on public.dot_oauth_families from public,anon,authenticated,service_role;

alter table public.dot_api_grants add column oauth_family_id uuid references public.dot_oauth_families(id);
create index dot_api_grants_oauth_family_idx on public.dot_api_grants(oauth_family_id) where oauth_family_id is not null;

create function public.dot_oauth_family_revoked() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
   update public.dot_api_grants set revoked_at=coalesce(revoked_at,new.revoked_at) where oauth_family_id=new.id and revoked_at is null;
 end if;
 return new;
end $$;
revoke all on function public.dot_oauth_family_revoked() from public,anon,authenticated,service_role;
create trigger dot_oauth_family_revoked after update of revoked_at on public.dot_oauth_families for each row execute function public.dot_oauth_family_revoked();

create table public.dot_oauth_refresh_tokens (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 family_id uuid not null references public.dot_oauth_families(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 used_at timestamptz
);
create index dot_oauth_refresh_family_idx on public.dot_oauth_refresh_tokens(family_id);
alter table public.dot_oauth_refresh_tokens enable row level security;
alter table public.dot_oauth_refresh_tokens force row level security;
revoke all on public.dot_oauth_refresh_tokens from public,anon,authenticated,service_role;

create function public.dot_oauth_revoke_family(p_family uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 update public.dot_oauth_families set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=p_family;
 update public.dot_api_grants set revoked_at=clock_timestamp() where oauth_family_id=p_family and revoked_at is null;
end $$;
revoke all on function public.dot_oauth_revoke_family(uuid) from public,anon,authenticated,service_role;

-- Keep the existing RPC signature for staged rollout and old application builds.
-- Proven authorization-code replay also revokes any descendants after rotation.
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
 array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense'] || case when c.allow_direct_expense and p_direct_enabled then array['record_expense']::text[] else array[]::text[] end,clock_timestamp()+interval '1 hour');
 update public.dot_oauth_codes set used_grant_id=p_grant where code_hash=p_code_hash;
 return true;
end $$;
revoke all on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean) to service_role;

create function public.dot_oauth_exchange_refresh(p_code_hash text,p_owner uuid,p_client text,p_resource text,p_redirect text,p_challenge text,p_grant uuid,p_token_hash text,p_family uuid,p_refresh_hash text,p_direct_enabled boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.dot_api_grants%rowtype;
begin
 if not public.dot_oauth_exchange(p_code_hash,p_owner,p_client,p_resource,p_redirect,p_challenge,p_grant,p_token_hash,p_direct_enabled) then return null; end if;
 select * into strict g from public.dot_api_grants where id=p_grant;
 insert into public.dot_oauth_families(id,owner_id,client_id,resource,allowed_tools,current_grant_id,current_grant_version)
 values(p_family,g.owner_id,g.client_id,g.resource,g.allowed_tools,g.id,g.version);
 update public.dot_api_grants set oauth_family_id=p_family where id=g.id returning * into g;
 update public.dot_oauth_families set current_grant_version=g.version where id=p_family;
 insert into public.dot_oauth_refresh_tokens(token_hash,family_id) values(p_refresh_hash,p_family);
 return jsonb_build_object('allowed_tools',g.allowed_tools,'expires_in',3600);
end $$;
revoke all on function public.dot_oauth_exchange_refresh(text,uuid,text,text,text,text,uuid,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.dot_oauth_exchange_refresh(text,uuid,text,text,text,text,uuid,text,uuid,text,boolean) to service_role;

create function public.dot_oauth_refresh(p_refresh_hash text,p_owner uuid,p_client text,p_resource text,p_grant uuid,p_token_hash text,p_next_refresh_hash text,p_direct_enabled boolean default false,p_scope text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.dot_oauth_refresh_tokens%rowtype; f public.dot_oauth_families%rowtype; g public.dot_api_grants%rowtype;
 next_tools text[]; access_expiry timestamptz; stamp timestamptz;
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
 if p_scope is not null and p_scope not in ('zama:private','zama:private zama:expenses:write') then return null; end if;
 if p_scope='zama:private zama:expenses:write' and not ('record_expense'=any(f.allowed_tools)) then return null; end if;
 if p_scope='zama:private zama:expenses:write' and p_direct_enabled is not true then return null; end if;
 next_tools:=f.allowed_tools;
 if p_direct_enabled is not true or p_scope='zama:private' then next_tools:=array_remove(next_tools,'record_expense'); end if;
 access_expiry:=stamp+interval '1 hour';
 update public.dot_oauth_refresh_tokens set used_at=stamp where token_hash=p_refresh_hash;
 update public.dot_api_grants set revoked_at=stamp where id=g.id;
 insert into public.dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at,oauth_family_id)
 values(p_grant,f.owner_id,f.client_id,f.resource,p_token_hash,next_tools,access_expiry,f.id);
 insert into public.dot_oauth_refresh_tokens(token_hash,family_id) values(p_next_refresh_hash,f.id);
 update public.dot_oauth_families set current_grant_id=p_grant,current_grant_version=1,allowed_tools=next_tools,last_used_at=stamp,idle_expires_at=stamp+interval '30 days' where id=f.id;
 return jsonb_build_object('allowed_tools',next_tools,'expires_in',greatest(1,floor(extract(epoch from access_expiry-stamp))::integer));
end $$;
revoke all on function public.dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text) to service_role;

commit;
