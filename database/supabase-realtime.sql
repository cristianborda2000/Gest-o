-- Execute este arquivo no Supabase em SQL Editor se a sincronizacao em tempo real
-- entre computador, celular e outros navegadores nao estiver atualizando sozinha.
-- Este script nao apaga dados.

alter table public.app_state enable row level security;
alter table public.app_state force row level security;

grant usage on schema public to anon, authenticated;
revoke all on public.app_state from anon;
grant select, insert, update, delete on public.app_state to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.app_state;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
