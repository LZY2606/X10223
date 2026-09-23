# 胶道标尺 · 电泳条带、泳道弯曲与分子量校准工作台

面向分子实验室的本地应用:为原始凝胶图像标出 ladder、lane 和 band,
比较自动候选与人工修订后的分子量推断。全部业务规则在服务端与存储层,
可直接被测试调用;浏览器只做证据往返查看。

## 运行

```bash
npm install
npm test -- --run          # 22 个验收测试
npm run dev -- --host 127.0.0.1 --port 5342 --strictPort
# 打开 http://127.0.0.1:5342 (无需账号/云端/额外配置)
```

首次启动自动把 `casepack/gel-ruler/` 离线案例包播种进本地 SQLite (`data/gel-ruler.db`)。

## 分层

- **不可变材料** (`materials` 表): 原图 (raw 像素, 存储方向旋转 90°)、拍摄方向、
  曝光 (`2.5 kV*h` 原始表示保留)、ladder 标称值 (bp)、lane 边界与条带中心
  (均带 `image-raw` 像素级来源)。内容寻址 id,永不原地修改;修订产生新版本
  并以 `supersedes` 指回旧版。
- **派生层** (`derived` 表): lane 曲线 (二次微笑模型)、局部标尺
  (`log10(bp) = a + b·d`,带有效区间 `[dMin, dMax]` px / `image-norm`)、
  分子量推断。每条派生结果记录输入摘要、参数版本与父级依赖。
- **决定层** (`events` 表): 接受/否定/调整参数、源数据修订、两条机器可读取判断
  (`judgment:smile-local-ruler`、`judgment:degraded-band-evidence`)。
  冲突的人工决定在不同分支上共存;回放任意旧事件恢复当时的依赖版本与可见结论。

## 核心规则

1. **微笑弯曲**: 同一高度 ≠ 同一分子量。`d_eff = y_norm − smileOffset(lane)`,
   局部标尺必须带有效区域;超出区域只给区间,绝不给点估计。
2. **退化证据**: 饱和、拖尾、重叠条带只能标为 `candidate` 或 `interval`;
   重叠时保留全部合法候选。
3. **三种失败可区分**: `budget_exhausted`(资源预算耗尽)、
   `format_corrupt`(格式损坏)、`semantic_unsolvable`(语义无解,如非单调标尺)。
4. **局部失效**: 源数据修订只使其依赖锥失效,其余派生结果身份不变;
   等价输入得到稳定身份与顺序。
5. **诊断带位置**: 输入不完整时返回 JSON-pointer 路径的诊断,
   不用空值或默认值伪装成功;无法转换的单位留在原位置。

## 反例档案 (casepack/gel-ruler/scenarios.json)

基线: 原图/拍摄方向/曝光/ladder 标称值/lane 边界/条带中心均保留像素级来源。
七个单变量突变场景(页面顶部按钮直接触发): 旋转图像、弯曲泳道、ladder 缺带、
饱和区、两条带重叠、非单调标尺、修订后局部失效。被采纳与未采纳的结果都保留在
事件日志与派生表中。

## 工作流

导入案例包 → 计算 → 保存 → 导出 (JSON bundle) → 再次打开 (导入)。
导出/删除数据库/再导入后,身份、顺序、分支与来源关系保持(见 `tests/roundtrip.test.ts`);
导入以带日志的批次写入,崩溃半写在下次打开时回滚(见 `tests/halfwrite.test.ts`)。

## 复核路径

页面叠加原图 + lane 曲线 + 条带轮廓 + 拟合残差;点击条带显示分子量、单位、
坐标基准、有效区间、失效原因;点击分子量回到 ladder 点与插值段。
从该视图做出的接受/否定/调整参数都生成新事件。

## 结构

```
src/domain/    领域核心(纯函数,无 IO):units/geometry/ruler/bands/infer/model/pipeline/exportImport
server/        SQLite 存储(node:sqlite)+ 半写恢复 + HTTP API(5343)
src/web/       Vite 审阅页(5342)
scripts/       dev 启动器、案例包生成器、PNG 编码器
casepack/      离线领域案例包(合成凝胶 PNG + materials.json + scenarios.json)
tests/         22 个验收测试(vitest)
```
