-- Execute este arquivo no Supabase em SQL Editor se a sincronizacao em tempo real
-- entre computador, celular e outros navegadores nao estiver atualizando sozinha.
-- Este script nao apaga dados.

do $$
begin
  alter publication supabase_realtime add table public.app_state;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
