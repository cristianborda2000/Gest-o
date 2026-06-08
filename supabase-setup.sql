-- Execute este arquivo no Supabase em SQL Editor.
-- ATENCAO: este script apaga a tabela app_state existente e recria do zero.
-- Use quando os dados na nuvem nao estiverem salvando corretamente.

drop table if exists public.app_state;

create table public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.app_state to authenticated;

-- Libera a tabela para sincronizacao em tempo real entre navegadores e celular.
do $$
begin
  alter publication supabase_realtime add table public.app_state;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

create policy "Ler meus dados"
on public.app_state
for select
to authenticated
using (auth.uid() = user_id);

create policy "Criar meus dados"
on public.app_state
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Atualizar meus dados"
on public.app_state
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Excluir meus dados"
on public.app_state
for delete
to authenticated
using (auth.uid() = user_id);
