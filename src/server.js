const path = require('node:path');
const dotenv = require('dotenv');
const { createApp } = require('./app');
const { loadConfig } = require('./config/env');

function startServer() {
  dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[config] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`Dormitory OCR service listening on http://${host}:${config.port}`);
  });

  server.on('error', (error) => {
    const code = error.code === 'EADDRINUSE' ? 'Port is already in use.' : 'Could not bind the HTTP server.';
    console.error(`[server] ${code}`);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 10_000);
    deadline.unref();

    server.close((error) => {
      clearTimeout(deadline);
      if (error) process.exitCode = 1;
    });
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) startServer();

module.exports = { startServer };
