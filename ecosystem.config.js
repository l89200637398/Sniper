module.exports = {
  apps: [{
    name: 'sniper',
    script: 'dist/index.js',
    cwd: '/opt/sniper',
    env: {
      NODE_ENV: 'production',
    },
    env_file: '.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_file: 'logs/pm2.log',
    time: true,
  }],
};
