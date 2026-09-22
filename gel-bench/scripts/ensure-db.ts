import { openDatabase, recoverPendingWrites } from '../src/storage/db';
import { Store } from '../src/storage/store';
import { seedFromCasePack } from '../src/domain/seeder';
import { resolve } from 'node:path';

const dbPath = resolve(process.cwd(), 'data/gelbench.sqlite');
const db = openDatabase(dbPath);
const recovered = recoverPendingWrites(db);
const store = new Store(db);
if (store.listProjects().length === 0) {
  const seeded = seedFromCasePack(store);
  console.log(`已播种：基线 ${seeded.baselineProjectId} + 反例 ${Object.keys(seeded.scenarioProjectIds).length} 个`);
} else {
  console.log('数据库已存在案例，跳过播种');
}
if (recovered.recovered > 0) console.log(`半写恢复：回收 ${recovered.recovered} 个未完成事务`);
db.close();
