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
    * EXIT FILL: trades.csv exits at the SAME close that broke the stop. You only
      learn that at the close, so this needs a market-on-close order and is
      optimistic without one. The EXECUTION-MODE COMPARISON printed at the end of
      a run prices that assumption against fills you can actually get.

USAGE
    python engine/backtest.py                 # default 5 years
    python engine/backtest.py --years 3
    python engine/backtest.py --years 5 --limit 50     # quick smoke test
    python engine/backtest.py --stop-grid     # + every stop-rule variant

OUTPUTS
    trades.csv  full trade list for the production rule (now also carries MAE,
                peak_R and the breadth regime at the signal)
    breadth.csv daily share of tickers whose benchmark was OK
    modes.csv   the execution-mode table, which used to exist only in the log
    stops.csv   the stop-rule table (--stop-grid only)
    meta.json
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


# ------------------------------------------------------------- stop rules
# A stop rule is (anchor, k):
#   anchor  'hc55'   hang the chandelier from the rolling 55-day highest close
#                    (production behaviour: the anchor keeps moving with the
#                    window, so it can be a high set weeks before you entered)
#           'entry'  hang it from the highest close SINCE ENTRY, LeBeau's
#                    original formulation. On the signal day the anchor IS the
#                    entry close, so the initial gap is exactly k*ATR.
#   k       float    fixed multiple, the industry default
#           'step'   production's 3 / 3.5 / 4 ladder on ATR%
#           'interp' the same ladder made continuous (no 0.5*ATR jump at the
#                    2.5% and 5% boundaries)
#
# Every rule is scored on the SAME signal set (production's ENTER days) so the
# only thing changing is the exit. That means the `cand < minentry` veto still
# uses the production stop even for entry-anchored rules — deliberate, so the
# comparison isolates one variable.
STOP_RULES = {
    "0_prod_hc55_step":  ("hc55",  "step"),
    "1_hc55_interp":     ("hc55",  "interp"),
    "2_hc55_k3.0":       ("hc55",  3.0),
    "3_hc55_k3.5":       ("hc55",  3.5),
    "4_hc55_k4.0":       ("hc55",  4.0),
    "5_hc55_k4.5":       ("hc55",  4.5),
    "6_entry_k2.0":      ("entry", 2.0),
    "7_entry_k2.5":      ("entry", 2.5),
    "8_entry_k3.0":      ("entry", 3.0),
    "9_entry_k3.5":      ("entry", 3.5),
    "A_entry_k4.0":      ("entry", 4.0),
    "B_entry_k5.0":      ("entry", 5.0),
}
PROD_RULE = "0_prod_hc55_step"

# breadth regimes, mirrored from the UI pill
def regime_of(b):
    if b is None:
        return "unknown"
    return "bull" if b >= 0.60 else ("neutral" if b >= 0.45 else "bear")


def stop_mult(k, row):
    """Resolve a rule's k for one bar."""
    if k == "step":
        return row.get("mult")
    if k == "interp":
        a = row.get("atrpct")
        if a is None:
            return None
        return min(4.0, max(3.0, 3.0 + (a - 0.025) / 0.025))
    return k


# --------------------------------------------------------- execution modes
# Each mode answers "what could I ACTUALLY have got?", not "what does the
# ideal model say?".
#   trigger  'close'    exit judged on the daily close
#            'low'      exit judged on the intraday low (a resting broker stop)
#   fill     'close'    fill at the triggering day's close   <- needs an MOC order
#            'nextopen' fill at the NEXT session's open      <- decide tonight, sell at the open
#            'stop'     fill at the stop price, or the open if it gapped straight through
#   stop_ref 'same'     compare against the stop AFTER today's ratchet  <- model
#            'prev'     compare against the stop the app published LAST night  <- reality
MODES = {
    "A_close_close":        ("close", "close",    "same"),
    "B_close_nextopen":     ("close", "nextopen", "same"),
    "C_close_nextopen_prev": ("close", "nextopen", "prev"),
    "D_intraday_stop":      ("low",   "stop",     "prev"),
    "E_close_close_prev":   ("close", "close",    "prev"),
}
BASELINE = "A_close_close"


