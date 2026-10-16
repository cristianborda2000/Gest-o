-- Optional client WhatsApp number, stored as canonical international digits.
-- Apply after 20261015_project_collaboration.sql. Existing data and ACLs stay intact.
begin;

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
commit;
