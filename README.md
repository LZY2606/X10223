# 胶道标尺：电泳条带、泳道弯曲与分子量校准工作台

面向分子实验室的**离线**凝胶图像审阅工具：在原始凝胶图像上标出 ladder / lane / band，
比较**自动候选**与**人工修订**后的分子量推断。业务规则在服务端（TypeScript + Node.js），
存储用 SQLite（Node 24 内置 `node:sqlite`，免原生编译），前端用 Vite。

- 打开 `http://127.0.0.1:5342` 即进入**带样例**的审阅页，无需账号 / 云服务 / 额外配置。
- 数据库文件在 `data/gel-workbench.db`；删除后重启会从内置离线案例包重建。

## 运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5342 --strictPort
```

## 分层：不可变材料 vs 可修改决定

| 层 | 内容 | 是否可变 |
|----|------|----------|
| L0 材料 | 原图灰度像素、拍摄方向、曝光、ladder 标称值（原始字符串 + 规范化 bp） | 不可变，仅追加新版本 |
| L1 标注 | lane 中心线/边界、band 中心，均带**原图像素坐标**与来源（自动候选/人工修订） | 修订产生新身份，`supersedes` 旧身份，不覆盖 |
| L2 派生 | 分段校准、拟合残差、分子量推断 | 由 L0/L1 + 参数版本重放得到 |
| L3 决定 | 接受 / 否定 / 调整事件、分支 | 只追加，永不改写历史 |

每个计算结果记录 **inputSummary（输入摘要）、paramVersion（参数版本）、parentDepends（父级依赖）**。
输入不完整时返回**带位置的诊断**（`location.materialId/laneId/bandId/x/y`），
绝不用空值或默认值伪装成功。

## 领域判断（机器可读 `evidence-judgment` 事件，不只是日志）

- **“微笑”弯曲**：同一像素高度不等于同一分子量。按泳道中心线**弧长 s** 做**分段局部标尺**，
  每段携带**有效区域**（`sMin/sMax` 与像素 `yMin/yMax`）；曲率超阈值即记录
  `smile-needs-local-scale`。
- **饱和条带 / 拖尾 / 重叠**：只能标为**候选或区间**（`saturated-candidate-only` /
  `tail-interval-only` / `overlap-candidate-set`）。重叠时保留**全部合法候选**，不强行取一。
- **ladder 缺带**：跨越缺带的插值段为 `missing-span`，落带推断降为粗区间。
- **非单调标尺**：插值段 `non-monotonic`，落带推断 `unresolved`（语义无解，区别于格式错误）。
- **出有效区域**：人工把条带拖到最低 ladder 点之下时拒绝外推，且影响**只限于该条带**。

三种不同的失败结果（错误码彼此独立）：
`BUDGET_EXHAUSTED`（507，资源预算耗尽）/ `CORRUPT_FORMAT`（422，格式损坏）/
`SEMANTIC_UNRESOLVABLE`（409，语义无解，附带诊断）。

## 内置离线案例包（领域材料，非通用表格）

合成凝胶由确定性配方（`src/casepack/recipes.ts`，mulberry32 PRNG + 零依赖 PNG）生成，
配方即不可变来源；等价配方 → 等价像素 → 等价稳定身份。

- `sample-gel-case`：导入材料 → 像素级 lanes → 自动分析（自动候选）→ 参数修订
  （`params.v2-curvature-aware`）→ 仅影响局部依赖的源改动（把 L1 修成微笑）→
  main 与 review-alt 分支上**互相冲突**的人工决定。
- 七个“只改一个直接来源”的反例：`rotation / smile / missing-band / saturation /
  overlap / nonmonotonic / local-invalidation`。采纳与未采纳结果都保留。

## 复核界面的证据往返

页面在原图上叠加 **lane 曲线、边界、条带中心、局部标尺有效区域、ladder 插值段、拟合残差、
沿中心线的强度轮廓**。点击任一分子量标签可回到支撑它的 **ladder 点与插值段**，
读出有效区间、单位、坐标基准、参数版本、失效原因与稳定身份。事件时间线上点击任意旧事件，
即用当时参数版本重放，恢复当时可见结论（不会被最新计算覆盖）。

每个显示值都有稳定身份：`mat-* / lane_* / band_* / seg_* / fit_* / cand_* / mwinf_* / evt_* / dec_*`，
身份由内容哈希决定，因此**等价输入得到稳定顺序**。

## 导出 / 删除 / 导入往返

`导出 .gelpack` 生成自包含容器（magic `GELPACK1` + manifest 含 sha256 + gzip 规范化状态）。
删除本地数据库后再导入，**身份、顺序、分支与决定历史**保持；内容被截断 / 篡改时返回
`CORRUPT_FORMAT`。

半写恢复：事件先写 `event_pending`（两阶段），提交成功才并入 `events`；进程在提交前崩溃时，
重新打开会回滚残留暂存，已提交事件与哈希链保留（`tests/recovery.test.ts`）。

## 代码地图

```
src/shared/      单位/坐标、诊断与三态错误、稳定身份、规范化序列化
src/core/        合成凝胶、PNG、几何弧长、轮廓/峰值检测、分段校准、分子量推断、自动泳道、分析流水线
src/provenance/  事件、归约器（重放/分支/冲突）
src/casepack/    领域离线案例配方与构建器
src/server/      SQLite 存储、项目服务（业务规则）、.gelpack 导入导出、HTTP/Vite 中间件、种子
src/web/         复核界面（canvas 叠加 + 证据面板 + 事件时间线）
tests/           验收（7 反例）、引擎、事件溯源/往返、半写恢复、HTTP 端到端
```
