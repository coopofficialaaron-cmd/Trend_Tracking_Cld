# 趋势追踪 · Trend Tracker

把原来在 Google Sheet 里的收盘价趋势追踪模型，做成一个可以放到 GitHub 上、自己随时打开看的网页。
**加股票不再需要手动复制 tab —— 只改一个 `config.csv` 文件。**

模型逻辑与原表 1:1 一致（已逐行对照原工作簿校验，最大误差 ~1e-14）：
ATR(14)/ATR(50)（Wilder，SMA 初始化）、MA20、HC55/HC22、吊灯止损（随价格上移、不下移）、
最低/最高买入价、大盘过滤（对标 ETF 收盘 ≥ SMA100 且 10 日回撤 > -8%）、ENTER 信号、按 $25 风险算股数、ER22/ER55。

---

## 它怎么运转（无需服务器、不花钱）

```
config.csv ──► engine/build.py ──► docs/data/latest.json ──► docs/ 网页
   (你维护)      (抓数+计算)          (每天自动刷新)         (GitHub Pages)
```

- **数据源**：Yahoo Finance 免费行情接口（主）+ Stooq（备用），均无需 API key。Yahoo 放第一是因为 Stooq 会封 GitHub 机房 IP。
- **自动更新**：`.github/workflows/update.yml` 每个交易日收盘后自动抓数、计算、提交；抓不到时保留旧数据、任务仍为绿色。
- **网页**：纯静态（HTML/CSS/JS，零依赖），由 GitHub Pages 托管。
- **计算引擎**：纯 Python 标准库，**无第三方依赖**。

---

## 一次性部署（约 5 分钟）

1. 新建一个 GitHub 仓库，把本文件夹内容全部上传。
2. **Settings → Pages**：Source 选 `Deploy from a branch`，分支 `main`，目录选 **`/docs`**，保存。
3. **Settings → Actions → General**：Workflow permissions 选 **Read and write permissions**，保存。
4. 打开 **Actions** 标签页，手动跑一次 `Update prices & signals`（Run workflow）。
   跑完后访问 `https://<你的用户名>.github.io/<仓库名>/` 即可。

> 首次部署时仓库里已带一份用你原表历史数据生成的 `docs/data/latest.json`，
> 所以即便还没跑 Action，网页也能立刻显示内容。

---

## 加 / 删 / 改股票

编辑仓库根目录的 **`config.csv`**，提交即可（提交会自动触发一次重算）。**填 5 列**，公司名仍自动抓取：

```csv
ticker,exchange,benchmark,major,sub
NVDA,NASDAQ,SOXX,科技,半导体
XOM,NYSE,XLE,油气,综合油气
AIR,NYSE,ITA,国防航空航天,航空航天国防
```

| 列 | 含义 | 说明 |
|----|------|------|
| `ticker` | 股票代码 | 带点的代码照写，如 `MOG.A`（自动转 `MOG-A`） |
| `exchange` | 交易所 | 仅作记录 |
| `major` | 大类 | 本看板统一为 `国防航空航天` |
| `sub` | 小类 | 如 `航空航天国防` / `通讯设备` / `电信服务` / `软件基础设施` |
| `benchmark` | 对标 ETF | `ITA` / `XLK` / `SPY` / `QQQ`，决定「大盘过滤」用哪个。**显式指定，不再自动推断**；留空则回退 `SPY` 并在日志提示 |

**应用内添加（不必手写 CSV）**：网页「大类」筛选行右侧有 **＋ 添加股票** 按钮，填好代码/交易所/对标ETF/大类/小类后「加入待添加」，它会生成完整的新 `config.csv` 并给出「在 GitHub 编辑 config.csv」直达链接（部署在 GitHub Pages 时自动识别仓库）——粘贴覆盖、提交即自动重算。

自动处理的部分：
- **公司名**：从 Yahoo 自动抓取（无需填）。
- **风险参数**：可亏限额默认 `$25`、突破确认默认 `1%`（在 `engine/build.py` 顶部 `RISK_DEFAULT` / `BREAKOUT_DEFAULT` 调整；也可在 csv 加 `risk` / `breakout` 列单独覆盖）。

---

## 本地预览 / 手动重算

```bash
python engine/build.py            # 抓实时数据（Yahoo→Stooq），写 docs/data/latest.json
python engine/build.py --seed     # 离线模式，用 engine/seed_prices.json（你原表的历史数据）
cd docs && python -m http.server  # 然后浏览器打开 http://localhost:8000
```

---

## 网页能看什么

- **总览**：所有股票一行一只，列与原表「总览」tab 对应；可按任意列排序、按类别筛选、搜索。ENTER 行高亮。
- **信号**：只看 ENTER 的股票（对应原表「信号」tab）。
- **点任意一行**：弹出详情，等同原表的单只股票 tab —— 汇总区、入场阶梯图、收盘价/买入区间/吊灯止损走势图，以及**完整的逐日计算表**（可往回翻每一天的每个中间值）。

---

## 几点说明 / 与原表的差异

- **ER22 / ER55 的分母**：原表公式分母用的是 **开盘价（Open）列**的逐日变化之和，而分子用收盘价。
  这里**严格照搬**了原表的算法（所以数字与你表里一致）。如果本意是 Kaufman 效率比（分母也该用收盘价），
  告诉我，我改成 `Close`。
- **「止损」显示值**：汇总区/总览里的「止损」用的是当日吊灯**候选值 Chand_Cand**（与原表 H4 一致），
  而走势图里画的红色虚线是**随价格上移的 trail**（Chand_Trail）。两者原表都有，按需看。
- **追高提示**：原表里「ATR 自身波动 / 偏离不要太大」并不是 ENTER 的硬条件，只是肉眼判断。
  网页里把 `ATR自身波动 ≥ 60%` 或 `偏离 ≥ 4×ATR` 的格子标了 ⚠（仅提示，不拦截）。阈值想改可在
  `docs/app.js` 顶部的 `DEV_HI` / `SELFVOL_HI` 调整，或告诉我你想要的数值。
- 仅供研究，非投资建议。
```
