import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GelStore } from '../src/server/store';
import { ProjectService } from '../src/server/projectService';
import { analyzeBaseline } from './helpers';
import { CorruptFormatError } from '../src/shared/diagnostic';

function openStore(dir: string) {
  return new GelStore(join(dir, 'rec.db'));
}

describe('半写恢复（崩溃在提交前）', () => {
  it('暂存但未提交的事件在重新打开时回滚，已提交事件保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gel-rec-'));
    try {
      // 第一个进程：建库并提交初始事件。
      const store = new GelStore(join(dir, 'rec.db'), { recoverOnOpen: false });
      const service = new ProjectService(store);
      const { c } = analyzeBaseline();
      service.createProject('r', 'R');
      const committedCount = store.listEvents('r').length;
      expect(committedCount).toBeGreaterThan(0);
      store.close();

      // 第二个“进程”：打开时不恢复，写入暂存（模拟已 fsync 的 WAL），随后崩溃（不回滚）。
      const crashed = new GelStore(join(dir, 'rec.db'), { recoverOnOpen: false });
      crashed.stageEvent('r', 'tok-half', JSON.stringify({ half: true }));
      crashed.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      expect((crashed.db.prepare('SELECT COUNT(*) c FROM event_pending').get() as any).c).toBe(1);
      // 模拟崩溃：直接释放句柄，不走任何清理。
      crashed.db.close();

      // 第三个进程正常打开（构造即恢复）：那条半写暂存应已回滚。
      const store2NoRec = new GelStore(join(dir, 'rec.db'), { recoverOnOpen: false });
      expect((store2NoRec.db.prepare('SELECT COUNT(*) c FROM event_pending').get() as any).c).toBe(1);
      store2NoRec.close();
      const store2 = openStore(dir); // 默认构造即执行恢复
      expect((store2.db.prepare('SELECT COUNT(*) c FROM event_pending').get() as any).c).toBe(0);
      const recovered = store2.recoverPending();
      expect(recovered.rolledBack).toBe(0);
      // 已提交事件仍在
      expect(store2.listEvents('r').length).toBe(committedCount);
      // 再次打开无残留
      store2.close();
      const store3 = openStore(dir);
      expect(store3.recoverPending().rolledBack).toBe(0);
      store3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('提交内容与暂存不一致时拒绝（防半写/篡改）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gel-rec-'));
    try {
      const store = openStore(dir);
      store.stageEvent('r', 'tok', JSON.stringify({ a: 1 }));
      expect(() =>
        store.commitEvent('r', 99, 'evt-x', 'main', JSON.stringify({ a: 2 }), 'h', '', 'tok'),
      ).toThrow(CorruptFormatError);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('事件链篡改可被 verifyChain 发现', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gel-rec-'));
    try {
      const store = openStore(dir);
      const service = new ProjectService(store);
      service.createProject('r', 'R');
      expect(store.verifyChain('r').ok).toBe(true);
      // 直接插入断链事件
      expect(() =>
        (store as any).db
          .prepare('INSERT INTO events(project_id,seq,event_id,branch_id,event_json,self_hash,prev_hash) VALUES(?,?,?,?,?,?,?)')
          .run('r', 5, 'evt-bad', 'main', '{}', 'deadbeef', 'wrongprev'),
      ).not.toThrow();
      expect(store.verifyChain('r').ok).toBe(false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('数据库文件实际落地（删除内存后可重开）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gel-rec-'));
    try {
      expect(existsSync(join(dir, 'rec.db'))).toBe(false);
      const store = openStore(dir);
      store.close();
      expect(existsSync(join(dir, 'rec.db'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
