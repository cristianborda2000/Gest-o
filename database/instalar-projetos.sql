-- Instalacao de Projetos, Acesso do time e listas de producao manuais.
-- Gerado por npm run build:projects-sql. Nao editar este arquivo diretamente.
-- Execute TODO este arquivo no SQL Editor do projeto Supabase da instalacao,
-- usando o papel postgres (proprietario do projeto).
-- Requer a tabela public.app_state existente. Nao recria nem apaga essa tabela.
-- Reaplicavel: preserva dados, membros, convites, progresso e chave das senhas.
-- Todas as migrations sao aplicadas juntas; uma falha reverte toda a instalacao.

begin;

do $setup$
begin
  if to_regclass('public.app_state') is null then
    raise exception 'A tabela public.app_state nao existe. Use o projeto Supabase conectado a esta instalacao ZAMA.';
  end if;
end $setup$;

-- Migration: 20261005_workspaces.sql
-- Additive sharing for the existing app_state row. Apply as project owner.
create table if not exists public.zama_workspace_members (
  owner_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('editor','viewer')),
  created_at timestamptz not null default now(),
  primary key(owner_id,user_id), check(owner_id <> user_id)
);
create index if not exists zama_workspace_members_user on public.zama_workspace_members(user_id);
create table if not exists public.zama_workspace_invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  role text not null check(role in ('editor','viewer')),
  token_hash text not null unique,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.zama_workspace_members enable row level security;
alter table public.zama_workspace_members force row level security;
alter table public.zama_workspace_invites enable row level security;
alter table public.zama_workspace_invites force row level security;
revoke all on public.zama_workspace_members, public.zama_workspace_invites from public,anon,authenticated;
grant select,insert,update,delete on public.zama_workspace_members, public.zama_workspace_invites to service_role;

create or replace function public.zama_workspace_access(p_owner uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (p_owner=auth.uid() or exists(
    select 1 from public.zama_workspace_members m where m.owner_id=p_owner and m.user_id=auth.uid()
    and (not p_write or m.role='editor')));
$$;
revoke all on function public.zama_workspace_access(uuid,boolean) from public,anon;
grant execute on function public.zama_workspace_access(uuid,boolean) to authenticated;
drop policy if exists zama_team_read on public.app_state;
create policy zama_team_read on public.app_state for select to authenticated
  using(public.zama_workspace_access(user_id,false));
drop policy if exists zama_team_update on public.app_state;
create policy zama_team_update on public.app_state for update to authenticated
  using(public.zama_workspace_access(user_id,true)) with check(public.zama_workspace_access(user_id,true));

-- A shared editor may edit data, but must never transfer ownership of the row.
create or replace function public.zama_preserve_state_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then raise exception 'O proprietário da empresa não pode ser alterado.'; end if;
  return new;
end $$;
drop trigger if exists zama_preserve_state_owner on public.app_state;
create trigger zama_preserve_state_owner before update on public.app_state for each row execute function public.zama_preserve_state_owner();

create or replace function public.zama_workspace_list()
returns table(owner_id uuid,role text,name text) language sql stable security definer set search_path = '' as $$
  select auth.uid(),'owner'::text,coalesce(nullif(s.data->'companyProfile'->>'nome',''),'Minha empresa')
    from (select 1) seed left join public.app_state s on s.user_id=auth.uid() where auth.uid() is not null
  union all
  select m.owner_id,m.role,coalesce(nullif(s.data->'companyProfile'->>'nome',''),'Empresa compartilhada')
    from public.zama_workspace_members m join public.app_state s on s.user_id=m.owner_id where m.user_id=auth.uid();
$$;

create or replace function public.zama_workspace_invite(p_email text,p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_token text; v_email text=lower(btrim(p_email)); v_owner uuid=auth.uid();
begin
  if v_owner is null or p_role is null or p_role not in ('editor','viewer') or v_email is null
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

create or replace function public.zama_workspace_accept(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_invite public.zama_workspace_invites; v_email text;
begin
  if auth.uid() is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Convite inválido ou expirado.'; end if;
  select lower(email) into v_email from auth.users where id=auth.uid() and email_confirmed_at is not null;
  select * into v_invite from public.zama_workspace_invites
    where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
  if v_invite.id is null or v_invite.revoked_at is not null or v_invite.expires_at<=now()
    or v_email is null or v_invite.email<>v_email or v_invite.owner_id=auth.uid() then
    raise exception 'Convite inválido, expirado ou destinado a outro e-mail. Confirme sua conta e tente novamente.';
  end if;
  if v_invite.accepted_at is not null then
    if exists(select 1 from public.zama_workspace_members where owner_id=v_invite.owner_id and user_id=auth.uid()) then return v_invite.owner_id; end if;
    raise exception 'Este convite já foi utilizado.';
  end if;
  insert into public.zama_workspace_members(owner_id,user_id,role) values(v_invite.owner_id,auth.uid(),v_invite.role)
    on conflict(owner_id,user_id) do update set role=excluded.role;
  update public.zama_workspace_invites set accepted_at=now() where id=v_invite.id;
  return v_invite.owner_id;
end $$;

create or replace function public.zama_workspace_roster()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',u.email,'role',m.role))
      from public.zama_workspace_members m join auth.users u on u.id=m.user_id where m.owner_id=auth.uid()),'[]'::jsonb),
    'invites',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'expires_at',i.expires_at))
      from public.zama_workspace_invites i where i.owner_id=auth.uid() and accepted_at is null and revoked_at is null and expires_at>now()),'[]'::jsonb));