def replay(ticker, rows, trigger="close", fill="close", stop_ref="same",
           stop_rule=PROD_RULE):
    """Yield one dict per trade taken on this ticker, under one execution mode."""
    anchor_mode, kspec = STOP_RULES[stop_rule]
    closes = [r["close"] for r in rows]
    n = len(rows)
    i = 0
    while i < n:
        r = rows[i]
        if (r.get("enter") != "ENTER" or not r.get("r0") or r["r0"] <= 0
                or r.get("cand") is None):
            i += 1
            continue

        def cand_of(row, anchor):
            """Chandelier candidate for this rule on one bar."""
            if stop_rule == PROD_RULE:
                return row.get("cand")     # reuse indicators' own value verbatim
            a14 = row.get("atr14")
            k = stop_mult(kspec, row)
            if a14 is None or k is None or anchor is None:
                return None
            return anchor - k * a14

        entry = r["close"]
        run_hi = entry                     # highest close since entry, inclusive
        anchor0 = r.get("hc55") if anchor_mode == "hc55" else run_hi
        stop = cand_of(r, anchor0)
        maxe = r.get("maxentry")
        if stop_rule == PROD_RULE:
            r0 = r["r0"]
        else:
            r0 = (maxe - stop) if (maxe is not None and stop is not None) else None
        if stop is None or not r0 or r0 <= 0:
            i += 1
            continue
        atr = r.get("atr14")
        fresh = ((r["hc55"] - r["hc22"]) / atr
                 if (atr and r.get("hc55") is not None and r.get("hc22") is not None)
                 else None)
        if fresh is not None:
            fresh = max(0.0, fresh)
        dd = ((r["hc55"] - r["hc22"]) / r["hc55"]
              if (r.get("hc55") and r.get("hc22") is not None) else None)

        j, ex, peak = i + 1, None, entry
        mae_c, mae_l = entry, entry               # worst close / worst low while held
        hit_stop = None                           # stop level that produced the exit
        while j < n:
            stop_prev = stop                      # what the app published last night
            run_hi = max(run_hi, rows[j]["close"])
            anchor = rows[j].get("hc55") if anchor_mode == "hc55" else run_hi
            c = cand_of(rows[j], anchor)
            if c is not None and c > stop:
                stop = c                          # ratchet, anchored at entry
            peak = max(peak, rows[j]["close"])
            mae_c = min(mae_c, rows[j]["close"])
            mae_l = min(mae_l, rows[j]["low"])

            level = stop_prev if stop_ref == "prev" else stop
            px = rows[j]["low"] if trigger == "low" else rows[j]["close"]
            if px < level:
                ex, hit_stop = j, level
                break
            j += 1

        closed = ex is not None
        if not closed:
            exit_px = rows[-1]["close"]
        elif fill == "nextopen":
            # decided on tonight's close, sold at tomorrow's open. If the
            # trigger is the very last bar there is no next open yet, so the
            # trade stays open rather than inventing a fill.
            if ex + 1 < n:
                exit_px = rows[ex + 1]["open"]
            else:
                closed, ex, exit_px = False, None, rows[-1]["close"]
        elif fill == "stop":
            # a resting stop becomes a market order: you get the stop price
            # unless the session already opened below it.
            exit_px = min(hit_stop, rows[ex]["open"])
        else:
            exit_px = rows[ex]["close"]
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
            "peak_R": round((peak - entry) / r0, 3),
            # Maximum Adverse Excursion: how far the trade went against you
            # before it worked. In R and in ATR-at-entry units.
            "mae_R": round((mae_c - entry) / r0, 3),
            "mae_low_R": round((mae_l - entry) / r0, 3),
            "mae_atr": round((entry - mae_c) / atr, 3) if atr else None,
            "mae_low_atr": round((entry - mae_l) / atr, 3) if atr else None,
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


