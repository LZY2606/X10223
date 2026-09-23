import { spawn } from 'node:child_process';

const viteArgs = process.argv.slice(2);
const procs = [
  spawn('npx', ['tsx', 'watch', 'server/index.ts'], { stdio: 'inherit', shell: true }),
  spawn('npx', ['vite', ...viteArgs], { stdio: 'inherit', shell: true })
];
const shutdown = () => { for (const p of procs) p.kill('SIGTERM'); };
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
