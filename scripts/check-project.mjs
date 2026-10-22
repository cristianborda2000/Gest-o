import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectsSetup } from './build-projects-setup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'app');

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(filename);
    return /\.(?:c|m)?js$/.test(entry.name) ? [filename] : [];
  }));
  return files.flat();
}

function checkSyntax(filename) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', filename], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `JavaScript inválido: ${filename}`)));
  });
}

async function checkAsset(reference, source) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return;
  const name = decodeURIComponent(reference.split(/[?#]/)[0]);
  const target = name.startsWith('/')
    ? path.resolve(frontend, name.slice(1))
    : path.resolve(path.dirname(source), name);
  const relative = path.relative(frontend, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Asset fora de app/: ${reference}`);
  if (!(await stat(target).catch(() => null))?.isFile()) {
    throw new Error(`Asset ausente em ${path.relative(root, source)}: ${reference}`);
  }
}

const directories = ['app/assets/js', 'api', 'services', 'scripts', 'tests'];
const files = (await Promise.all(directories.map(directory => javascriptFiles(path.join(root, directory))))).flat();
files.push(...['app/notification-worker.js', 'playwright.config.js', 'tailwind.config.js'].map(file => path.join(root, file)));
// Limit child processes so checking the project is predictable on smaller PCs.
for (let index = 0; index < files.length; index += 4) {
  await Promise.all(files.slice(index, index + 4).map(checkSyntax));
}

const indexFile = path.join(frontend, 'index.html');
const html = await readFile(indexFile, 'utf8');
const references = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)].map(match => [match[1], indexFile]);
for (const entry of await readdir(path.join(frontend, 'assets'))) {
  if (!entry.endsWith('.css')) continue;
  const filename = path.join(frontend, 'assets', entry);
  const css = await readFile(filename, 'utf8');
  references.push(...[...css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)].map(match => [match[1], filename]));
}
await Promise.all(references.map(([reference, source]) => checkAsset(reference, source)));
const installer = await readFile(path.join(root, 'database/instalar-projetos.sql'), 'utf8');
if (installer.replace(/\r\n?/g, '\n') !== buildProjectsSetup().replace(/\r\n?/g, '\n')) {
  throw new Error('Instalador SQL desatualizado. Execute npm run build:projects-sql.');
}
console.log(`Verificados ${files.length} arquivos JavaScript, referências dos assets e instalador de Projetos.`);
