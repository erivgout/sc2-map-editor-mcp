/**
 * Library surface of the server app, so tests (and a future HTTP entry) can build a
 * server without going through `main.ts`.
 */

export { createContext, type CreateContextOptions, type ServerContext } from './context.js';
export { createMcpServer } from './server.js';
export * from './version.js';
