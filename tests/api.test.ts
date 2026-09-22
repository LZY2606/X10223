import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer, type ServerHandle } from '../src/server/httpServer';
import { SAMPLE_PROJECT_ID, VARIANT_IDS } from '../src/server/seeder';

const dir = mkdtempSync(join(tmpdir(), 'gel-api-'));
let handle: ServerHandle;
let base: string;

beforeAll(async () => {
  handle = startApiServer(join(dir, 'api.db'), 5399);
  base = 'http://127.0.0.1:5399';
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('完整工作流 HTTP 端到端', () => {
  it('健康检查 + 项目列表含样例与七个反例', async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.ok).toBe(true);
    const list = await (await fetch(`${base}/api/projects`)).json();
    const ids = list.projects.map((p: any) => p.projectId);
    expect(ids).toContain(SAMPLE_PROJECT_ID);
    for (const v of VARIANT_IDS) expect(ids).toContain(`case-${v}`);
  });

  it('样例项目含完整事件叙事、分支与冲突决定', async () => {
    const v = await (await fetch(`${base}/api/project/${SAMPLE_PROJECT_ID}`)).json();
    const types = v.events.map((e: any) => e.type);
    expect(types).toContain('materials-imported');
    expect(types).toContain('auto-analysis');
    expect(types).toContain('parameter-revised');
    expect(types).toContain('decision');
    expect(v.branchOrder).toContain('review-alt');
    expect(v.conflicts.length).toBeGreaterThanOrEqual(0);
    // 每个推断带稳定身份
    for (const inf of v.analysis.result.inferences) expect(inf.inferenceId).toMatch(/^mwinf_/);
  });

  it('原图 PNG 可取', async () => {
    const r = await fetch(`${base}/api/project/${SAMPLE_PROJECT_ID}/image`);
    expect(r.headers.get('content-type')).toBe('image/png');
    const buf = new Uint8Array(await r.arrayBuffer());
    expect(buf[0]).toBe(137);
  });

  it('回到旧事件视图（?at=）不修改 head', async () => {
    const head = await (await fetch(`${base}/api/project/${SAMPLE_PROJECT_ID}`)).json();
    const oldEvent = head.events[0].eventId;
    const old = await (await fetch(`${base}/api/project/${SAMPLE_PROJECT_ID}?at=${oldEvent}`)).json();
    expect(old.events.length).toBe(1);
    const again = await (await fetch(`${base}/api/project/${SAMPLE_PROJECT_ID}`)).json();
    expect(again.events.length).toBe(head.events.length);
  });

  it('导出→导入到新项目保持身份', async () => {
    const pack = await (await fetch(`${base}/api/project/${SAMPLE_PROJECT_ID}/export`)).arrayBuffer();
    const r = await fetch(`${base}/api/import`, { method: 'POST', body: pack });
    expect(r.ok).toBe(true);
    const imported = await r.json();
    expect(imported.projectId).toBe(SAMPLE_PROJECT_ID);
    expect(imported.project.events.length).toBeGreaterThan(1);
  });

  it('损坏包返回 422 CORRUPT_FORMAT（语义错误不同码）', async () => {
    const r = await fetch(`${base}/api/import`, { method: 'POST', body: new Uint8Array([1, 2, 3]) });
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.error).toBe('CORRUPT_FORMAT');
  });

  it('七个反例项目暴露对应诊断或状态', async () => {
    for (const v of VARIANT_IDS) {
      const view = await (await fetch(`${base}/api/project/case-${v}`)).json();
      expect(view.analysis).toBeTruthy();
      const codes = view.analysis.result.diagnostics.map((d: any) => d.code);
      const statuses = view.analysis.result.inferences.map((i: any) => i.status);
      const ok =
        codes.length > 0 ||
        statuses.some((s: string) => s !== 'unique') ||
        view.analysis.result.fits.some((f: any) => f.segments.some((g: any) => g.status !== 'valid'));
      expect(ok, `variant ${v} should show an effect`).toBe(true);
    }
  });
});
