#!/usr/bin/env python3
"""
Multi-year signal replay for the trend tracker.

WHY THIS EXISTS
    The daily build keeps only LOOKBACK_DAYS (~290) bars per ticker, so the site can
    stay small. That is too short to judge a rule. This script fetches a much longer
    history, replays every ENTER signal, and commits only the RESULTING TRADE LIST
    (a few hundred KB) instead of the raw bars (hundreds of MB). Any later analysis
    then reads that small file — no re-downloading.

WHAT IT DOES
    1. read config.csv  ->  tickers + their benchmark ETF
    2. fetch N years of daily bars (Yahoo, Stooq fallback) for the benchmarks
    3. fetch N years for every ticker, run the SAME engine as production
       (indicators.compute_stock) so the backtest can't drift from the live model
    4. replay trades:  enter at the signal day's close
                       stop = entry-anchored ratchet of the chandelier candidate
                       exit on the first close below that stop
                       R = (exit - entry) / r0
                       one open position per ticker at a time
    5. write docs/data/backtest/trades.csv  (+ breadth.csv, + a printed report)

READ THE CAVEATS BEFORE TRUSTING ANY NUMBER
    * Survivorship / selection bias: config.csv is TODAY's universe. Names that were
      delisted or that you dropped are absent, and the list itself was partly chosen
      with hindsight. This inflates results — treat absolute PF as optimistic and
      compare buckets against EACH OTHER instead.
    * Yahoo prices are split/dividend adjusted; older bars can be revised.
    * Entry at the signal close assumes you could actually fill there.
    * Earnings gaps: a real fill can be far below the stop, so realised losses are
      worse than the 1R this script assumes.

USAGE
    python engine/backtest.py                 # default 5 years
    python engine/backtest.py --years 3
    python engine/backtest.py --years 5 --limit 50     # quick smoke test
"""
import argparse, csv, json, os, sys, time, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from indicators import compute_benchmark, compute_stock          # noqa: E402
import build as B                                                # noqa: E402

OUT_DIR = os.path.join(ROOT, "docs", "data", "backtest")

# thresholds mirrored from docs/app.js so the report speaks the same language
TIER = {"er22Good": 0.25, "er22Bad": 0.15, "er55High": 0.20, "freshBad": 3.0}


# ---------------------------------------------------------------- fetching
def fetch_long(ticker, years):
    """Like build.fetch_yahoo but without the short lookback window."""
    sym = B.yahoo_symbol(ticker)
    p2 = int(time.time()) + 86400
    p1 = p2 - int(years * 366) * 86400
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = (f"https://{host}/v8/finance/chart/{sym}"
               f"?period1={p1}&period2={p2}&interval=1d&includePrePost=false")
        try:
            data = json.loads(B._get(url))
            res = (data.get("chart", {}).get("result") or [None])[0]
            if not res:
                continue
            ts = res.get("timestamp") or []
            q = (res.get("indicators", {}).get("quote") or [{}])[0]
            o, h, l, c = q.get("open"), q.get("high"), q.get("low"), q.get("close")
            v = q.get("volume")
            rows = []
            for i, t in enumerate(ts):
                if c[i] is None:
                    continue
                d = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
                rows.append([d, B._f(o[i], c[i]), B._f(h[i], c[i]),
                             B._f(l[i], c[i]), float(c[i]), B._f(v[i], 0)])
            if rows:
                rows.sort(key=lambda r: r[0])
                while rows and B._is_partial_today(rows[-1][0]):
                    rows.pop()
                return rows
        except Exception:
            continue
    return []


# ---------------------------------------------------------------- features
def hi_age_at(closes, i, window=55):
    """Trading days since the highest close of the prior `window` bars (1 = yesterday)."""
    if i < window:
        return None
    w = closes[i - window:i]
    hi = max(w)
    last = len(w) - 1 - w[::-1].index(hi)
    return window - last


def tier_of(er22, er55, fresh):
    if fresh is not None and fresh >= TIER["freshBad"]:
        return "weak"
    good22 = er22 is not None and er22 >= TIER["er22Good"]
    bad22 = er22 is not None and er22 < TIER["er22Bad"]
    high55 = er55 is not None and er55 >= TIER["er55High"]
    if good22 and not high55:
        return "strong"
    if bad22 and high55:
        return "weak"
    return "mid"


