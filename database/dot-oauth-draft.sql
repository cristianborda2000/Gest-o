-- DRAFT: additive OAuth schema, NOT applied to production. Depends on dot_grants.
begin;
create table public.dot_oauth_codes (
 code_hash text primary key check(code_hash ~ '^[a-f0-9]{64}$'),
 owner_id uuid not null references auth.users(id) on delete cascade,
 client_id text not null, resource text not null, redirect_uri text not null,
 challenge text not null check(challenge ~ '^[A-Za-z0-9_-]{43}$'),
 expires_at timestamptz not null default (clock_timestamp()+interval '2 minutes'),
 used_grant_id uuid references public.dot_api_grants(id),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.dot_oauth_codes enable row level security;
alter table public.dot_oauth_codes force row level security;
revoke all on public.dot_oauth_codes from public,anon,authenticated,service_role;
grant insert on public.dot_oauth_codes to service_role;
create function public.dot_oauth_exchange(p_code_hash text,p_owner uuid,p_client text,p_resource text,p_redirect text,p_challenge text,p_grant uuid,p_token_hash text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.dot_oauth_codes%rowtype;
begin
 select * into c from public.dot_oauth_codes where code_hash=p_code_hash for update;
 if not found or c.owner_id is distinct from p_owner or c.client_id is distinct from p_client
 or c.resource is distinct from p_resource or c.redirect_uri is distinct from p_redirect
 or c.challenge is distinct from p_challenge then return false; end if;
 -- A replay with the correct PKCE proof revokes the token already issued.
 if c.used_grant_id is not null then
   update public.dot_api_grants set revoked_at=clock_timestamp() where id=c.used_grant_id and revoked_at is null;
   return false;
 end if;
 if c.expires_at <= clock_timestamp() then return false; end if;
 insert into public.dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at)
 values(p_grant,c.owner_id,c.client_id,c.resource,p_token_hash,
 array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense'],clock_timestamp()+interval '1 hour');
 update public.dot_oauth_codes set used_grant_id=p_grant where code_hash=p_code_hash;
 return true;
end $$;
revoke all on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text) to service_role;
commit;
