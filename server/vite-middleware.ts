import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDeps, handleApi } from './app';

let deps: ReturnType<typeof createDeps> | null = null;

export function createApiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    deps ??= createDeps();
    const handled = await handleApi(req, res, deps);
    if (!handled) next();
  };
}
