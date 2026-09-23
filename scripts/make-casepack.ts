import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildCasepack } from '../src/core/casepack'

const outDir = join(process.cwd(), 'casepack')
mkdirSync(outDir, { recursive: true })
const pack = buildCasepack()
for (const sc of pack.scenarios) {
  writeFileSync(join(outDir, `${sc.kind}.png`), Buffer.from(sc.png))
  const { png: _png, ...meta } = sc
  void _png
  writeFileSync(join(outDir, `${sc.kind}.json`), JSON.stringify(meta, null, 2))
}
writeFileSync(join(outDir, 'README.md'), `# 胶道标尺离线案例包\n\n共 ${pack.scenarios.length} 个场景：\n\n${pack.scenarios
  .map((s) => `- \`${s.kind}.png\` — ${s.title}：${s.description}`)
  .join('\n')}\n\n所有领域量携带单位/坐标基准；原始表示保留在 JSON 中。\n`)
console.log('casepack written:', pack.scenarios.map((s) => s.kind).join(', '))
