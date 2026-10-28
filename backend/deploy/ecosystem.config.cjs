// PM2 process file. From the project root: pm2 start backend/deploy/ecosystem.config.cjs
const path = require('node:path');
const root = path.join(__dirname, '..', '..');

module.exports = {
  apps: [
    { name: 'backend', cwd: path.join(root, 'backend'), script: 'dist/main.js', env: { NODE_ENV: 'production' } },
    { name: 'worker', cwd: path.join(root, 'backend'), script: 'dist/worker.js', env: { NODE_ENV: 'production' } },
    { name: 'frontend', cwd: path.join(root, 'frontend'), script: 'npm', args: 'start', env: { NODE_ENV: 'production' } },
  ],
};
