// 稳定身份：材料/对象/事件/派生物的确定性 id。
// 等价输入 ⇒ 等价 id 与顺序；派生物使用内容寻址。
import { hashJson } from './hash.js';

export function stableId(kind: string, ...parts: (string | number | object)[]): string {
  const h = hashJson(parts.length === 1 ? parts[0]! : parts);
  return `${kind}_${h.slice(0, 16)}`;
}

export function derivationId(
  kind: string,
  ruleVersion: string,
  paramsVersion: string,
  inputSummary: string,
  parents: string[],
): string {
  return stableId('deriv', kind, ruleVersion, paramsVersion, inputSummary, [...parents].sort());
}

export function bandId(laneId: string, rank: number, centerX: number, centerY: number): string {
  return stableId('band', laneId, rank, Math.round(centerX * 10) / 10, Math.round(centerY * 10) / 10);
}

let eventCounter = 0;
export function regenerateEventCounterSeed(): void {
  eventCounter = 0;
}
