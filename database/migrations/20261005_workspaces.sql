-- Additive sharing for the existing app_state row. Apply as project owner.
begin;
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
commit;
