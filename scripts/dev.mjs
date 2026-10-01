import { createServer } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const require = createRequire(import.meta.url);
const handler = require('../services/jarvis/http').createHandler();
const server = await createServer({ configFile: false, root: path.join(root, 'app'), server: { host: 'localhost', port: 5174, strictPort: true, fs: { allow: [path.join(root, 'app')] } }, plugins: [{ name: 'zama-api', configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url?.startsWith('/api/jarvis')) return handler(req, res); next(); }); } }] });
await server.listen(); server.printUrls();
