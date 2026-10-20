-- Internal process records enrich each production list without changing project access.
-- Apply after 20261016_project_phone.sql. Existing lists and steps stay valid.
begin;

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
