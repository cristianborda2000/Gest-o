import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrations = [
  '20261005_workspaces.sql',
  '20261012_projects.sql',
  '20261013_project_lists.sql',
  '20261015_project_planning.sql',
  '20261015_team_space.sql',
  '20261015_project_collaboration.sql',
  '20261016_project_phone.sql',
  '20261019_project_processes.sql'
];
const outputPath = resolve(root, 'database/instalar-projetos.sql');

// These checked-in migrations each own a single outer transaction. Remove only
// those wrappers so a failure cannot leave an earlier migration committed.
function transactionBody(source, name) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const starts = normalized.match(/^begin;[ \t]*$/gmi) || [];
  const ends = normalized.match(/^commit;[ \t]*$/gmi) || [];
  const wrapped = normalized.match(/^((?:[ \t]*--[^\n]*\n|[ \t]*\n)*)begin;[ \t]*\n([\s\S]*)\ncommit;\s*$/i);
  if (starts.length !== 1 || ends.length !== 1 || !wrapped) {
    throw new Error(`Expected one outer BEGIN/COMMIT transaction in ${name}.`);
  }
  const body = `${wrapped[1]}${wrapped[2]}`.trim();
  return `-- Migration: ${name}\n${body}`;
}

export function buildProjectsSetup() {
  const sections = migrations.map(name => transactionBody(readFileSync(resolve(root, 'database/migrations', name), 'utf8'), name));
  return `-- Instalacao de Projetos, Acesso do time e listas de producao manuais.
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

${sections.join('\n\n')}

commit;
`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const content = buildProjectsSetup();
  if (process.argv.includes('--check')) {
    if (readFileSync(outputPath, 'utf8') !== content) {
      throw new Error('database/instalar-projetos.sql esta desatualizado. Execute npm run build:projects-sql.');
    }
    console.log('SQL de instalacao de Projetos atualizado.');
  } else {
    writeFileSync(outputPath, content, 'utf8');
    console.log('Gerado database/instalar-projetos.sql.');
  }
}
