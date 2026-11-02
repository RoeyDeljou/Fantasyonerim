import { startServer } from './boot.js';
import { loadEnv } from './env.js';

const { app, shutdown } = await startServer({ env: loadEnv() });

// A socket that resets after its request already settled (seen with push services behind proxies) emits an
// error nobody can await. Such transport errors must not take the whole server down; anything else is a
// real bug, so log it and exit (the host restarts the process).
const TRANSIENT_SOCKET_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH']);
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code && TRANSIENT_SOCKET_ERRORS.has(err.code)) {
    app.log.warn({ code: err.code }, 'ignored stray socket error');
    return;
  }
  app.log.fatal({ err }, 'uncaught exception — exiting');
  process.exit(1);
});

const exit = (signal: string): void => {
  void shutdown(signal).finally(() => process.exit(0));
};
process.once('SIGINT', () => exit('SIGINT'));
process.once('SIGTERM', () => exit('SIGTERM'));
