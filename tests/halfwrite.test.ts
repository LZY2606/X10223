import { describe, it, expect, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { GelApp } from "../server/app.ts";
import { Store } from "../server/db.ts";

const DB = "data/test-halfwrite.db";
afterAll(() => { try { rmSync(DB); } catch {} });

describe("半写恢复 (half-write recovery)", () => {
  it("a crash mid-import is rolled back on reopen", () => {
    try { rmSync(DB); } catch {}
    const a = new GelApp(":memory:", "casepack/gel-ruler");
    a.seed();
    const bundle = a.export();
    a.close();

    // simulate a crashed import: batch left pending with partially written rows
    const s1 = new Store(DB);
    s1.db.prepare("INSERT INTO import_batches (id, status, started_at) VALUES ('batch-crash', 'pending', ?)").run(new Date().toISOString());
    const m = bundle.materials[0];
    s1.db.prepare("INSERT INTO materials (id, kind, version, supersedes, payload, created_by) VALUES (?,?,?,?,?,?)")
      .run(m.id, m.kind, m.version, m.supersedes, JSON.stringify(m.payload), m.createdByEvent);
    s1.db.prepare("INSERT INTO batch_rows (batch_id, table_name, row_id) VALUES ('batch-crash', 'materials', ?)").run(m.id);
    s1.close();

    // reopen: recovery must remove the half-written row
    const s2 = new Store(DB);
    const recovered = s2.recover();
    expect(recovered).toEqual([]); // already recovered in constructor
    expect(s2.materials().find((x) => x.id === m.id)).toBeUndefined();
    const batch = s2.db.prepare("SELECT status FROM import_batches WHERE id='batch-crash'").get() as any;
    expect(batch.status).toBe("rolled-back");
    s2.close();
  });

  it("committed import survives reopen intact", () => {
    try { rmSync(DB); } catch {}
    const a = new GelApp(":memory:", "casepack/gel-ruler");
    a.seed();
    const bundle = a.export();
    a.close();
    const app1 = new GelApp(DB, "casepack/gel-ruler");
    const r = app1.import(JSON.stringify(bundle));
    expect(r.ok).toBe(true);
    const n1 = app1.state().events.length;
    app1.close();
    const app2 = new GelApp(DB, "casepack/gel-ruler");
    expect(app2.state().events.length).toBe(n1);
    expect(app2.state().materials.length).toBe(bundle.materials.length);
    app2.close();
  });
});