def replay(ticker, rows):
    """Yield one dict per trade taken on this ticker."""
    closes = [r["close"] for r in rows]
    n = len(rows)
    i = 0
    while i < n:
        r = rows[i]
        if (r.get("enter") != "ENTER" or not r.get("r0") or r["r0"] <= 0
                or r.get("cand") is None):
            i += 1
            continue
        entry, r0 = r["close"], r["r0"]
        stop = r["cand"]
        atr = r.get("atr14")
        fresh = ((r["hc55"] - r["hc22"]) / atr
                 if (atr and r.get("hc55") is not None and r.get("hc22") is not None)
                 else None)
        if fresh is not None:
            fresh = max(0.0, fresh)
        dd = ((r["hc55"] - r["hc22"]) / r["hc55"]
              if (r.get("hc55") and r.get("hc22") is not None) else None)

        j, ex, peak = i + 1, None, entry
        while j < n:
            c = rows[j].get("cand")
            if c is not None and c > stop:
                stop = c                          # ratchet, anchored at entry
            peak = max(peak, rows[j]["close"])
            if rows[j]["close"] < stop:
                ex = j
                break
            j += 1

        closed = ex is not None
        exit_px = rows[ex]["close"] if closed else rows[-1]["close"]
        yield {
            "ticker": ticker,
            "signal_date": r["date"],
            "exit_date": rows[ex]["date"] if closed else "",
            "closed": int(closed),
            "entry": round(entry, 4),
            "exit": round(exit_px, 4),
            "r0": round(r0, 4),
            "R": round((exit_px - entry) / r0, 3),
            "move_pct": round((exit_px - entry) / entry * 100, 2),
            "peak_pct": round((peak - entry) / entry * 100, 2),
            "held": (ex if closed else n - 1) - i,
            "r0_pct": round(r0 / entry * 100, 3),
            "er22": r.get("er22"), "er55": r.get("er55"),
            "fresh": round(fresh, 3) if fresh is not None else None,
            "dd_pct": round(dd * 100, 2) if dd is not None else None,
            "hi_age": hi_age_at(closes, i),
            "atr_pct": round(r["atrpct"] * 100, 3) if r.get("atrpct") is not None else None,
            "dev": r.get("dev"), "selfvol": r.get("selfvol"),
            "tier": tier_of(r.get("er22"), r.get("er55"), fresh),
        }
        i = (ex + 1) if closed else n