def agg(ts):
    """One summary row for a list of closed trades."""
    s = stats([t["R"] for t in ts])
    if not s:
        return None
    tot = sum(t["R"] for t in ts)
    pk = sum(t["peak_R"] for t in ts if t.get("peak_R") is not None)
    return {"n": s["n"], "win_pct": round(s["win"], 1), "avgR": round(s["avg"], 3),
            "medR": round(s["med"], 3), "pf": round(s["pf"], 3), "totalR": round(tot, 1),
            "avg_held": round(sum(t["held"] for t in ts) / len(ts), 1),
            "avg_r0_pct": round(sum(t["r0_pct"] for t in ts) / len(ts), 2),
            "peakR": round(pk, 1),
            "give_back_pct": round((pk - tot) / pk * 100, 1) if pk > 0 else None}


def write_rows(path, rows, cols):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"wrote {path} ({len(rows)} rows)")


def compare_modes(by_mode):
    """The point of this table: how much of the modelled edge survives execution."""
    print("\n" + "=" * 84)
    print("EXECUTION-MODE COMPARISON  (same signals, same stops, different fills)")
    print("=" * 84)
    print(f"{'mode':<24}{'closed':>7}{'win%':>8}{'avgR':>8}{'medR':>8}"
          f"{'PF':>7}{'totalR':>9}{'avg held':>10}")
    base = None
    for name in MODES:
        ts = [t for t in by_mode[name] if t["closed"]]
        s = stats([t["R"] for t in ts])
        if not s:
            continue
        tot = sum(t["R"] for t in ts)
        held = sum(t["held"] for t in ts) / len(ts)
        print(f"{name:<24}{s['n']:>7}{s['win']:>7.1f}%{s['avg']:>8.2f}"
              f"{s['med']:>8.2f}{s['pf']:>7.2f}{tot:>9.0f}{held:>10.1f}")
        if name == BASELINE:
            base = (s["pf"], tot, s["n"])
    if base:
        print("-" * 84)
        print(f"{'vs baseline ' + BASELINE:<24}{'dPF':>15}{'dTotalR':>12}{'dExits':>10}")
        for name in MODES:
            if name == BASELINE:
                continue
            ts = [t for t in by_mode[name] if t["closed"]]
            s = stats([t["R"] for t in ts])
            if not s:
                continue
            tot = sum(t["R"] for t in ts)
            print(f"{name:<24}{s['pf'] - base[0]:>+15.2f}"
                  f"{tot - base[1]:>+12.0f}{s['n'] - base[2]:>+10d}")
    print("\nHow to read it:")
    print("  C vs A = what your real workflow costs against the modelled number.")
    print("  D vs C = intraday broker stop vs decide-on-close, sell-at-open.")
    print("  E vs A = the effect of using LAST NIGHT's published stop, on its own.")
    print("=" * 84)


