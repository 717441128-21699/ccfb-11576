# 桥牌俱乐部 · 复式赛计分与双明手复盘工具

纯 TypeScript 实现的桥牌工具，面向俱乐部每周复式赛的两个核心场景：

1. **复式赛计分**：导入每桌的定约、庄家、打成墩数，按局况算分，换算成比赛分（Matchpoint）/平均 IMP（Butler）/队际 IMP，并排出各对名次。
2. **双明手复盘**：对每副牌计算双明手最佳墩数，并支持逐墩回放——每出一张牌实时标出哪些是最佳出法，出错时显示丢了几墩。

## 目录结构

```
src/
  cards.ts            牌/花色/座位基础定义，13 位掩码表示一手牌
  deal.ts             PBN 牌串解析、校验、旋转/换花色（供不变量测试）
  rng.ts              确定性随机数与洗牌（可复现的测试发牌）
  dds/
    transposition.ts  置换表（Zobrist 键、边界类型、最佳走法）
    solver.ts         双明手搜索引擎（Alpha-Beta + MTD(f) + PVS 等）
  scoring/
    contract.ts       定约计分（WBF 规则，含加倍/满贯/局况）
    imp.ts            IMP 换算表
    match.ts          比赛分、平均 IMP、队际 IMP、排名
    match-file.ts     比赛 JSON 的导入、校验与汇总
  review/
    review.ts         复盘状态机：逐墩回放、最佳出牌标注、丢墩计算
  web/                零依赖原生 TS 界面 + Web Worker
  cli/score-cli.ts    命令行计分工具
tests/                node:test 单元测试 + 独立暴力穷举对拍
```

## 快速开始

```bash
npm install
npm test          # 运行全部单元测试（36 个，含 2040 组穷举对拍）
npm run typecheck # TypeScript 严格类型检查
npm run perf      # 双明手性能基准（手动运行）
npm run build:web # 打包 Web 界面到 dist/web
npm start         # 启动本地服务器，打开 http://localhost:5173
```

命令行计分：

```bash
node --experimental-strip-types --loader ./scripts/ts-loader.mjs \
  src/cli/score-cli.ts examples/sample-match.json
```

## 双明手引擎

### 算法

- **Alpha-Beta 剪枝**，NS 为 max 方、EW 为 min 方，fail-soft，MAX/MIN 对称的边界类型分类。
- **MTD(f)**：根节点全程零窗口二分逼近，避免冷启动全窗口的高成本。
- **PVS / Negascout**：内部节点首个走法全窗口、其余先零窗口侦察，失败高再重搜。
- **置换表（Transposition Table）**：64 位 Zobrist 增量哈希，只在墩首读写以最大化按墩状态复用；表项记录边界类型与最佳走法。
- **走法排序**：置换表最佳走法优先、killer move、history heuristic，加上能赢墩/大牌优先的静态评分。
- **等牌连张剪枝**：领出（墩首）时，若同花色所有更大的余牌都在出牌人自己手里，则该牌被自己的大牌严格支配而跳过。此规则刻意保守——经实验，放宽到"己方（含对家）持大牌"或在跟牌位置启用都会出错。

### 正确性验证

`tests/solver.test.ts` 用一个**完全独立的朴素 minimax**（无剪枝、无哈希、对象数组风格的另一套实现）做穷举对拍：

- 每手 2 张、3 张的随机残局，全部 5 种将牌 × 4 个首引人，共 **2040 组**逐一比对，全部一致。
- 旋转 2 位（对家互换）、交换花色等不变量测试。
- 确定性：同一牌局重复求解结果完全相同。

### 性能现状（如实说明）

`npm run perf` 实测（单线程 Node，NT 定约、N 首引）：

| 残局规模 | 节点数 | 耗时 |
|---|---|---|
| 每手 2 张（8 牌） | 47 | ~1.4ms |
| 每手 4 张（16 牌） | 1,754 | ~2.9ms |
| 每手 6 张（24 牌） | 11,136 | ~12ms |
| 每手 8 张（32 牌） | ~1.2M | ~200ms |
| 完整 13 张（52 牌）单题 | >20M（预算内未完成） | >3s |

**当前纯 TypeScript 的通用 alpha-beta 实现在完整 52 张牌局上达不到"20 问 3 秒"的目标**，单题即在秒级以上、20 问为分钟级。原因是通用搜索的分支系数仍约 5–6×/张，而专业 DDS（Bo Haglund 等的 C 实现）依赖专用的 future-tricks 分阶段求解和高度工程化的按墩缓存，能把分支压到 ~1.3×/张，二者有数量级差距。

界面已用 **Web Worker + 进度条**把计算移出主线程，长计算不会冻结页面，并会逐题回报 `done/20`。

后续若要达成 3 秒指标，推荐路径（按性价比排序）：

1. 接入编译为 WebAssembly 的成熟 DDS（如 Bo Haglund DDS 的 WASM 移植），JS 侧只做编排与复盘 UI；
2. 或实现专用的按墩 future-tricks 算法（本仓库 `git 历史`中曾实验过 trick-level 重构，方向正确但 minimax 视角处理未完成）；
3. Worker 内并行 20 问只能改善墙钟时间的常数倍，无法弥补单题的算法差距。

引擎的**正确性是经过穷举对拍保证的**，复盘中标注的"最佳出法/丢墩数"因此可信；性能是唯一待解的工程问题。

## 复盘引擎

`ReviewEngine` 在一副牌上逐张推进，复用 `DDSolver.evaluateMove` 评估当前每张合法牌：

- `isBest`：打出后己方仍能达到当前局面最优结果的牌（可能多张并列）。
- `tricksLost`：相对最佳出法损失的墩数，0 即最佳。
- 界面上绿色为最佳、红色为会丢墩的牌，悬停可见具体墩数。

## 计分规则

实现 WBF 标准复式赛规则：低花/高花/NT 墩分、成局与部分定约奖分、大小满贯、普通/加倍/再加倍宕分表，IMP 换算表，以及比赛分、平均 IMP、队际 IMP 与并列同名次的排名。`tests/scoring.test.ts` 覆盖了各类定约的边界分数。

## 开发约定

- 严格 TypeScript（`strict` + `noUncheckedIndexedAccess`）。
- 源码用 `.js` 扩展写 ESM 导入，Node 端通过 `scripts/ts-loader.mjs` 解析到 `.ts`（Node 24 原生擦除类型）；Web 产物由 esbuild 打包，不依赖该 loader。
- 不引入运行时第三方依赖，安装的只有 typescript、esbuild、@types/node 三个开发依赖。
