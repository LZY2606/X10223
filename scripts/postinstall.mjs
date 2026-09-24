// Rebuild the bundled offline case pack after dependency installation.
import { execFileSync } from 'node:child_process';
try {
  execFileSync('npx', ['vite-node', 'scripts/build-casepack.ts'], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  console.warn('[postinstall] case pack build skipped:', err?.message ?? err);
}