def compare_stops(by_rule):
    """Anchor and k, scored on identical signals under one execution mode."""
    out = []
    print("\n" + "=" * 100)
    print("STOP-RULE COMPARISON  (same ENTER days, same fills, different stop)")
    print("=" * 100)
    hdr = (f"{'rule':<20}{'closed':>7}{'win%':>7}{'avgR':>7}{'medR':>7}{'PF':>7}"
           f"{'totalR':>9}{'held':>7}{'R0%':>7}{'giveback':>10}")
    print(hdr)
    for name in STOP_RULES:
        ts = [t for t in by_rule[name] if t["closed"]]
        a = agg(ts)
        if not a:
            continue
        out.append(dict(rule=name, anchor=STOP_RULES[name][0],
                        k=STOP_RULES[name][1], regime="all", **a))
        print(f"{name:<20}{a['n']:>7}{a['win_pct']:>6.1f}%{a['avgR']:>7.2f}"
              f"{a['medR']:>7.2f}{a['pf']:>7.2f}{a['totalR']:>9.0f}"
              f"{a['avg_held']:>7.0f}{a['avg_r0_pct']:>7.1f}"
              f"{(a['give_back_pct'] or 0):>9.1f}%")

    # the same table split by breadth regime — the only split that has ever
    # reversed a conclusion in this project, so it is not optional
    for reg in ("bull", "neutral", "bear"):
        print(f"\n--- breadth regime: {reg} ---")
        print(hdr)
        for name in STOP_RULES:
            ts = [t for t in by_rule[name] if t["closed"] and t.get("regime") == reg]
            a = agg(ts)
            if not a:
                continue
            out.append(dict(rule=name, anchor=STOP_RULES[name][0],
                            k=STOP_RULES[name][1], regime=reg, **a))
            flag = "" if a["n"] >= 50 else "  (thin)"
            print(f"{name:<20}{a['n']:>7}{a['win_pct']:>6.1f}%{a['avgR']:>7.2f}"
                  f"{a['medR']:>7.2f}{a['pf']:>7.2f}{a['totalR']:>9.0f}"
                  f"{a['avg_held']:>7.0f}{a['avg_r0_pct']:>7.1f}"
                  f"{(a['give_back_pct'] or 0):>9.1f}%{flag}")

    # and by ATR% tier, because that is where the step function was supposed to help
    print("\n--- ATR% at signal: does a fixed k lose anything the ladder gained? ---")
    print(f"{'rule':<20}{'<2.5 PF':>10}{'2.5-4 PF':>10}{'4-6 PF':>10}{'>=6 PF':>10}")
    for name in STOP_RULES:
        ts = [t for t in by_rule[name] if t["closed"] and t["atr_pct"] is not None]
        cells = []
        for lo, hi in ((0, 2.5), (2.5, 4), (4, 6), (6, 1e9)):
            s = stats([t["R"] for t in ts if lo <= t["atr_pct"] < hi])
            cells.append(f"{s['pf']:.2f}" if s and s["n"] >= 30 else "-")
        print(f"{name:<20}" + "".join(f"{c:>10}" for c in cells))
    print("=" * 100)
    return out


