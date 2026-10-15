begin;

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

commit;
