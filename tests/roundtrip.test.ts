import { describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.ts';
import { canonicalize, digest } from '../src/domain/ids.ts';
import { seededStore } from './helpers.ts';

describe('export / import roundtrip', () => {
  it('identity, order and provenance survive export -> delete -> import', () => {
    const a = seededStore();
    const bundle = a.exportBundle();

    const b = new Store(':memory:');
    const outcome = b.importBundle(bundle);
    expect(outcome.kind).toBe('ok');

    expect(b.listMaterials().map((m) => m.id)).toEqual(a.listMaterials().map((m) => m.id));
    expect(b.listMaterials().map((m) => m.seq)).toEqual(a.listMaterials().map((m) => m.seq));
    expect(b.listEvents().map((e) => e.id)).toEqual(a.listEvents().map((e) => e.id));
    expect(b.branches()).toEqual(a.branches());
    const ra = a.currentResults();
    const rb = b.currentResults();
    expect(rb.map((r) => r.id)).toEqual(ra.map((r) => r.id));
    expect(rb.map((r) => r.parents)).toEqual(ra.map((r) => r.parents));
    expect(rb.map((r) => `${r.kind}:${r.status}:${r.params_version}`))
      .toEqual(ra.map((r) => `${r.kind}:${r.status}:${r.params_version}`));
    // blobs survive
    const imgA = a.listMaterials().find((m) => m.kind === 'gel_image')!;
    expect(b.getBlob(imgA.id)).toEqual(a.getBlob(imgA.id));
  });

  it('re-importing the same bundle is idempotent', () => {
    const a = seededStore();
    const bundle = a.exportBundle();
    const b = new Store(':memory:');
    expect(b.importBundle(bundle).kind).toBe('ok');
    const n1 = b.allResults().length;
    expect(b.importBundle(bundle).kind).toBe('ok');
    expect(b.allResults().length).toBe(n1);
  });
});

describe('half-write recovery', () => {
  it('corrupt bundle digest is format_corrupt and writes nothing', () => {
    const a = seededStore();
    const bundle = a.exportBundle();
    const tampered = { ...bundle, digest: 'deadbeef' };
    const b = new Store(':memory:');
    const outcome = b.importBundle(tampered);
    expect(outcome.kind).toBe('format_corrupt');
    expect(b.listMaterials()).toHaveLength(0);
    expect(b.listEvents()).toHaveLength(0);
    expect(b.allResults()).toHaveLength(0);
  });

  it('a crash mid-transaction rolls back completely (no half-written rows)', () => {
    const a = seededStore();
    const bundle = a.exportBundle();
    // corrupt one blob but keep the bundle digest consistent, so the
    // failure happens inside the transaction rather than at validation
    const imageId = a.listMaterials().find((m) => m.kind === 'gel_image')!.id;
    const blobs = { ...bundle.blobs, [imageId]: '!!!not-base64!!!' };
    const evil = {
      ...bundle,
      blobs,
      digest: digest(canonicalize({ materials: bundle.materials, blobs, events: bundle.events, results: bundle.results })),
    };
    const b = new Store(':memory:');
    const outcome = b.importBundle(evil);
    expect(outcome.kind).toBe('format_corrupt');
    // nothing leaked out of the rolled-back transaction
    expect(b.listMaterials()).toHaveLength(0);
    expect(b.listEvents()).toHaveLength(0);
    expect(b.allResults()).toHaveLength(0);
  });

  it('replaying to an old event restores the conclusions visible then', () => {
    const store = seededStore();
    const events = store.listEvents();
    const amend = events.find((e) => e.type === 'source.amended')!;
    const before = store.resultsUpTo(amend.seq - 1);
    const after = store.resultsUpTo(store.latestSeq());
    // before the amendment nothing is superseded
    expect(before.some((r) => r.status === 'superseded')).toBe(false);
    // after it, the lane-3 dependent results carry tombstones
    expect(after.some((r) => r.status === 'superseded')).toBe(true);
    // old conclusions remain readable, not overwritten
    const tombstonedIds = after.filter((r) => r.status === 'superseded').map((r) => r.id);
    const history = store.allResults().filter((r) => tombstonedIds.includes(r.id));
    expect(history.some((r) => r.status !== 'superseded')).toBe(true);
  });
});
