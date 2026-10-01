const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.playwright');
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser', timeout: 30000, workers: 1,
  use: { baseURL:'http://localhost:5174', viewport:{width:1440,height:1000}, locale:'pt-BR', timezoneId:'America/Sao_Paulo', screenshot:'only-on-failure' },
  webServer: {command:'npm.cmd run serve',url:'http://localhost:5174',reuseExistingServer:true,timeout:30000},
  reporter: 'list'
});
