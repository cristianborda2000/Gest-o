-- Execute este arquivo no Supabase em SQL Editor.
-- Ele cria uma tabela unica para salvar o estado completo do sistema ZAMA.

create table if not exists public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.app_state to authenticated;

drop policy if exists "Ler meus dados" on public.app_state;
drop policy if exists "Criar meus dados" on public.app_state;
drop policy if exists "Atualizar meus dados" on public.app_state;
drop policy if exists "Excluir meus dados" on public.app_state;

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
