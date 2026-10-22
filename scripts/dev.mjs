import { createServer } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const require = createRequire(import.meta.url);
const routes = [
  { path: '/api/jarvis', subpaths: true, handler: require('../services/jarvis/http').createHandler() },
  { path: '/api/reminders', subpaths: true, handler: require('../services/reminders/http').createHandler() },
  { path: '/api/reminder-cron', handler: require('../services/reminders/dispatcher').createHandler() },
  { path: '/api/project-access', handler: require('../services/project-access/http').createHandler() },
];

const server = await createServer({
  configFile: false,
  root: path.join(root, 'app'),
  server: {
    host: 'localhost',
    port: 5174,
    strictPort: true,
    fs: { allow: [path.join(root, 'app')] },
  },
  plugins: [{
    name: 'zama-api',
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        const route = routes.find(item => pathname === item.path || item.subpaths && pathname.startsWith(`${item.path}/`));
        if (route) return route.handler(req, res);
        next();
      });
    },
  }],
});

await server.listen();
server.printUrls();
