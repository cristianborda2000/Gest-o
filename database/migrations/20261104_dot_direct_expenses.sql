-- REVIEW ONLY. No existing grant is expanded. Requires dot-oauth-draft already applied.
begin;
alter table public.dot_api_grants drop constraint dot_api_grants_allowed_tools_check;
alter table public.dot_api_grants add constraint dot_api_grants_allowed_tools_check check(cardinality(allowed_tools)>0 and array_position(allowed_tools,null) is null and allowed_tools <@ array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense','record_expense']::text[]);
alter table public.dot_oauth_codes add column allow_direct_expense boolean not null default false;
drop function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text);
create function public.dot_oauth_exchange(p_code_hash text,p_owner uuid,p_client text,p_resource text,p_redirect text,p_challenge text,p_grant uuid,p_token_hash text,p_direct_enabled boolean default false)
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
 array['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense'] || case when c.allow_direct_expense and p_direct_enabled then array['record_expense']::text[] else array[]::text[] end,clock_timestamp()+interval '1 hour');
 update public.dot_oauth_codes set used_grant_id=p_grant where code_hash=p_code_hash;
 return true;
end $$;
revoke all on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean) to service_role;
commit;
