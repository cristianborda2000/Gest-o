-- Additive; apply AFTER 20261005_workspaces.sql as the Supabase project owner.
-- Does not read or migrate legacy project/password data from app_state.
begin;

alter table public.zama_workspace_members drop constraint if exists zama_workspace_members_role_check;
alter table public.zama_workspace_members add constraint zama_workspace_members_role_check check(role in ('editor','viewer','projects'));
alter table public.zama_workspace_invites drop constraint if exists zama_workspace_invites_role_check;
alter table public.zama_workspace_invites add constraint zama_workspace_invites_role_check check(role in ('editor','viewer','projects'));

-- Project-only members must never pass the existing app_state RLS policies.
create or replace function public.zama_workspace_access(p_owner uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (p_owner=auth.uid() or exists(
    select 1 from public.zama_workspace_members m where m.owner_id=p_owner and m.user_id=auth.uid()
      and m.role in ('editor','viewer') and (not p_write or m.role='editor')));
$$;

create or replace function public.zama_workspace_invite(p_email text,p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_token text; v_email text=lower(btrim(p_email)); v_owner uuid=auth.uid();
begin
  if v_owner is null or p_role is null or p_role not in ('editor','viewer','projects') or v_email is null
    or length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Convite inválido.';
  end if;
  if not exists(select 1 from auth.users where id=v_owner and email_confirmed_at is not null) then
    raise exception 'Confirme seu e-mail antes de convidar pessoas.';
  end if;
  if exists(select 1 from auth.users where id=v_owner and lower(email)=v_email) then
    raise exception 'Você já é o proprietário desta empresa.';
  end if;
  if not exists(select 1 from public.app_state where user_id=v_owner) then
    raise exception 'Salve os dados da sua empresa antes de gerar um convite.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text,742));
  if (select count(*) from public.zama_workspace_invites where owner_id=v_owner and created_at>now()-interval '1 hour')>=30 then
    raise exception 'Limite de convites atingido. Tente novamente mais tarde.';
  end if;
  update public.zama_workspace_invites set revoked_at=now() where owner_id=v_owner and email=v_email and accepted_at is null and revoked_at is null;
  v_token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  insert into public.zama_workspace_invites(owner_id,email,role,token_hash)
    values(v_owner,v_email,p_role,encode(sha256(convert_to(v_token,'UTF8')),'hex')) returning id into v_id;
  return jsonb_build_object('id',v_id,'token',v_token,'expires_at',now()+interval '7 days');
end $$;

create or replace function public.zama_workspace_set_role(p_user uuid,p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_role is null or p_role not in ('editor','viewer','projects') then raise exception 'Permissão inválida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,742));
  -- An older invitation must not restore a permission the owner just removed.
  -- Lock invitations before membership, matching the acceptance flow's order.
  update public.zama_workspace_invites set revoked_at=now()
    where owner_id=auth.uid() and accepted_at is null and revoked_at is null
      and email=(select lower(btrim(email)) from auth.users where id=p_user)
      and exists(select 1 from public.zama_workspace_members where owner_id=auth.uid() and user_id=p_user);
  update public.zama_workspace_members set role=p_role where owner_id=auth.uid() and user_id=p_user;
end $$;

create or replace function public.zama_workspace_revoke(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,742));
  update public.zama_workspace_invites set revoked_at=now()
    where owner_id=auth.uid() and accepted_at is null and revoked_at is null
      and email=(select lower(btrim(email)) from auth.users where id=p_user);
  delete from public.zama_workspace_members where owner_id=auth.uid() and user_id=p_user;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists zama_private;
revoke all on schema zama_private from public,anon,authenticated,service_role;
create table if not exists zama_private.project_key (
  singleton boolean primary key default true check(singleton),
  secret text not null
);
alter table zama_private.project_key enable row level security;
alter table zama_private.project_key force row level security;
revoke all on zama_private.project_key from public,anon,authenticated,service_role;

-- pgcrypto may already be installed in public or extensions. Resolve its actual
-- schema once at migration time, then bind schema-qualified calls in the helpers.
do $migration$
declare v_schema text; v_key text;
begin
  select n.nspname into strict v_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if not exists(select 1 from zama_private.project_key) then
    execute format('select encode(%I.gen_random_bytes(32),''hex'')',v_schema) into v_key;
    insert into zama_private.project_key(secret) values(v_key);
  end if;
  execute format($function$
    create or replace function zama_private.project_encrypt(p_value text) returns bytea
    language sql security definer set search_path = '' as $body$
      select %I.pgp_sym_encrypt(p_value,(select secret from zama_private.project_key where singleton),'cipher-algo=aes256,compress-algo=0')
    $body$
  $function$,v_schema);
  execute format($function$
    create or replace function zama_private.project_decrypt(p_value bytea) returns text
    language sql security definer set search_path = '' as $body$
      select %I.pgp_sym_decrypt(p_value,(select secret from zama_private.project_key where singleton))
    $body$
  $function$,v_schema);
end $migration$;
revoke all on function zama_private.project_encrypt(text),zama_private.project_decrypt(bytea) from public,anon,authenticated,service_role;

create table if not exists public.zama_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  client_name text not null default '',
  company_name text not null default '',
  client_email text not null default '',
  access_url text not null default '',
  responsible_email text not null default '',
  responsible_name text not null default '',
  status text not null default 'planning' check(status in ('planning','in_progress','waiting','completed')),
  due_date date,
  notes text not null default '',
  catalog_steps jsonb not null default '[]'::jsonb check(jsonb_typeof(catalog_steps)='array'),
  onboarding_steps jsonb not null default '[]'::jsonb check(jsonb_typeof(onboarding_steps)='array'),
  password_cipher bytea,
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists zama_projects_owner on public.zama_projects(owner_id,updated_at desc);
alter table public.zama_projects enable row level security;
alter table public.zama_projects force row level security;
-- No browser table access, including the owner: all access is checked in RPCs.
revoke all on public.zama_projects from public,anon,authenticated;

create or replace function zama_private.project_access(p_owner uuid,p_email text,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (p_owner=auth.uid() or exists(
    select 1 from public.zama_workspace_members m join auth.users u on u.id=m.user_id
    where m.owner_id=p_owner and m.user_id=auth.uid() and u.email_confirmed_at is not null
      and lower(btrim(u.email))=p_email and p_email<>''
      and m.role in ('projects','editor','viewer') and (not p_write or m.role in ('projects','editor'))));
$$;
create or replace function zama_private.project_json(p public.zama_projects)
returns jsonb language sql stable set search_path = '' as $$
  select (to_jsonb(p)-'password_cipher'-'owner_id') || jsonb_build_object('has_password',p.password_cipher is not null)
$$;
revoke all on function zama_private.project_access(uuid,text,boolean),zama_private.project_json(public.zama_projects) from public,anon,authenticated,service_role;

create or replace function public.zama_projects_list(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(zama_private.project_json(p) order by p.updated_at desc,p.id),'[]'::jsonb)
  from public.zama_projects p where p.owner_id=p_owner and zama_private.project_access(p.owner_id,p.responsible_email,false)
$$;

create or replace function public.zama_project_save(p_owner uuid,p_project jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old public.zama_projects; v_saved public.zama_projects; v_data jsonb; v_id uuid;
  v_field text; v_steps jsonb; v_new boolean; v_cipher bytea;
begin
  if auth.uid() is null or p_owner is null then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
  if p_project is null or jsonb_typeof(p_project)<>'object' or octet_length(p_project::text)>262144 then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  v_id := coalesce(nullif(p_project->>'id','')::uuid,gen_random_uuid());
  select * into v_old from public.zama_projects where id=v_id and owner_id=p_owner for update;
  v_new := not found;
  if v_new then
    if p_owner<>auth.uid() then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
    if coalesce(p_project->>'revision','0')<>'0' then raise exception 'PROJECT_CONFLICT' using errcode='40001'; end if;
    v_data := jsonb_build_object('title','','client_name','','company_name','','client_email','','access_url','',
      'responsible_email','','responsible_name','','status','planning','due_date',null,'notes','','catalog_steps','[]'::jsonb,'onboarding_steps','[]'::jsonb);
  else
    if not zama_private.project_access(p_owner,v_old.responsible_email,true) then
      raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
    end if;
    if p_project->>'revision' is distinct from v_old.revision::text then
      raise exception 'PROJECT_CONFLICT' using errcode='40001';
    end if;
    v_data := zama_private.project_json(v_old);
    if p_owner<>auth.uid() then
      -- Full-form clients may echo unchanged protected fields, but cannot change
      -- client identity, assignment, deadlines, or stored credentials.
      foreach v_field in array array['title','client_name','company_name','client_email','access_url','responsible_email','responsible_name','due_date'] loop
        if p_project ? v_field and p_project->v_field is distinct from v_data->v_field then
          raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
        end if;
      end loop;
      if p_project ? 'password' then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
    end if;
  end if;
  v_data := v_data || p_project;
  foreach v_field in array array['title','client_name','company_name','client_email','access_url','responsible_email','responsible_name','status','notes'] loop
    if jsonb_typeof(v_data->v_field) is distinct from 'string'
      or length(v_data->>v_field)>(case when v_field='notes' then 20000 when v_field='access_url' then 2048 else 254 end) then
      raise exception 'PROJECT_INVALID_FIELD: %',v_field using errcode='22023';
    end if;
  end loop;
  foreach v_field in array array['title','client_name'] loop
    v_data := jsonb_set(v_data,array[v_field],to_jsonb(regexp_replace(v_data->>v_field,'^[[:space:]]+|[[:space:]]+$','','g')));
    if length(v_data->>v_field)=0 then
      raise exception 'PROJECT_INVALID_FIELD: %',v_field using errcode='22023';
    end if;
  end loop;
  if v_data->>'status' not in ('planning','in_progress','waiting','completed') then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  foreach v_field in array array['responsible_email','client_email'] loop
    v_data := jsonb_set(v_data,array[v_field],to_jsonb(lower(btrim(v_data->>v_field))));
    if v_data->>v_field<>'' and v_data->>v_field !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'PROJECT_INVALID_EMAIL' using errcode='22023';
    end if;
  end loop;
  if v_data->>'access_url'<>'' and v_data->>'access_url' !~* '^https?://[^[:space:]]+$' then
    raise exception 'PROJECT_INVALID_URL' using errcode='22023';
  end if;
  if v_data->>'due_date' is not null and v_data->>'due_date'<>'' and v_data->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
  end if;
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    v_steps := v_data->v_field;
    if jsonb_typeof(v_steps) is distinct from 'array' then raise exception 'PROJECT_INVALID_STEPS' using errcode='22023'; end if;
    if jsonb_array_length(v_steps)>100 or exists(
      select 1 from jsonb_array_elements(v_steps) s where jsonb_typeof(s)<>'object'
        or jsonb_typeof(s->'id') is distinct from 'string' or length(btrim(s->>'id')) not between 1 and 80
        or jsonb_typeof(s->'label') is distinct from 'string' or length(btrim(s->>'label')) not between 1 and 254
        or jsonb_typeof(s->'done') is distinct from 'boolean'
        or s - array['id','label','done'] <> '{}'::jsonb
    ) or (select count(*)<>count(distinct s->>'id') from jsonb_array_elements(v_steps) s) then
      raise exception 'PROJECT_INVALID_STEPS' using errcode='22023';
    end if;
  end loop;
  v_cipher := v_old.password_cipher;
  if p_project ? 'password' then
    if jsonb_typeof(p_project->'password') is distinct from 'string' or length(p_project->>'password')>4096 then
      raise exception 'PROJECT_INVALID_PASSWORD' using errcode='22023';
    end if;
    v_cipher := case when p_project->>'password'='' then null else zama_private.project_encrypt(p_project->>'password') end;
  end if;
  if v_new then
    insert into public.zama_projects(id,owner_id,title) values(v_id,p_owner,v_data->>'title');
  end if;
  update public.zama_projects set
    title=btrim(v_data->>'title'),client_name=v_data->>'client_name',company_name=v_data->>'company_name',
    client_email=v_data->>'client_email',access_url=v_data->>'access_url',responsible_email=v_data->>'responsible_email',
    responsible_name=v_data->>'responsible_name',status=v_data->>'status',due_date=nullif(v_data->>'due_date','')::date,
    notes=v_data->>'notes',catalog_steps=v_data->'catalog_steps',onboarding_steps=v_data->'onboarding_steps',
    password_cipher=v_cipher,revision=case when v_new then 1 else v_old.revision+1 end,updated_at=clock_timestamp()
  where id=v_id and owner_id=p_owner returning * into v_saved;
  return zama_private.project_json(v_saved);
end $$;

create or replace function public.zama_project_secret(p_owner uuid,p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_project public.zama_projects;
begin
  select * into v_project from public.zama_projects where id=p_id and owner_id=p_owner;
  if not found or not zama_private.project_access(p_owner,v_project.responsible_email,true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  return case when v_project.password_cipher is null then '' else zama_private.project_decrypt(v_project.password_cipher) end;
end $$;

create or replace function public.zama_project_delete(p_owner uuid,p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_owner is distinct from auth.uid() then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
  delete from public.zama_projects where id=p_id and owner_id=p_owner;
end $$;

revoke all on function public.zama_workspace_access(uuid,boolean),public.zama_workspace_invite(text,text),public.zama_workspace_set_role(uuid,text),public.zama_workspace_revoke(uuid),
  public.zama_projects_list(uuid),public.zama_project_save(uuid,jsonb),public.zama_project_secret(uuid,uuid),public.zama_project_delete(uuid,uuid) from public,anon;
grant execute on function public.zama_workspace_access(uuid,boolean),public.zama_workspace_invite(text,text),public.zama_workspace_set_role(uuid,text),public.zama_workspace_revoke(uuid),
  public.zama_projects_list(uuid),public.zama_project_save(uuid,jsonb),public.zama_project_secret(uuid,uuid),public.zama_project_delete(uuid,uuid) to authenticated;
commit;