$$;
create or replace function public.zama_workspace_revoke(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.zama_workspace_members where owner_id=auth.uid() and user_id=p_user;
end $$;
create or replace function public.zama_workspace_cancel_invite(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.zama_workspace_invites set revoked_at=now() where id=p_id and owner_id=auth.uid();
end $$;
create or replace function public.zama_workspace_set_role(p_user uuid,p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_role is null or p_role not in ('editor','viewer') then raise exception 'Permissão inválida.'; end if;
  update public.zama_workspace_members set role=p_role where owner_id=auth.uid() and user_id=p_user;
end $$;

revoke all on function public.zama_workspace_list(),public.zama_workspace_invite(text,text),public.zama_workspace_accept(text),
 public.zama_workspace_roster(),public.zama_workspace_revoke(uuid),public.zama_workspace_cancel_invite(uuid),public.zama_workspace_set_role(uuid,text) from public,anon;
grant execute on function public.zama_workspace_list(),public.zama_workspace_invite(text,text),public.zama_workspace_accept(text),
 public.zama_workspace_roster(),public.zama_workspace_revoke(uuid),public.zama_workspace_cancel_invite(uuid),public.zama_workspace_set_role(uuid,text) to authenticated;

-- Migration: 20261012_projects.sql
-- Additive; apply AFTER 20261005_workspaces.sql as the Supabase project owner.
-- Does not read or migrate legacy project/password data from app_state.

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

-- Migration: 20261013_project_lists.sql
-- Additive; apply AFTER 20261012_projects.sql as the Supabase project owner.
-- Existing checklist progress and encrypted credentials are preserved.

alter table public.zama_projects add column if not exists production_lists jsonb;

create or replace function zama_private.project_lists(p_lists jsonb,p_catalog jsonb,p_onboarding jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p_lists is null or p_lists='null'::jsonb then jsonb_build_array(
    jsonb_build_object('id','catalog','title','Catálogo','steps',coalesce(p_catalog,'[]'::jsonb)),
    jsonb_build_object('id','onboarding','title','Estruturação','steps',coalesce(p_onboarding,'[]'::jsonb)))
    else p_lists end
$$;
revoke all on function zama_private.project_lists(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

-- Only missing values are converted. An intentionally empty array remains empty.
update public.zama_projects
  set production_lists=zama_private.project_lists(production_lists,catalog_steps,onboarding_steps)
  where production_lists is null or production_lists='null'::jsonb;
alter table public.zama_projects alter column production_lists set default '[]'::jsonb;
alter table public.zama_projects alter column production_lists set not null;
alter table public.zama_projects drop constraint if exists zama_projects_production_lists_check;
alter table public.zama_projects add constraint zama_projects_production_lists_check check(jsonb_typeof(production_lists)='array');

create or replace function zama_private.project_json(p public.zama_projects)
returns jsonb language sql stable set search_path = '' as $$
  select (to_jsonb(p)-'password_cipher'-'owner_id') || jsonb_build_object(
    'has_password',p.password_cipher is not null,
    'production_lists',zama_private.project_lists(p.production_lists,p.catalog_steps,p.onboarding_steps))
$$;
revoke all on function zama_private.project_json(public.zama_projects) from public,anon,authenticated,service_role;

create or replace function zama_private.project_validate_steps(p_steps jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_step jsonb;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' then raise exception 'PROJECT_INVALID_STEPS' using errcode='22023'; end if;
  if jsonb_array_length(p_steps)>100 then raise exception 'PROJECT_INVALID_STEPS' using errcode='22023'; end if;
  for v_step in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(v_step) is distinct from 'object'
      or jsonb_typeof(v_step->'id') is distinct from 'string' or length(v_step->>'id') not between 1 and 80
      or regexp_replace(v_step->>'id','[[:space:]]','','g')=''
      or jsonb_typeof(v_step->'label') is distinct from 'string' or length(v_step->>'label') not between 1 and 254
      or regexp_replace(v_step->>'label','[[:space:]]','','g')=''
      or jsonb_typeof(v_step->'done') is distinct from 'boolean'
      or v_step - array['id','label','done'] <> '{}'::jsonb then
      raise exception 'PROJECT_INVALID_STEPS' using errcode='22023';
    end if;
  end loop;
  if (select count(*)<>count(distinct s->>'id') from jsonb_array_elements(p_steps) s) then
    raise exception 'PROJECT_INVALID_STEPS' using errcode='22023';
  end if;
end $$;
revoke all on function zama_private.project_validate_steps(jsonb) from public,anon,authenticated,service_role;

-- Versioned entry point lets clients require manual-list support before saving.
create or replace function public.zama_projects_list_v2(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(zama_private.project_json(p) order by p.updated_at desc,p.id),'[]'::jsonb)
  from public.zama_projects p where p.owner_id=p_owner and zama_private.project_access(p.owner_id,p.responsible_email,false)
$$;

create or replace function public.zama_project_save(p_owner uuid,p_project jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old public.zama_projects; v_saved public.zama_projects; v_data jsonb; v_id uuid;
  v_field text; v_steps jsonb; v_new boolean; v_cipher bytea;
  v_lists jsonb; v_list jsonb; v_legacy_id text; v_legacy_title text;
begin
  if auth.uid() is null or p_owner is null then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
  if p_project is null or jsonb_typeof(p_project)<>'object' or octet_length(p_project::text)>4194304 then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  v_id := coalesce(nullif(p_project->>'id','')::uuid,gen_random_uuid());
  select * into v_old from public.zama_projects where id=v_id and owner_id=p_owner for update;
  v_new := not found;
  if v_new then
    if p_owner<>auth.uid() then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
    if coalesce(p_project->>'revision','0')<>'0' then raise exception 'PROJECT_CONFLICT' using errcode='40001'; end if;
    v_data := jsonb_build_object('title','','client_name','','company_name','','client_email','','access_url','',
      'responsible_email','','responsible_name','','status','planning','due_date',null,'notes','','catalog_steps','[]'::jsonb,'onboarding_steps','[]'::jsonb,'production_lists','[]'::jsonb);
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
  -- Validate legacy fields even when a modern client also sends production_lists.
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    perform zama_private.project_validate_steps(v_data->v_field);
  end loop;
  v_lists := v_data->'production_lists';
  if not (p_project ? 'production_lists') then
    -- Old clients can update their two lists without replacing custom lists.
    foreach v_field in array array['catalog_steps','onboarding_steps'] loop
      if p_project ? v_field then
        v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
        v_legacy_title := case when v_field='catalog_steps' then 'Catálogo' else 'Estruturação' end;
        v_steps := v_data->v_field;
        if exists(select 1 from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id) then
          select coalesce(jsonb_agg(case when l->>'id'=v_legacy_id then jsonb_set(l,'{steps}',v_steps) else l end order by ord),'[]'::jsonb)
            into v_lists from jsonb_array_elements(v_lists) with ordinality as t(l,ord);
        elsif jsonb_array_length(v_steps)>0 then
          v_lists := v_lists || jsonb_build_array(jsonb_build_object('id',v_legacy_id,'title',v_legacy_title,'steps',v_steps));
        end if;
      end if;
    end loop;
  end if;
  if jsonb_typeof(v_lists) is distinct from 'array' then
    raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
  end if;
  if jsonb_array_length(v_lists)>20 then raise exception 'PROJECT_INVALID_LISTS' using errcode='22023'; end if;
  for v_list in select value from jsonb_array_elements(v_lists) loop
    if jsonb_typeof(v_list) is distinct from 'object'
      or jsonb_typeof(v_list->'id') is distinct from 'string' or length(v_list->>'id') not between 1 and 80
      or regexp_replace(v_list->>'id','[[:space:]]','','g')=''
      or jsonb_typeof(v_list->'title') is distinct from 'string' or length(v_list->>'title') not between 1 and 254
      or regexp_replace(v_list->>'title','[[:space:]]','','g')=''
      or v_list - array['id','title','steps'] <> '{}'::jsonb then
      raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
    end if;
    perform zama_private.project_validate_steps(v_list->'steps');
  end loop;
  if (select count(*)<>count(distinct l->>'id') from jsonb_array_elements(v_lists) l) then
    raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
  end if;
  v_data := jsonb_set(v_data,'{production_lists}',v_lists);
  -- Keep legacy fields in sync when their corresponding lists are edited/removed.
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
    select l->'steps' into v_steps from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id;
    v_data := jsonb_set(v_data,array[v_field],coalesce(v_steps,'[]'::jsonb));
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
    production_lists=v_data->'production_lists',
    password_cipher=v_cipher,revision=case when v_new then 1 else v_old.revision+1 end,updated_at=clock_timestamp()
  where id=v_id and owner_id=p_owner returning * into v_saved;
  return zama_private.project_json(v_saved);
end $$;

revoke all on function public.zama_project_save(uuid,jsonb),public.zama_projects_list_v2(uuid) from public,anon;
grant execute on function public.zama_project_save(uuid,jsonb),public.zama_projects_list_v2(uuid) to authenticated;
notify pgrst, 'reload schema';

-- Migration: 20261015_project_planning.sql
-- Additive; apply AFTER 20261013_project_lists.sql as the Supabase project owner.
-- Reapplying preserves project data, checklist progress, credentials and templates.

create or replace function zama_private.project_validate_steps(p_steps jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_step jsonb; v_date date;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' then raise exception 'PROJECT_INVALID_STEPS' using errcode='22023'; end if;
  if jsonb_array_length(p_steps)>100 then raise exception 'PROJECT_INVALID_STEPS' using errcode='22023'; end if;
  for v_step in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(v_step) is distinct from 'object'
      or jsonb_typeof(v_step->'id') is distinct from 'string' or length(v_step->>'id') not between 1 and 80
      or regexp_replace(v_step->>'id','[[:space:]]','','g')=''
      or jsonb_typeof(v_step->'label') is distinct from 'string' or length(v_step->>'label') not between 1 and 254
      or regexp_replace(v_step->>'label','[[:space:]]','','g')=''
      or jsonb_typeof(v_step->'done') is distinct from 'boolean'
      or v_step - array['id','label','done','due_date'] <> '{}'::jsonb then
      raise exception 'PROJECT_INVALID_STEPS' using errcode='22023';
    end if;
    if v_step ? 'due_date' and v_step->'due_date'<>'null'::jsonb then
      if jsonb_typeof(v_step->'due_date') is distinct from 'string'
        or v_step->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
      end if;
      begin
        v_date := (v_step->>'due_date')::date;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
      end;
    end if;
  end loop;
  if (select count(*)<>count(distinct s->>'id') from jsonb_array_elements(p_steps) s) then
    raise exception 'PROJECT_INVALID_STEPS' using errcode='22023';
  end if;
end $$;

create or replace function zama_private.project_validate_lists(p_lists jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_list jsonb;
begin
  if jsonb_typeof(p_lists) is distinct from 'array' then raise exception 'PROJECT_INVALID_LISTS' using errcode='22023'; end if;
  if jsonb_array_length(p_lists)>20 then raise exception 'PROJECT_INVALID_LISTS' using errcode='22023'; end if;
  for v_list in select value from jsonb_array_elements(p_lists) loop
    if jsonb_typeof(v_list) is distinct from 'object'
      or jsonb_typeof(v_list->'id') is distinct from 'string' or length(v_list->>'id') not between 1 and 80
      or regexp_replace(v_list->>'id','[[:space:]]','','g')=''
      or jsonb_typeof(v_list->'title') is distinct from 'string' or length(v_list->>'title') not between 1 and 254
      or regexp_replace(v_list->>'title','[[:space:]]','','g')=''
      or v_list - array['id','title','steps'] <> '{}'::jsonb then
      raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
    end if;
    perform zama_private.project_validate_steps(v_list->'steps');
  end loop;
  if (select count(*)<>count(distinct l->>'id') from jsonb_array_elements(p_lists) l) then
    raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
  end if;
end $$;

create or replace function zama_private.project_preserve_step_dates(p_lists jsonb,p_previous jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_list jsonb; v_step jsonb; v_old_list jsonb; v_old_step jsonb;
  v_result jsonb='[]'::jsonb; v_steps jsonb;
begin
  for v_list in select value from jsonb_array_elements(p_lists) loop
    select value into v_old_list from jsonb_array_elements(p_previous) where value->>'id'=v_list->>'id';
    v_steps := '[]'::jsonb;
    for v_step in select value from jsonb_array_elements(v_list->'steps') loop
      if not (v_step ? 'due_date') then
        select value into v_old_step from jsonb_array_elements(v_old_list->'steps') where value->>'id'=v_step->>'id';
        if v_old_step ? 'due_date' then
          v_step := v_step || jsonb_build_object('due_date',v_old_step->'due_date');
        end if;
      end if;
      v_steps := v_steps || jsonb_build_array(v_step);
    end loop;
    v_result := v_result || jsonb_build_array(jsonb_set(v_list,'{steps}',v_steps));
  end loop;
  return v_result;
end $$;
revoke all on function zama_private.project_validate_steps(jsonb),zama_private.project_validate_lists(jsonb),
  zama_private.project_preserve_step_dates(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Versioned entry point lets clients require step deadlines before saving them.
create or replace function public.zama_projects_list_v3(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(zama_private.project_json(p) order by p.updated_at desc,p.id),'[]'::jsonb)
  from public.zama_projects p where p.owner_id=p_owner and zama_private.project_access(p.owner_id,p.responsible_email,false)
$$;

create or replace function public.zama_project_save(p_owner uuid,p_project jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old public.zama_projects; v_saved public.zama_projects; v_data jsonb; v_id uuid;
  v_field text; v_steps jsonb; v_new boolean; v_cipher bytea;
  v_lists jsonb; v_list jsonb; v_legacy_id text; v_legacy_title text;
begin
  if auth.uid() is null or p_owner is null then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
  if p_project is null or jsonb_typeof(p_project)<>'object' or octet_length(p_project::text)>4194304 then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  v_id := coalesce(nullif(p_project->>'id','')::uuid,gen_random_uuid());
  select * into v_old from public.zama_projects where id=v_id and owner_id=p_owner for update;
  v_new := not found;
  if v_new then
    if p_owner<>auth.uid() then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
    if coalesce(p_project->>'revision','0')<>'0' then raise exception 'PROJECT_CONFLICT' using errcode='40001'; end if;
    v_data := jsonb_build_object('title','','client_name','','company_name','','client_email','','access_url','',
      'responsible_email','','responsible_name','','status','planning','due_date',null,'notes','','catalog_steps','[]'::jsonb,'onboarding_steps','[]'::jsonb,'production_lists','[]'::jsonb);
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
  -- Validate legacy fields even when a modern client also sends production_lists.
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    perform zama_private.project_validate_steps(v_data->v_field);
  end loop;
  v_lists := v_data->'production_lists';
  if not (p_project ? 'production_lists') then
    -- Old clients can update their two lists without replacing custom lists.
    foreach v_field in array array['catalog_steps','onboarding_steps'] loop
      if p_project ? v_field then
        v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
        v_legacy_title := case when v_field='catalog_steps' then 'Catálogo' else 'Estruturação' end;
        v_steps := v_data->v_field;
        if exists(select 1 from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id) then
          select coalesce(jsonb_agg(case when l->>'id'=v_legacy_id then jsonb_set(l,'{steps}',v_steps) else l end order by ord),'[]'::jsonb)
            into v_lists from jsonb_array_elements(v_lists) with ordinality as t(l,ord);
        elsif jsonb_array_length(v_steps)>0 then
          v_lists := v_lists || jsonb_build_array(jsonb_build_object('id',v_legacy_id,'title',v_legacy_title,'steps',v_steps));
        end if;
      end if;
    end loop;
  end if;
  perform zama_private.project_validate_lists(v_lists);
  -- Old clients omit due_date; preserve it only for the same list and step IDs.
  -- An explicit JSON null is a deliberate removal and must not be replaced.
  v_lists := zama_private.project_preserve_step_dates(v_lists,coalesce(v_old.production_lists,'[]'::jsonb));
  v_data := jsonb_set(v_data,'{production_lists}',v_lists);
  -- Keep legacy fields in sync when their corresponding lists are edited/removed.
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
    select l->'steps' into v_steps from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id;
    v_data := jsonb_set(v_data,array[v_field],coalesce(v_steps,'[]'::jsonb));
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
    production_lists=v_data->'production_lists',
    password_cipher=v_cipher,revision=case when v_new then 1 else v_old.revision+1 end,updated_at=clock_timestamp()
  where id=v_id and owner_id=p_owner returning * into v_saved;
  return zama_private.project_json(v_saved);
end $$;


-- Templates contain only reusable production structure, never client details.
create table if not exists public.zama_project_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check(length(title) between 1 and 254),
  production_lists jsonb not null check(jsonb_typeof(production_lists)='array'),
  revision integer not null default 1 check(revision>0),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists zama_project_templates_owner on public.zama_project_templates(owner_id,updated_at desc);
alter table public.zama_project_templates enable row level security;
alter table public.zama_project_templates force row level security;
revoke all on public.zama_project_templates from public,anon,authenticated,service_role;

create or replace function zama_private.project_template_owner()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid=auth.uid();
begin
  if v_owner is null or not exists(select 1 from auth.users where id=v_owner and email_confirmed_at is not null) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  return v_owner;
end $$;
revoke all on function zama_private.project_template_owner() from public,anon,authenticated,service_role;

create or replace function public.zama_project_templates_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; v_result jsonb;
begin
  v_owner := zama_private.project_template_owner();
  select coalesce(jsonb_agg(to_jsonb(t)-'owner_id' order by t.updated_at desc,t.id),'[]'::jsonb)
    into v_result from public.zama_project_templates t where t.owner_id=v_owner;
  return v_result;
end $$;

create or replace function public.zama_project_template_save(p_template jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id uuid; v_old public.zama_project_templates; v_saved public.zama_project_templates;
  v_title text; v_list jsonb; v_step jsonb; v_steps jsonb; v_lists jsonb='[]'::jsonb; v_new boolean;
begin
  v_owner := zama_private.project_template_owner();
  if p_template is null or jsonb_typeof(p_template) is distinct from 'object'
    or octet_length(p_template::text)>4194304
    or p_template - array['id','title','production_lists','revision'] <> '{}'::jsonb
    or jsonb_typeof(p_template->'title') is distinct from 'string'
    or length(p_template->>'title') not between 1 and 254 then
    raise exception 'PROJECT_INVALID_TEMPLATE' using errcode='22023';
  end if;
  v_title := regexp_replace(p_template->>'title','^[[:space:]]+|[[:space:]]+$','','g');
  if v_title='' then raise exception 'PROJECT_INVALID_TEMPLATE' using errcode='22023'; end if;
  perform zama_private.project_validate_lists(p_template->'production_lists');
  for v_list in select value from jsonb_array_elements(p_template->'production_lists') loop
    v_steps := '[]'::jsonb;
    for v_step in select value from jsonb_array_elements(v_list->'steps') loop
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('id',v_step->>'id','label',v_step->>'label','done',false));
    end loop;
    v_lists := v_lists || jsonb_build_array(jsonb_build_object('id',v_list->>'id','title',v_list->>'title','steps',v_steps));
  end loop;
  -- Serialize mutations per owner so concurrent creates cannot exceed 50 models.
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text,743));
  if p_template ? 'id' then
    if jsonb_typeof(p_template->'id') is distinct from 'string'
      or p_template->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'PROJECT_INVALID_TEMPLATE' using errcode='22023';
    end if;
    v_id := (p_template->>'id')::uuid;
    select * into v_old from public.zama_project_templates where id=v_id and owner_id=v_owner for update;
    if not found then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
    if jsonb_typeof(p_template->'revision') is distinct from 'number'
      or p_template->>'revision' is distinct from v_old.revision::text then
      raise exception 'PROJECT_CONFLICT' using errcode='40001';
    end if;
    update public.zama_project_templates set title=v_title,production_lists=v_lists,
      revision=v_old.revision+1,updated_at=clock_timestamp() where id=v_id and owner_id=v_owner returning * into v_saved;
  else
    if p_template ? 'revision' and (jsonb_typeof(p_template->'revision') is distinct from 'number' or p_template->>'revision'<>'0') then
      raise exception 'PROJECT_CONFLICT' using errcode='40001';
    end if;
    if (select count(*) from public.zama_project_templates where owner_id=v_owner)>=50 then
      raise exception 'PROJECT_TEMPLATE_LIMIT' using errcode='22023';
    end if;
    insert into public.zama_project_templates(owner_id,title,production_lists) values(v_owner,v_title,v_lists) returning * into v_saved;
  end if;
  return to_jsonb(v_saved)-'owner_id';
end $$;

create or replace function public.zama_project_template_delete(p_id uuid,p_revision integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_old public.zama_project_templates;
begin
  v_owner := zama_private.project_template_owner();
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text,743));
  select * into v_old from public.zama_project_templates where id=p_id and owner_id=v_owner for update;
  if not found then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
  if p_revision is distinct from v_old.revision then raise exception 'PROJECT_CONFLICT' using errcode='40001'; end if;
  delete from public.zama_project_templates where id=p_id and owner_id=v_owner;
end $$;

revoke all on function public.zama_project_save(uuid,jsonb),public.zama_projects_list_v3(uuid),
  public.zama_project_templates_list(),public.zama_project_template_save(jsonb),public.zama_project_template_delete(uuid,integer) from public,anon,service_role;
grant execute on function public.zama_project_save(uuid,jsonb),public.zama_projects_list_v3(uuid),
  public.zama_project_templates_list(),public.zama_project_template_save(jsonb),public.zama_project_template_delete(uuid,integer) to authenticated;
notify pgrst, 'reload schema';

-- Migration: 20261015_team_space.sql
-- Shared production and ideas; every agenda stays in its own user's app_state.
-- Apply after 20261015_project_planning.sql. No business rows are deleted.

create or replace function public.zama_workspace_access(p_owner uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_owner=auth.uid()
$$;

create or replace function zama_private.team_access(p_owner uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (p_owner=auth.uid() or exists(
    select 1 from public.zama_workspace_members m join auth.users u on u.id=m.user_id
    where m.owner_id=p_owner and m.user_id=auth.uid() and u.email_confirmed_at is not null
      and (not p_write or m.role in ('projects','editor'))))
$$;
revoke all on function zama_private.team_access(uuid,boolean) from public,anon,authenticated,service_role;

-- Responsibility organizes work; membership controls project visibility.
create or replace function zama_private.project_access(p_owner uuid,p_email text,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select zama_private.team_access(p_owner,p_write)
$$;

-- Sharing projects must not broaden access to stored client passwords.
create or replace function public.zama_project_secret(p_owner uuid,p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_project public.zama_projects;
begin
  select * into v_project from public.zama_projects where id=p_id and owner_id=p_owner;
  if not found or not zama_private.team_access(p_owner,true) or
    (p_owner<>auth.uid() and not exists(select 1 from auth.users u where u.id=auth.uid()
      and lower(btrim(u.email))=v_project.responsible_email and u.email_confirmed_at is not null)) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  return case when v_project.password_cipher is null then '' else zama_private.project_decrypt(v_project.password_cipher) end;
end $$;

create or replace function public.zama_team_capabilities(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not zama_private.team_access(p_owner,false) then raise exception 'TEAM_ACCESS_DENIED' using errcode='42501'; end if;
  return jsonb_build_object('shared_projects',true,'shared_ideas',true,'private_agenda',true);
end $$;

create or replace function zama_private.team_ideas(p_data jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',coalesce(nullif(i->>'id',''),'legacy-idea-'||n::text),
    'titulo',coalesce(i->>'titulo',i->>'nome',i->>'title','Ideia sem título'),
    'descricao',coalesce(i->>'descricao',i->>'description',i->>'observacoes',''),
    'categoria',coalesce(i->>'categoria',i->>'category','Geral'),
    'prioridade',coalesce(i->'prioridade',i->'priority','"Média"'::jsonb),
    'data',coalesce(i->>'data',i->>'date',left(i->>'createdAt',10),to_char(current_date,'YYYY-MM-DD')),
    'etapa',coalesce(i->>'etapa',i->>'stage','capturada'),
    'arquivada',coalesce(i->'arquivada',i->'archived','false'::jsonb),
    'createdAt',i->>'createdAt','updatedAt',i->>'updatedAt') order by n),'[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_data)='array' then p_data else '[]'::jsonb end) with ordinality t(i,n)
$$;
revoke all on function zama_private.team_ideas(jsonb) from public,anon,authenticated,service_role;

create or replace function public.zama_team_ideas_get(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_state public.app_state;
begin
  if not zama_private.team_access(p_owner,false) then raise exception 'TEAM_ACCESS_DENIED' using errcode='42501'; end if;
  select * into v_state from public.app_state where user_id=p_owner;
  if not found then raise exception 'TEAM_UNAVAILABLE' using errcode='22023'; end if;
  return jsonb_build_object('ideas',zama_private.team_ideas(v_state.data->'ideias'),'revision',v_state.updated_at);
end $$;

create or replace function public.zama_team_ideas_save(p_owner uuid,p_revision timestamptz,p_ideas jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_state public.app_state; v_idea jsonb; v_date date; v_ideas jsonb;
begin
  if not zama_private.team_access(p_owner,true) then raise exception 'TEAM_ACCESS_DENIED' using errcode='42501'; end if;
  if jsonb_typeof(p_ideas) is distinct from 'array' or octet_length(p_ideas::text)>4194304 then
    raise exception 'TEAM_INVALID_IDEAS' using errcode='22023';
  end if;
  if jsonb_array_length(p_ideas)>2000 then raise exception 'TEAM_INVALID_IDEAS' using errcode='22023'; end if;
  for v_idea in select value from jsonb_array_elements(p_ideas) loop
    if jsonb_typeof(v_idea) is distinct from 'object'
      or v_idea-array['id','titulo','descricao','categoria','prioridade','data','etapa','arquivada','createdAt','updatedAt']<>'{}'::jsonb
      or jsonb_typeof(v_idea->'id') is distinct from 'string' or length(v_idea->>'id') not between 1 and 100
      or jsonb_typeof(v_idea->'titulo') is distinct from 'string' or length(btrim(v_idea->>'titulo')) not between 1 and 254
      or jsonb_typeof(v_idea->'descricao') is distinct from 'string' or length(v_idea->>'descricao')>20000
      or jsonb_typeof(v_idea->'categoria') is distinct from 'string' or length(v_idea->>'categoria')>254
      or coalesce(v_idea->>'prioridade','') not in ('Baixa','Média','Alta')
      or coalesce(v_idea->>'etapa','') not in ('capturada','avaliacao','execucao','concluida')
      or jsonb_typeof(v_idea->'arquivada') is distinct from 'boolean'
      or coalesce(v_idea->>'data','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'TEAM_INVALID_IDEAS' using errcode='22023';
    end if;
    begin v_date := (v_idea->>'data')::date;
    exception when datetime_field_overflow or invalid_datetime_format then raise exception 'TEAM_INVALID_IDEAS' using errcode='22023'; end;
  end loop;
  if (select count(*)<>count(distinct i->>'id') from jsonb_array_elements(p_ideas) i) then raise exception 'TEAM_INVALID_IDEAS' using errcode='22023'; end if;
  select * into v_state from public.app_state where user_id=p_owner for update;
  if not found then raise exception 'TEAM_UNAVAILABLE' using errcode='22023'; end if;
  if p_revision is distinct from v_state.updated_at then raise exception 'TEAM_CONFLICT' using errcode='40001'; end if;
  -- Preserve the owner's private task links and legacy metadata by idea ID.
  -- These fields cannot be supplied by a member and never leave the shared RPC.
  select coalesce(jsonb_agg(coalesce((
    select old.i-array['id','titulo','descricao','categoria','prioridade','data','etapa','arquivada','createdAt','updatedAt']
    from jsonb_array_elements(case when jsonb_typeof(v_state.data->'ideias')='array' then v_state.data->'ideias' else '[]'::jsonb end)
      with ordinality old(i,n)
    where coalesce(nullif(old.i->>'id',''),'legacy-idea-'||old.n::text)=incoming.i->>'id'
    limit 1),'{}'::jsonb)||incoming.i order by incoming.n),'[]'::jsonb)
  into v_ideas from jsonb_array_elements(p_ideas) with ordinality incoming(i,n);
  update public.app_state set data=jsonb_set(v_state.data,'{ideias}',v_ideas),updated_at=clock_timestamp() where user_id=p_owner;
  return public.zama_team_ideas_get(p_owner);
end $$;

revoke all on function public.zama_team_capabilities(uuid),public.zama_team_ideas_get(uuid),public.zama_team_ideas_save(uuid,timestamptz,jsonb) from public,anon,service_role;
grant execute on function public.zama_team_capabilities(uuid),public.zama_team_ideas_get(uuid),public.zama_team_ideas_save(uuid,timestamptz,jsonb) to authenticated;
notify pgrst, 'reload schema';

-- Migration: 20261015_project_collaboration.sql
-- Collaborative projects for every confirmed company member, including viewers.
-- Apply after 20261015_team_space.sql. Agendas, ideas and secrets keep their ACLs.

create or replace function zama_private.project_access(p_owner uuid,p_email text,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select zama_private.team_access(p_owner,false)
$$;
revoke all on function zama_private.project_access(uuid,text,boolean) from public,anon,authenticated,service_role;

create or replace function public.zama_project_collaboration_capabilities(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not zama_private.project_access(p_owner,'',true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  return jsonb_build_object('can_edit',true,'shared_creation',true);
end $$;

create or replace function public.zama_project_save(p_owner uuid,p_project jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old public.zama_projects; v_saved public.zama_projects; v_data jsonb; v_id uuid;
  v_field text; v_steps jsonb; v_new boolean; v_cipher bytea;
  v_lists jsonb; v_legacy_id text; v_legacy_title text;
begin
  if p_owner is null or not zama_private.project_access(p_owner,'',true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_project is null or jsonb_typeof(p_project)<>'object' or octet_length(p_project::text)>4194304 then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  -- Even an empty password is a credential change; only the owner can send it.
  if p_owner<>auth.uid() and p_project ? 'password' then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  v_id := coalesce(nullif(p_project->>'id','')::uuid,gen_random_uuid());
  select * into v_old from public.zama_projects where id=v_id and owner_id=p_owner for update;
  v_new := not found;
  if v_new then
    if coalesce(p_project->>'revision','0')<>'0' then raise exception 'PROJECT_CONFLICT' using errcode='40001'; end if;
    v_data := jsonb_build_object('title','','client_name','','company_name','','client_email','','access_url','',
      'responsible_email','','responsible_name','','status','planning','due_date',null,'notes','','catalog_steps','[]'::jsonb,'onboarding_steps','[]'::jsonb,'production_lists','[]'::jsonb);
  else
    if p_project->>'revision' is distinct from v_old.revision::text then
      raise exception 'PROJECT_CONFLICT' using errcode='40001';
    end if;
    v_data := zama_private.project_json(v_old);
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
  -- Changing an assignment on a protected project could grant the editor its
  -- secret. Keep this one field owner-only while a stored password exists.
  if not v_new and p_owner<>auth.uid() and v_old.password_cipher is not null
    and v_data->>'responsible_email' is distinct from v_old.responsible_email then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  if v_data->>'access_url'<>'' and v_data->>'access_url' !~* '^https?://[^[:space:]]+$' then
    raise exception 'PROJECT_INVALID_URL' using errcode='22023';
  end if;
  if v_data->>'due_date' is not null and v_data->>'due_date'<>'' and v_data->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
  end if;
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    perform zama_private.project_validate_steps(v_data->v_field);
  end loop;
  v_lists := v_data->'production_lists';
  if not (p_project ? 'production_lists') then
    -- Legacy clients can edit their lists without replacing custom lists.
    foreach v_field in array array['catalog_steps','onboarding_steps'] loop
      if p_project ? v_field then
        v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
        v_legacy_title := case when v_field='catalog_steps' then 'Catálogo' else 'Estruturação' end;
        v_steps := v_data->v_field;
        if exists(select 1 from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id) then
          select coalesce(jsonb_agg(case when l->>'id'=v_legacy_id then jsonb_set(l,'{steps}',v_steps) else l end order by ord),'[]'::jsonb)
            into v_lists from jsonb_array_elements(v_lists) with ordinality as t(l,ord);
        elsif jsonb_array_length(v_steps)>0 then
          v_lists := v_lists || jsonb_build_array(jsonb_build_object('id',v_legacy_id,'title',v_legacy_title,'steps',v_steps));
        end if;
      end if;
    end loop;
  end if;
  perform zama_private.project_validate_lists(v_lists);
  -- Preserve omitted dates from old clients; explicit JSON null clears a date.
  v_lists := zama_private.project_preserve_step_dates(v_lists,coalesce(v_old.production_lists,'[]'::jsonb));
  v_data := jsonb_set(v_data,'{production_lists}',v_lists);
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
    select l->'steps' into v_steps from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id;
    v_data := jsonb_set(v_data,array[v_field],coalesce(v_steps,'[]'::jsonb));
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
    production_lists=v_data->'production_lists',
    password_cipher=v_cipher,revision=case when v_new then 1 else v_old.revision+1 end,updated_at=clock_timestamp()
  where id=v_id and owner_id=p_owner returning * into v_saved;
  return zama_private.project_json(v_saved);
end $$;

-- Save just one checkbox under the same lock/revision contract as the editor.
-- A stale click never overwrites another member's checklist or metadata changes.
create or replace function public.zama_project_step_set(
  p_owner uuid,p_id uuid,p_list_id text,p_step_id text,p_done boolean,p_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_project public.zama_projects; v_list_index integer; v_step_index integer; v_lists jsonb;
begin
  if not zama_private.project_access(p_owner,'',true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_done is null or p_list_id is null or p_step_id is null
    or length(p_list_id) not between 1 and 80 or length(p_step_id) not between 1 and 80 then
    raise exception 'PROJECT_INVALID_STEPS' using errcode='22023';
  end if;
  select * into v_project from public.zama_projects where owner_id=p_owner and id=p_id for update;
  if not found then raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501'; end if;
  if p_revision is distinct from v_project.revision then
    raise exception 'PROJECT_CONFLICT' using errcode='40001';
  end if;
  select n-1 into v_list_index from jsonb_array_elements(v_project.production_lists) with ordinality t(l,n)
    where l->>'id'=p_list_id;
  if v_list_index is null then raise exception 'PROJECT_STEP_NOT_FOUND' using errcode='22023'; end if;
  select n-1 into v_step_index from jsonb_array_elements(v_project.production_lists->v_list_index->'steps') with ordinality t(s,n)
    where s->>'id'=p_step_id;
  if v_step_index is null then raise exception 'PROJECT_STEP_NOT_FOUND' using errcode='22023'; end if;
  v_lists := jsonb_set(v_project.production_lists,array[v_list_index::text,'steps',v_step_index::text,'done'],to_jsonb(p_done),false);
  return public.zama_project_save(p_owner,jsonb_build_object('id',p_id,'revision',p_revision,'production_lists',v_lists));
end $$;

revoke all on function public.zama_project_save(uuid,jsonb),
  public.zama_project_collaboration_capabilities(uuid),public.zama_project_step_set(uuid,uuid,text,text,boolean,integer)
  from public,anon,service_role;
grant execute on function public.zama_project_save(uuid,jsonb),
  public.zama_project_collaboration_capabilities(uuid),public.zama_project_step_set(uuid,uuid,text,text,boolean,integer)
  to authenticated;
notify pgrst, 'reload schema';

-- Migration: 20261016_project_phone.sql
-- Optional client WhatsApp number, stored as canonical international digits.
-- Apply after 20261015_project_collaboration.sql. Existing data and ACLs stay intact.

alter table public.zama_projects add column if not exists client_phone text not null default '';
alter table public.zama_projects drop constraint if exists zama_projects_client_phone_check;
alter table public.zama_projects add constraint zama_projects_client_phone_check
  check(client_phone='' or client_phone ~ '^[1-9][0-9]{7,14}$');

-- project_json already exposes nonsecret row metadata through to_jsonb(p), so
-- list v1/v2/v3 and save automatically return client_phone without credentials.
create or replace function public.zama_project_phone_capabilities(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_owner is null or not zama_private.project_access(p_owner,'',true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  return jsonb_build_object('client_phone',true);
end $$;

-- Preserve the collaboration contract, validating the phone before any write.
-- Omitted client_phone keeps the stored value; an explicit empty string clears it.
create or replace function public.zama_project_save(p_owner uuid,p_project jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old public.zama_projects; v_saved public.zama_projects; v_data jsonb; v_id uuid;
  v_field text; v_steps jsonb; v_new boolean; v_cipher bytea;
  v_lists jsonb; v_legacy_id text; v_legacy_title text;
begin
  if p_owner is null or not zama_private.project_access(p_owner,'',true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_project is null or jsonb_typeof(p_project)<>'object' or octet_length(p_project::text)>4194304 then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  -- Even an empty password is a credential change; only the owner can send it.
  if p_owner<>auth.uid() and p_project ? 'password' then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  v_id := coalesce(nullif(p_project->>'id','')::uuid,gen_random_uuid());
  select * into v_old from public.zama_projects where id=v_id and owner_id=p_owner for update;
  v_new := not found;
  if v_new then
    if coalesce(p_project->>'revision','0')<>'0' then raise exception 'PROJECT_CONFLICT' using errcode='40001'; end if;
    v_data := jsonb_build_object('title','','client_name','','client_phone','','company_name','','client_email','','access_url','',
      'responsible_email','','responsible_name','','status','planning','due_date',null,'notes','','catalog_steps','[]'::jsonb,'onboarding_steps','[]'::jsonb,'production_lists','[]'::jsonb);
  else
    if p_project->>'revision' is distinct from v_old.revision::text then
      raise exception 'PROJECT_CONFLICT' using errcode='40001';
    end if;
    v_data := zama_private.project_json(v_old);
  end if;
  v_data := v_data || p_project;
  foreach v_field in array array['title','client_name','client_phone','company_name','client_email','access_url','responsible_email','responsible_name','status','notes'] loop
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
  if v_data->>'client_phone'<>'' and v_data->>'client_phone' !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'PROJECT_INVALID_PHONE' using errcode='22023';
  end if;
  if v_data->>'status' not in ('planning','in_progress','waiting','completed') then
    raise exception 'PROJECT_INVALID_DATA' using errcode='22023';
  end if;
  foreach v_field in array array['responsible_email','client_email'] loop
    v_data := jsonb_set(v_data,array[v_field],to_jsonb(lower(btrim(v_data->>v_field))));
    if v_data->>v_field<>'' and v_data->>v_field !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'PROJECT_INVALID_EMAIL' using errcode='22023';
    end if;
  end loop;
  -- Changing an assignment on a protected project could grant the editor its
  -- secret. Keep this one field owner-only while a stored password exists.
  if not v_new and p_owner<>auth.uid() and v_old.password_cipher is not null
    and v_data->>'responsible_email' is distinct from v_old.responsible_email then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  if v_data->>'access_url'<>'' and v_data->>'access_url' !~* '^https?://[^[:space:]]+$' then
    raise exception 'PROJECT_INVALID_URL' using errcode='22023';
  end if;
  if v_data->>'due_date' is not null and v_data->>'due_date'<>'' and v_data->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
  end if;
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    perform zama_private.project_validate_steps(v_data->v_field);
  end loop;
  v_lists := v_data->'production_lists';
  if not (p_project ? 'production_lists') then
    -- Legacy clients can edit their lists without replacing custom lists.
    foreach v_field in array array['catalog_steps','onboarding_steps'] loop
      if p_project ? v_field then
        v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
        v_legacy_title := case when v_field='catalog_steps' then 'Catálogo' else 'Estruturação' end;
        v_steps := v_data->v_field;
        if exists(select 1 from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id) then
          select coalesce(jsonb_agg(case when l->>'id'=v_legacy_id then jsonb_set(l,'{steps}',v_steps) else l end order by ord),'[]'::jsonb)
            into v_lists from jsonb_array_elements(v_lists) with ordinality as t(l,ord);
        elsif jsonb_array_length(v_steps)>0 then
          v_lists := v_lists || jsonb_build_array(jsonb_build_object('id',v_legacy_id,'title',v_legacy_title,'steps',v_steps));
        end if;
      end if;
    end loop;
  end if;
  perform zama_private.project_validate_lists(v_lists);
  -- Preserve omitted dates from old clients; explicit JSON null clears a date.
  v_lists := zama_private.project_preserve_step_dates(v_lists,coalesce(v_old.production_lists,'[]'::jsonb));
  v_data := jsonb_set(v_data,'{production_lists}',v_lists);
  foreach v_field in array array['catalog_steps','onboarding_steps'] loop
    v_legacy_id := case when v_field='catalog_steps' then 'catalog' else 'onboarding' end;
    select l->'steps' into v_steps from jsonb_array_elements(v_lists) l where l->>'id'=v_legacy_id;
    v_data := jsonb_set(v_data,array[v_field],coalesce(v_steps,'[]'::jsonb));
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
    client_phone=v_data->>'client_phone',client_email=v_data->>'client_email',access_url=v_data->>'access_url',responsible_email=v_data->>'responsible_email',
    responsible_name=v_data->>'responsible_name',status=v_data->>'status',due_date=nullif(v_data->>'due_date','')::date,
    notes=v_data->>'notes',catalog_steps=v_data->'catalog_steps',onboarding_steps=v_data->'onboarding_steps',
    production_lists=v_data->'production_lists',
    password_cipher=v_cipher,revision=case when v_new then 1 else v_old.revision+1 end,updated_at=clock_timestamp()
  where id=v_id and owner_id=p_owner returning * into v_saved;
  return zama_private.project_json(v_saved);
end $$;

revoke all on function public.zama_project_save(uuid,jsonb),public.zama_project_phone_capabilities(uuid)
  from public,anon,service_role;
grant execute on function public.zama_project_save(uuid,jsonb),public.zama_project_phone_capabilities(uuid)
  to authenticated;
notify pgrst, 'reload schema';

-- Migration: 20261019_project_processes.sql
-- Internal process records enrich each production list without changing project access.
-- Apply after 20261016_project_phone.sql. Existing lists and steps stay valid.

create or replace function zama_private.project_validate_lists(p_lists jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_list jsonb; v_link jsonb; v_field text; v_date date;
begin
  if jsonb_typeof(p_lists) is distinct from 'array' then raise exception 'PROJECT_INVALID_LISTS' using errcode='22023'; end if;
  if jsonb_array_length(p_lists)>20 then raise exception 'PROJECT_INVALID_LISTS' using errcode='22023'; end if;
  for v_list in select value from jsonb_array_elements(p_lists) loop
    if jsonb_typeof(v_list) is distinct from 'object'
      or jsonb_typeof(v_list->'id') is distinct from 'string' or length(v_list->>'id') not between 1 and 80
      or regexp_replace(v_list->>'id','[[:space:]]','','g')=''
      or jsonb_typeof(v_list->'title') is distinct from 'string' or length(v_list->>'title') not between 1 and 254
      or regexp_replace(v_list->>'title','[[:space:]]','','g')=''
      or v_list - array['id','title','steps','description','responsible_name','due_date','status','links'] <> '{}'::jsonb then
      raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
    end if;
    foreach v_field in array array['description','responsible_name'] loop
      if v_list ? v_field and (jsonb_typeof(v_list->v_field) is distinct from 'string'
        or length(v_list->>v_field)>(case when v_field='description' then 10000 else 254 end)) then
        raise exception 'PROJECT_INVALID_PROCESS' using errcode='22023';
      end if;
    end loop;
    if v_list ? 'status' and (jsonb_typeof(v_list->'status') is distinct from 'string'
      or v_list->>'status' not in ('planning','in_progress','waiting','completed')) then
      raise exception 'PROJECT_INVALID_PROCESS' using errcode='22023';
    end if;
    if v_list ? 'due_date' and v_list->'due_date'<>'null'::jsonb then
      if jsonb_typeof(v_list->'due_date') is distinct from 'string'
        or v_list->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
      end if;
      begin
        v_date := (v_list->>'due_date')::date;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'PROJECT_INVALID_DATE' using errcode='22023';
      end;
    end if;
    if v_list ? 'links' then
      if jsonb_typeof(v_list->'links') is distinct from 'array' then
        raise exception 'PROJECT_INVALID_PROCESS_LINKS' using errcode='22023';
      end if;
      if jsonb_array_length(v_list->'links')>20 then
        raise exception 'PROJECT_INVALID_PROCESS_LINKS' using errcode='22023';
      end if;
      for v_link in select value from jsonb_array_elements(v_list->'links') loop
        if jsonb_typeof(v_link) is distinct from 'object'
          or v_link - array['label','url'] <> '{}'::jsonb
          or jsonb_typeof(v_link->'label') is distinct from 'string' or length(v_link->>'label')>254
          or jsonb_typeof(v_link->'url') is distinct from 'string' or length(v_link->>'url')>2048
          or v_link->>'url' !~* '^https?://[^[:space:]]+$' then
          raise exception 'PROJECT_INVALID_PROCESS_LINKS' using errcode='22023';
        end if;
      end loop;
    end if;
    perform zama_private.project_validate_steps(v_list->'steps');
  end loop;
  if (select count(*)<>count(distinct l->>'id') from jsonb_array_elements(p_lists) l) then
    raise exception 'PROJECT_INVALID_LISTS' using errcode='22023';
  end if;
end $$;

-- Older clients omit process metadata. Preserve it only for the same list ID,
-- along with omitted step dates. Explicit empty strings, null dates and [] clear
-- their respective fields. Deleted lists/steps never reappear through this merge.
-- Keep this helper's name because all supported project_save versions call it.
create or replace function zama_private.project_preserve_step_dates(p_lists jsonb,p_previous jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_list jsonb; v_step jsonb; v_old_list jsonb; v_old_step jsonb; v_field text;
  v_result jsonb='[]'::jsonb; v_steps jsonb;
begin
  for v_list in select value from jsonb_array_elements(p_lists) loop
    select value into v_old_list from jsonb_array_elements(p_previous) where value->>'id'=v_list->>'id';
    foreach v_field in array array['description','responsible_name','due_date','status','links'] loop
      if not (v_list ? v_field) and v_old_list ? v_field then
        v_list := v_list || jsonb_build_object(v_field,v_old_list->v_field);
      end if;
    end loop;
    v_steps := '[]'::jsonb;
    for v_step in select value from jsonb_array_elements(v_list->'steps') loop
      if not (v_step ? 'due_date') then
        select value into v_old_step from jsonb_array_elements(v_old_list->'steps') where value->>'id'=v_step->>'id';
        if v_old_step ? 'due_date' then
          v_step := v_step || jsonb_build_object('due_date',v_old_step->'due_date');
        end if;
      end if;
      v_steps := v_steps || jsonb_build_array(v_step);
    end loop;
    v_result := v_result || jsonb_build_array(jsonb_set(v_list,'{steps}',v_steps));
  end loop;
  return v_result;
end $$;
revoke all on function zama_private.project_validate_lists(jsonb),zama_private.project_preserve_step_dates(jsonb,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.zama_project_process_capabilities(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if p_owner is null or not zama_private.project_access(p_owner,'',true) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode='42501';
  end if;
  return jsonb_build_object('process_details',true);
end $$;
revoke all on function public.zama_project_process_capabilities(uuid) from public,anon,service_role;
grant execute on function public.zama_project_process_capabilities(uuid) to authenticated;

-- project_template_save already rebuilds only list id/title and step id/label,
-- resetting done. Process instructions, assignments, dates and links stay private
-- to their project and are never included in reusable templates.
notify pgrst, 'reload schema';

commit;