# ---------------------------------------------------------------- reporting
def stats(rs):
    rs = [x for x in rs if x is not None]
    if not rs:
        return None
    wins = [x for x in rs if x > 0]
    loss = -sum(x for x in rs if x <= 0)
    rs_sorted = sorted(rs)
    med = (rs_sorted[len(rs) // 2] if len(rs) % 2
           else (rs_sorted[len(rs) // 2 - 1] + rs_sorted[len(rs) // 2]) / 2)
    return {"n": len(rs), "win": len(wins) / len(rs) * 100,
            "avg": sum(rs) / len(rs), "med": med,
            "pf": (sum(wins) / loss) if loss else float("inf")}


def table(title, trades, key, edges, fmt="{:.2f}"):
    print(f"\n--- {title} ---")
    print(f"{'bucket':<14}{'n':>6}{'win%':>8}{'avgR':>8}{'medR':>8}{'PF':>7}")
    lo = None
    for e in edges + [None]:
        if e is None:
            sel = [t for t in trades if t[key] is not None and t[key] >= lo]
            lab = ">=" + fmt.format(lo)
        elif lo is None:
            sel = [t for t in trades if t[key] is not None and t[key] < e]
            lab = "<" + fmt.format(e)
        else:
            sel = [t for t in trades if t[key] is not None and lo <= t[key] < e]
            lab = fmt.format(lo) + "~" + fmt.format(e)
        s = stats([t["R"] for t in sel])
        if s and s["n"] >= 20:
            print(f"{lab:<14}{s['n']:>6}{s['win']:>7.1f}%{s['avg']:>8.2f}"
                  f"{s['med']:>8.2f}{s['pf']:>7.2f}")
        else:
            print(f"{lab:<14}{(s['n'] if s else 0):>6}   (too few)")
        lo = e


def report(trades):
    closed = [t for t in trades if t["closed"]]
    print("\n" + "=" * 66)
    print(f"TRADES {len(trades)}  closed {len(closed)}  still open {len(trades)-len(closed)}")
    if closed:
        d0 = min(t["signal_date"] for t in closed)
        d1 = max(t["signal_date"] for t in closed)
        print(f"signal dates {d0} .. {d1}")
        s = stats([t["R"] for t in closed])
        print(f"overall: win {s['win']:.1f}%  avgR {s['avg']:.2f}  "
              f"medR {s['med']:.2f}  PF {s['pf']:.2f}  totalR {sum(t['R'] for t in closed):.0f}")
    print("=" * 66)

    print("\n--- by structure tier ---")
    print(f"{'tier':<14}{'n':>6}{'win%':>8}{'avgR':>8}{'medR':>8}{'PF':>7}{'totalR':>9}")
    for k in ("strong", "mid", "weak"):
        sel = [t for t in closed if t["tier"] == k]
        s = stats([t["R"] for t in sel])
        if s:
            print(f"{k:<14}{s['n']:>6}{s['win']:>7.1f}%{s['avg']:>8.2f}"
                  f"{s['med']:>8.2f}{s['pf']:>7.2f}{sum(t['R'] for t in sel):>9.0f}")

    table("ER22 at signal", closed, "er22", [0.15, 0.25, 0.35])
    table("ER55 at signal", closed, "er55", [0.05, 0.10, 0.20])
    table("breakout freshness (nATR)", closed, "fresh", [0.5, 1.5, 3.0], "{:.1f}")
    table("ATR% at signal", closed, "atr_pct", [2.5, 4.0, 6.0], "{:.1f}")
    table("R0/price %", closed, "r0_pct", [5, 8, 12], "{:.0f}")
    table("days since 55d high", closed, "hi_age", [5, 15, 35], "{:.0f}")

    # split-half stability: the single most useful overfitting check
    ds = sorted(t["signal_date"] for t in closed)
    if ds:
        mid = ds[len(ds) // 2]
        print(f"\n--- split-half stability (cut at {mid}) ---")
        print(f"{'tier':<14}{'first n':>9}{'first PF':>10}{'second n':>10}{'second PF':>11}")
        for k in ("strong", "mid", "weak"):
            a = stats([t["R"] for t in closed if t["tier"] == k and t["signal_date"] < mid])
            b = stats([t["R"] for t in closed if t["tier"] == k and t["signal_date"] >= mid])
            fa = f"{a['pf']:.2f}" if a and a["n"] >= 20 else "-"
            fb = f"{b['pf']:.2f}" if b and b["n"] >= 20 else "-"
            print(f"{k:<14}{(a['n'] if a else 0):>9}{fa:>10}"
                  f"{(b['n'] if b else 0):>10}{fb:>11}")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=float, default=5.0)
    ap.add_argument("--limit", type=int, default=0, help="only N tickers (smoke test)")
    ap.add_argument("--sleep", type=float, default=0.12)
    args = ap.parse_args()

    cfg = B.read_config()
    if args.limit:
        cfg = cfg[:args.limit]
    print(f"config: {len(cfg)} tickers, fetching ~{args.years} years each")

    # 1) benchmarks
    bms = sorted({c["benchmark"] for c in cfg if c.get("benchmark")})
    bench_ok, bench_series = {}, {}
    for i, bm in enumerate(bms, 1):
        rows = fetch_long(bm, args.years)
        if not rows:
            sys.stderr.write(f"[bench] {bm} no data\n")
            continue
        series = compute_benchmark([[r[0], r[4]] for r in rows])
        bench_ok[bm] = {d["date"]: d["ok"] for d in series if d["ok"] is not None}
        bench_series[bm] = series
        time.sleep(args.sleep)
    print(f"benchmarks ok: {len(bench_ok)}/{len(bms)}")

    # 2) stocks
    trades, breadth_hits, done, nodata = [], {}, 0, 0
    for c in cfg:
        ohlcv = fetch_long(c["ticker"], args.years)
        time.sleep(args.sleep)
        if len(ohlcv) < 120:
            nodata += 1
            continue
        rows, _ = compute_stock(ohlcv, bench_ok.get(c["benchmark"], {}),
                                risk=c["risk"], breakout=c["breakout"])
        for t in replay(c["ticker"], rows):
            trades.append(t)
        for r in rows:                        # daily breadth = share of mktok True
            if r.get("mktok") is not None:
                a, b = breadth_hits.setdefault(r["date"], [0, 0])
                breadth_hits[r["date"]] = [a + (1 if r["mktok"] else 0), b + 1]
        done += 1
        if done % 50 == 0:
            print(f"  ...{done}/{len(cfg)} tickers, {len(trades)} trades so far")
    print(f"processed {done} tickers ({nodata} without usable data), {len(trades)} trades")

    # 3) write compact outputs
    os.makedirs(OUT_DIR, exist_ok=True)
    cols = ["ticker", "signal_date", "exit_date", "closed", "entry", "exit", "r0", "R",
            "move_pct", "peak_pct", "held", "r0_pct", "er22", "er55", "fresh",
            "dd_pct", "hi_age", "atr_pct", "dev", "selfvol", "tier"]
    tp = os.path.join(OUT_DIR, "trades.csv")
    with open(tp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for t in sorted(trades, key=lambda x: (x["signal_date"], x["ticker"])):
            w.writerow(t)
    bp = os.path.join(OUT_DIR, "breadth.csv")
    with open(bp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "ok", "total", "breadth"])
        for d in sorted(breadth_hits):
            ok, tot = breadth_hits[d]
            w.writerow([d, ok, tot, round(ok / tot, 4) if tot else ""])
    meta = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "years": args.years, "tickers": done, "trades": len(trades),
            "tier_thresholds": TIER}
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"wrote {tp} ({os.path.getsize(tp)//1024} KB), "
          f"{bp} ({os.path.getsize(bp)//1024} KB)")

    report(trades)
    print("\nNOTE: config.csv is today's universe, so these numbers carry "
          "survivorship/selection bias. Compare buckets to each other, not to 1.0.")


if __name__ == "__main__":
    main()