def mae_report(trades):
    """
    Where to put k, from the data instead of from taste (Sweeney's MAE method):
    look at how far the WINNERS dipped before they worked, and set the stop
    outside that. The percentile you choose is the share of winners you accept
    killing.

    CEILING WARNING: these paths were already truncated by the stop that was in
    force, so the distribution can only tell you k is too WIDE, never that it is
    too narrow. Use the entry_k grid above for the wide side.
    """
    win = [t for t in trades if t["closed"] and t["R"] > 0 and t.get("mae_atr") is not None]
    if len(win) < 50:
        print("\n--- MAE calibration: too few winners ---")
        return
    print("\n" + "=" * 66)
    print(f"MAE OF WINNING TRADES  (n={len(win)})  — units of ATR at entry")
    print("=" * 66)
    for key, lab in (("mae_atr", "on closes"), ("mae_low_atr", "on intraday lows")):
        v = sorted(t[key] for t in win if t.get(key) is not None)
        if not v:
            continue
        def q(p):
            return v[min(len(v) - 1, int(p * len(v)))]
        print(f"{lab:<18}" + "  ".join(
            f"p{int(p*100)}={q(p):.2f}" for p in (0.5, 0.75, 0.9, 0.95, 0.99)))
    print("\nRead: an entry-anchored stop at k*ATR kills the winners whose MAE "
          "exceeded k.\np90 on closes is the usual starting point for k.")
    print("=" * 66)


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
    ap.add_argument("--stop-grid", action="store_true",
                    help="also replay every STOP_RULES variant and write stops.csv")
    ap.add_argument("--grid-mode", default="C_close_nextopen_prev",
                    choices=list(MODES),
                    help="execution mode used to score the stop grid "
                         "(default C = your actual evening workflow)")
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

    # 2) stocks — one download, replayed under every execution mode
    by_mode = {name: [] for name in MODES}
    by_rule = {name: [] for name in STOP_RULES} if args.stop_grid else None
    gtrig, gfill, gsref = MODES[args.grid_mode]
    breadth_hits, done, nodata = {}, 0, 0
    for c in cfg:
        ohlcv = fetch_long(c["ticker"], args.years)
        time.sleep(args.sleep)
        if len(ohlcv) < 120:
            nodata += 1
            continue
        rows, _ = compute_stock(ohlcv, bench_ok.get(c["benchmark"], {}),
                                risk=c["risk"], breakout=c["breakout"])
        for name, (trig, fill, sref) in MODES.items():
            for t in replay(c["ticker"], rows, trig, fill, sref):
                by_mode[name].append(t)
        if by_rule is not None:
            for name in STOP_RULES:
                for t in replay(c["ticker"], rows, gtrig, gfill, gsref,
                                stop_rule=name):
                    by_rule[name].append(t)
        for r in rows:                        # daily breadth = share of mktok True
            if r.get("mktok") is not None:
                a, b = breadth_hits.setdefault(r["date"], [0, 0])
                breadth_hits[r["date"]] = [a + (1 if r["mktok"] else 0), b + 1]
        done += 1
        if done % 50 == 0:
            print(f"  ...{done}/{len(cfg)} tickers, "
                  f"{len(by_mode[BASELINE])} trades so far")
    trades = by_mode[BASELINE]        # baseline is what gets committed, as before
    print(f"processed {done} tickers ({nodata} without usable data), {len(trades)} trades")

    # 2b) breadth per day, then stamp each trade with the regime at its signal
    breadth_by_date = {d: (v[0] / v[1] if v[1] else None)
                       for d, v in breadth_hits.items()}
    for bucket in ([by_mode[k] for k in by_mode]
                   + ([by_rule[k] for k in by_rule] if by_rule else [])):
        for t in bucket:
            t["breadth"] = (round(breadth_by_date.get(t["signal_date"]), 4)
                            if breadth_by_date.get(t["signal_date"]) is not None
                            else None)
            t["regime"] = regime_of(breadth_by_date.get(t["signal_date"]))

    # 3) write compact outputs
    os.makedirs(OUT_DIR, exist_ok=True)
    cols = ["ticker", "signal_date", "exit_date", "closed", "entry", "exit", "r0", "R",
            "move_pct", "peak_pct", "peak_R", "held", "r0_pct", "er22", "er55", "fresh",
            "dd_pct", "hi_age", "atr_pct", "dev", "selfvol", "tier",
            "mae_R", "mae_low_R", "mae_atr", "mae_low_atr", "breadth", "regime"]
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
            "tier_thresholds": TIER,
            "exec_mode": BASELINE,
            "exec_mode_note": "trades.csv fills at the triggering day's close, "
                              "which needs a market-on-close order. See the "
                              "EXECUTION-MODE COMPARISON in the run log."}
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"wrote {tp} ({os.path.getsize(tp)//1024} KB), "
          f"{bp} ({os.path.getsize(bp)//1024} KB)")

    # modes.csv — previously the mode table only ever went to the Actions log,
    # so the comparison could not be reread without a full re-run.
    mrows = []
    for name in MODES:
        a = agg([t for t in by_mode[name] if t["closed"]])
        if a:
            mrows.append(dict(mode=name, trigger=MODES[name][0], fill=MODES[name][1],
                              stop_ref=MODES[name][2], regime="all", **a))
        for reg in ("bull", "neutral", "bear"):
            a = agg([t for t in by_mode[name]
                     if t["closed"] and t.get("regime") == reg])
            if a:
                mrows.append(dict(mode=name, trigger=MODES[name][0],
                                  fill=MODES[name][1], stop_ref=MODES[name][2],
                                  regime=reg, **a))
    write_rows(os.path.join(OUT_DIR, "modes.csv"), mrows,
               ["mode", "trigger", "fill", "stop_ref", "regime", "n", "win_pct",
                "avgR", "medR", "pf", "totalR", "avg_held", "avg_r0_pct",
                "peakR", "give_back_pct"])

    compare_modes(by_mode)
    if by_rule is not None:
        srows = compare_stops(by_rule)
        write_rows(os.path.join(OUT_DIR, "stops.csv"), srows,
                   ["rule", "anchor", "k", "regime", "n", "win_pct", "avgR",
                    "medR", "pf", "totalR", "avg_held", "avg_r0_pct", "peakR",
                    "give_back_pct"])
        print(f"(stop grid scored under execution mode {args.grid_mode})")
    mae_report(trades)
    report(trades)
    print("\nNOTE: config.csv is today's universe, so these numbers carry "
          "survivorship/selection bias. Compare buckets to each other, not to 1.0.")


if __name__ == "__main__":
    main()
