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
    python engine/backtest.py --stop-grid --boot 1500   # tighter intervals, slower

OUTPUTS
    trades.csv  full trade list for the production rule (now also carries MAE,
                peak_R and the breadth regime at the signal)
    breadth.csv daily share of tickers whose benchmark was OK
    modes.csv   the execution-mode table, which used to exist only in the log
    stops.csv   the stop-rule table with bootstrap 95% intervals on PF and
                R-per-slot-day (--stop-grid only)

READING THE STOP GRID
    Two things went wrong on the previous run and both are now guarded:
    * PF was compared as a point estimate. A 393-trade bucket whose PF moves
      from 0.66 to 4.75 on a 0.5 change in k was read as a finding when it was
      ~10 trades. Every PF now ships with a block-bootstrap interval, and cells
      whose interval is wider than 1.0 are marked ! because they cannot be read.
    * PF was treated as the objective. It is not: the scarce resource is the
      ~22 position slots, so the objective is R per slot-day. A rule can win on
      PF and still lose money per unit of capital-time. Both are printed.
    meta.json
"""
import argparse, csv, json, os, random, sys, time, urllib.request
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
# A stop rule is (anchor, k_trail, k_init):
#   anchor   'hc55'   hang the trailing chandelier from the rolling 55-day
#                     highest close (production). The anchor keeps moving with
#                     the window, so it can be a high set weeks before entry,
#                     which means the same k buys a DIFFERENT buffer on every
#                     trade.
#            'entry'  hang it from the highest close SINCE ENTRY, LeBeau's
#                     original. On the signal day the anchor IS the entry
#                     close, so the buffer is exactly k*ATR on every trade.
#   k_trail  float    fixed multiple
#            'step'   production's 3 / 3.5 / 4 ladder on ATR%
#            'interp' the same ladder made continuous
#   k_init   None     initial stop = the trailing formula on the signal day
#                     (this is what every rule did before)
#            float    initial stop = entry - k_init*ATR, held until the trail
#                     ratchets above it. Lets a TIGHT initial stop (small r0,
#                     high capital efficiency, justified by the MAE of winners)
#                     coexist with a WIDE trail (low give-back). One k cannot
#                     do both jobs; these two numbers answer different
#                     questions and the old grid forced them to be equal.
#
# Every rule is scored on the SAME signal set (production's ENTER days) so the
# only thing changing is the exit. The `cand < minentry` veto still uses the
# production stop even for entry-anchored rules — deliberate, so the comparison
# isolates one variable.
STOP_RULES = {
    "0_prod":            ("hc55",  "step",  None),
    # --- the two hc55 points that looked best last run, kept as controls
    "1_hc55_k4.0":       ("hc55",  4.0,     None),
    "2_hc55_k4.5":       ("hc55",  4.5,     None),
    # --- fine sweep around the unexplained k=3.5 hole. If PF is jagged at
    #     0.1 resolution the whole hc55 family is noise and no point on it
    #     can be trusted, including production's.
    "3_hc55_k3.4":       ("hc55",  3.4,     None),
    "4_hc55_k3.5":       ("hc55",  3.5,     None),
    "5_hc55_k3.6":       ("hc55",  3.6,     None),
    # --- single-k entry anchor, the monotone family, as controls
    "6_entry_k3.0":      ("entry", 3.0,     None),
    "7_entry_k4.0":      ("entry", 4.0,     None),
    "8_entry_k5.0":      ("entry", 5.0,     None),
    # --- the actual hypothesis: tight initial stop + wide trail
    "9_split_2.0_4.0":   ("entry", 4.0,     2.0),
    "A_split_2.2_4.0":   ("entry", 4.0,     2.2),
    "B_split_2.2_5.0":   ("entry", 5.0,     2.2),
    "C_split_2.5_4.0":   ("entry", 4.0,     2.5),
    "D_split_2.5_5.0":   ("entry", 5.0,     2.5),
    "E_split_3.0_5.0":   ("entry", 5.0,     3.0),
    # --- same split but trailing on hc55, to separate "tight initial stop"
    #     from "entry anchor" as two independent effects
    "F_split_2.2_hc55_4": ("hc55", 4.0,     2.2),
}
PROD_RULE = "0_prod"

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
    anchor_mode, kspec, k_init = STOP_RULES[stop_rule]
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
            """Trailing chandelier candidate for this rule on one bar."""
            if stop_rule == PROD_RULE:
                return row.get("cand")     # reuse indicators' own value verbatim
            a14 = row.get("atr14")
            k = stop_mult(kspec, row)
            if a14 is None or k is None or anchor is None:
                return None
            return anchor - k * a14

        entry = r["close"]
        run_hi = entry                     # highest close since entry, inclusive
        atr = r.get("atr14")
        maxe = r.get("maxentry")
        if k_init is not None:
            # separate initial stop; the trail takes over once it ratchets past
            stop = (entry - k_init * atr) if atr is not None else None
        else:
            anchor0 = r.get("hc55") if anchor_mode == "hc55" else run_hi
            stop = cand_of(r, anchor0)
        if stop_rule == PROD_RULE:
            r0 = r["r0"]
        else:
            r0 = (maxe - stop) if (maxe is not None and stop is not None) else None
        if stop is None or not r0 or r0 <= 0:
            i += 1
            continue
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


BOOT_N = 600          # bootstrap resamples; --boot overrides


def pf_ci(ts, n=BOOT_N, seed=0):
    """
    95% interval for PF by BLOCK bootstrap over tickers.

    Resampling individual trades would be wrong here: trades on the same ticker
    share a trend, a sector and a regime, so they are not independent draws and
    a per-trade bootstrap reports an interval that is far too tight. Resampling
    whole tickers keeps that clustering intact. It is also ~10x cheaper.

    Returns (lo, hi), or (None, None) if there is not enough to resample.
    """
    per = {}
    for t in ts:
        if t.get("R") is None:
            continue
        w, l = per.setdefault(t["ticker"], [0.0, 0.0])
        if t["R"] > 0:
            per[t["ticker"]][0] = w + t["R"]
        else:
            per[t["ticker"]][1] = l - t["R"]
    blocks = list(per.values())
    m = len(blocks)
    if m < 20:
        return (None, None)
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        W = L = 0.0
        for _ in range(m):
            w, l = blocks[rnd.randrange(m)]
            W += w
            L += l
        out.append((W / L) if L > 0 else 99.0)
    out.sort()
    return out[int(0.025 * n)], out[int(0.975 * n)]


def agg(ts, boot=True):
    """One summary row for a list of closed trades."""
    s = stats([t["R"] for t in ts])
    if not s:
        return None
    tot = sum(t["R"] for t in ts)
    pk = sum(t["peak_R"] for t in ts if t.get("peak_R") is not None)
    held = sum(t["held"] for t in ts) / len(ts)
    lo, hi = pf_ci(ts) if boot else (None, None)
    return {"n": s["n"], "win_pct": round(s["win"], 1), "avgR": round(s["avg"], 3),
            "medR": round(s["med"], 3), "pf": round(s["pf"], 3), "totalR": round(tot, 1),
            "pf_lo": round(lo, 3) if lo is not None else None,
            "pf_hi": round(hi, 3) if hi is not None else None,
            "pf_ci_width": round(hi - lo, 3) if lo is not None else None,
            "avg_held": round(held, 1),
            "avg_r0_pct": round(sum(t["r0_pct"] for t in ts) / len(ts), 2),
            # THE metric under a fixed number of position slots: a rule that
            # earns 0.4R in 60 days is worse than one earning 0.25R in 25 days,
            # because the slot is the scarce resource, not the trade.
            "R_per_1000_slot_days": round(s["avg"] / held * 1000, 2) if held else None,
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
    print("\n" + "=" * 108)
    print("STOP-RULE COMPARISON  (same ENTER days, same fills, different stop)")
    print("A PF with a wide 95% interval is not a measurement. Compare intervals,")
    print("not point estimates: if two rules' intervals overlap, they are tied.")
    print("R/1000sd = R per 1000 slot-days = avgR/held. THIS is the objective")
    print("under a fixed number of position slots. PF is not.")
    print("=" * 108)
    hdr = (f"{'rule':<20}{'closed':>7}{'win%':>7}{'avgR':>7}{'PF':>6}"
           f"{'95% CI':>15}{'R/1000sd':>10}{'held':>6}{'R0%':>6}{'giveback':>10}")

    def num(x):
        return ">99" if (x is None or x > 99) else f"{x:.2f}"

    def line(name, a):
        ci = (f"[{num(a['pf_lo'])},{num(a['pf_hi'])}]"
              if a["pf_lo"] is not None else "-")
        return (f"{name:<20}{a['n']:>7}{a['win_pct']:>6.1f}%{a['avgR']:>7.2f}"
                f"{num(a['pf']):>6}{ci:>15}"
                f"{(a['R_per_1000_slot_days'] or 0):>10.2f}"
                f"{a['avg_held']:>6.0f}{a['avg_r0_pct']:>6.1f}"
                f"{(a['give_back_pct'] or 0):>9.1f}%")

    def spec(name):
        an, kt, ki = STOP_RULES[name]
        return dict(rule=name, anchor=an, k_trail=kt,
                    k_init=("=trail" if ki is None else ki))

    print(hdr)
    for name in STOP_RULES:
        ts = [t for t in by_rule[name] if t["closed"]]
        a = agg(ts)
        if not a:
            continue
        out.append(dict(**spec(name), regime="all", **a))
        print(line(name, a))

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
            out.append(dict(**spec(name), regime=reg, **a))
            print(line(name, a))

    # ATR% cross-table. Last run this table hid the whole story: the k=3.5
    # collapse lived entirely in the >=6% bucket, where ~10 trades decide the
    # result. So print the interval width and mark cells that cannot be read.
    print("\n--- ATR% at signal: PF (95% CI width).  ! = width > 1.0, unreadable ---")
    print(f"{'rule':<20}" + "".join(f"{h:>18}"
          for h in ("<2.5", "2.5-4", "4-6", ">=6")))
    for name in STOP_RULES:
        ts = [t for t in by_rule[name] if t["closed"] and t["atr_pct"] is not None]
        cells = []
        for lo, hi in ((0, 2.5), (2.5, 4), (4, 6), (6, 1e9)):
            sel = [t for t in ts if lo <= t["atr_pct"] < hi]
            a = agg(sel)
            if not a or a["n"] < 30:
                cells.append("-")
                continue
            w = a["pf_ci_width"]
            mark = "!" if (w is not None and w > 1.0) else " "
            cells.append(f"{num(a['pf'])} ({w:.2f}){mark}" if w is not None
                         else num(a["pf"]))
            out.append(dict(**spec(name), regime=f"atr_{lo}-{hi if hi < 1e9 else 'inf'}",
                            **a))
        print(f"{name:<20}" + "".join(f"{c:>18}" for c in cells))
    print("=" * 108)
    return out


def paired_vs_prod(by_rule):
    """
    Every rule is scored on the SAME signals, so the rules are paired samples.
    A paired test is much more sensitive than comparing two overlapping CIs:
    the question is not "is rule X's PF interval above production's" but
    "when both rules trade the same ticker, does X win more often than it
    loses". Sign test over tickers, plus a bootstrap on the paired difference.
    """
    print("\n" + "=" * 92)
    print("PAIRED COMPARISON vs PRODUCTION  (same signals, per-ticker differences)")
    print("=" * 92)
    print(f"{'rule':<22}{'tickers':>8}{'X better':>10}{'prod better':>12}"
          f"{'dTotalR':>10}{'d R/1000sd':>12}{'95% CI on dR':>18}")

    def by_ticker(name, field="R"):
        acc = {}
        for t in by_rule[name]:
            if t["closed"]:
                acc[t["ticker"]] = acc.get(t["ticker"], 0.0) + t[field]
        return acc

    base = by_ticker(PROD_RULE)
    a0 = agg([t for t in by_rule[PROD_RULE] if t["closed"]], boot=False)
    for name in STOP_RULES:
        if name == PROD_RULE:
            continue
        cur = by_ticker(name)
        keys = sorted(set(base) | set(cur))
        diffs = [cur.get(k, 0.0) - base.get(k, 0.0) for k in keys]
        up = sum(1 for d in diffs if d > 0)
        dn = sum(1 for d in diffs if d < 0)
        rnd = random.Random(1)
        m = len(diffs)
        boots = []
        for _ in range(BOOT_N):
            boots.append(sum(diffs[rnd.randrange(m)] for _ in range(m)))
        boots.sort()
        lo, hi = boots[int(0.025 * BOOT_N)], boots[int(0.975 * BOOT_N)]
        a = agg([t for t in by_rule[name] if t["closed"]], boot=False)
        dslot = ((a["R_per_1000_slot_days"] or 0)
                 - (a0["R_per_1000_slot_days"] or 0))
        sig = "" if lo <= 0 <= hi else "  <- CI excludes 0"
        print(f"{name:<22}{m:>8}{up:>10}{dn:>12}{sum(diffs):>+10.0f}"
              f"{dslot:>+12.2f}{f'[{lo:+.0f},{hi:+.0f}]':>18}{sig}")
    print("\nA rule only earns a change if dR/1000sd is positive AND the CI on")
    print("dTotalR excludes zero. Anything else is a tie, and a tie means keep")
    print("production — the incumbent wins ties, because switching has costs")
    print("this backtest does not model.")
    print("=" * 92)


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
    global BOOT_N
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=float, default=5.0)
    ap.add_argument("--limit", type=int, default=0, help="only N tickers (smoke test)")
    ap.add_argument("--sleep", type=float, default=0.12)
    ap.add_argument("--boot", type=int, default=BOOT_N,
                    help="bootstrap resamples for the confidence intervals")
    ap.add_argument("--stop-grid", action="store_true",
                    help="also replay every STOP_RULES variant and write stops.csv")
    ap.add_argument("--grid-mode", default="C_close_nextopen_prev",
                    choices=list(MODES),
                    help="execution mode used to score the stop grid "
                         "(default C = your actual evening workflow)")
    args = ap.parse_args()
    BOOT_N = args.boot

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
        a = agg([t for t in by_mode[name] if t["closed"]], boot=False)
        if a:
            mrows.append(dict(mode=name, trigger=MODES[name][0], fill=MODES[name][1],
                              stop_ref=MODES[name][2], regime="all", **a))
        for reg in ("bull", "neutral", "bear"):
            a = agg([t for t in by_mode[name]
                      if t["closed"] and t.get("regime") == reg], boot=False)
            if a:
                mrows.append(dict(mode=name, trigger=MODES[name][0],
                                  fill=MODES[name][1], stop_ref=MODES[name][2],
                                  regime=reg, **a))
    write_rows(os.path.join(OUT_DIR, "modes.csv"), mrows,
               ["mode", "trigger", "fill", "stop_ref", "regime", "n", "win_pct",
                "avgR", "medR", "pf", "totalR", "avg_held", "avg_r0_pct",
                "R_per_1000_slot_days", "peakR", "give_back_pct"])

    compare_modes(by_mode)
    if by_rule is not None:
        srows = compare_stops(by_rule)
        write_rows(os.path.join(OUT_DIR, "stops.csv"), srows,
                   ["rule", "anchor", "k_trail", "k_init", "regime", "n",
                    "win_pct", "avgR", "medR", "pf", "pf_lo", "pf_hi",
                    "pf_ci_width", "totalR", "avg_held", "avg_r0_pct",
                    "R_per_1000_slot_days", "peakR", "give_back_pct"])
        print(f"(stop grid scored under execution mode {args.grid_mode}, "
              f"{BOOT_N} bootstrap resamples)")
        paired_vs_prod(by_rule)
    mae_report(trades)
    report(trades)
    print("\nNOTE: config.csv is today's universe, so these numbers carry "
          "survivorship/selection bias. Compare buckets to each other, not to 1.0.")


if __name__ == "__main__":
    main()
