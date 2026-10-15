-- Shared production and ideas; every agenda stays in its own user's app_state.
-- Apply after 20261015_project_planning.sql. No business rows are deleted.
begin;

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
commit;
