#!/usr/bin/env python3
"""
Two-stage stop test — does tightening the chandelier multiple after the trade
has earned K x R buy more than it costs?

WHY THIS IS A SEPARATE FILE
    backtest.py's STOP_RULES are all *static*: one multiple (or one ladder) for
    the whole life of the trade. A two-stage rule is path-dependent — the
    multiple changes because of what the trade has already done — so it cannot
    be expressed in that table. This script reuses backtest.py's data loading,
    portfolio simulation and reporting, and only replaces the replay loop.

WHAT IT MEASURES, AND WHY THAT MATTERS
    Not profit factor. Not give-back. The committed trade list says 53 trades
    out of 1085 (strong tier, R0>=8%) produce 91% of all profit, and a hard
    take-profit at 2R would cut total R by 74%. So a rule that "protects
    profit" is really a rule that truncates the tail, and the only honest
    scoreboard is total R per R of drawdown under the 22-slot constraint.
    That is what the headline table prints.

THE RULE BEING TESTED
    stage 1  the production ladder, verbatim (3 / 3.5 / 4 on ATR%)
    arming   the first close whose (close - entry) / r0 >= K arms the trade,
             permanently. A ratchet, not a toggle: a stop cannot be lowered, so
             an un-arming rule would be unimplementable anyway, and a rule that
             re-checks current R would chatter around K.
    stage 2  once armed, the candidate uses min(production_mult, TIGHT) so the
             stop can only ever move up. The exit test still runs against the
             stop published LAST night, so arming on day j only bites from day
             j+1 — the same lag you live with.

    Controls: hard take-profit at K (exit on the close that reaches K), which
    is the upper bound on give-back capture and the lower bound on tail
    capture. If two-stage cannot beat both production and the hard cap on
    R/DD, there is nothing here.

CACHE
    backtest.py re-downloads ~494 tickers x 5 years from Yahoo on every run,
    which is why "is it worth testing?" kept being a real question. Bars are
    cached gzipped under engine/.cache/ohlcv/ on first run and reused after.
    Add engine/.cache/ to .gitignore.

USAGE
    python engine/twostage.py                    # first run downloads, then caches
    python engine/twostage.py --limit 40         # smoke test
    python engine/twostage.py --refresh          # re-download, refresh the cache
    python engine/twostage.py --mode A_close_close   # match committed trades.csv
"""
import argparse, csv, gzip, json, os, sys, time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from indicators import compute_benchmark, compute_stock          # noqa: E402
import build as B                                                # noqa: E402
import backtest as BT                                            # noqa: E402

OUT_DIR = os.path.join(ROOT, "docs", "data", "backtest")
CACHE_DIR = os.path.join(HERE, ".cache", "ohlcv")


# --------------------------------------------------------------------- cache
def cached_fetch(ticker, years, refresh=False, sleep=0.12):
    """fetch_long with a gzipped on-disk cache. Returns (rows, from_cache)."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    safe = ticker.strip().upper().replace(os.sep, "_")
    path = os.path.join(CACHE_DIR, f"{safe}_{years:g}y.json.gz")
    if not refresh and os.path.exists(path):
        try:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                return json.load(f)["rows"], True
        except Exception:
            pass                                   # corrupt cache -> refetch
    rows = BT.fetch_long(ticker, years)
    time.sleep(sleep)
    if rows:
        tmp = path + ".tmp"
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump({"ticker": ticker, "years": years,
                       "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       "rows": rows}, f)
        os.replace(tmp, path)
    return rows, False


# --------------------------------------------------------------------- rules
# name -> (K, TIGHT, kind)
#   kind "prod"  production ladder, untouched
#        "two"   two-stage: tighten the multiple to TIGHT once peak R >= K
#        "tp"    hard take-profit at K (control)
def build_rules(ks, tights):
    rules = {"0_prod": (None, None, "prod")}
    for k in ks:
        for m in tights:
            rules[f"K{k:g}_m{m:g}"] = (k, m, "two")
    for k in ks:
        rules[f"TP{k:g}R"] = (k, None, "tp")
    return rules


def replay_rule(ticker, rows, spec, trigger="close", fill="nextopen",
                stop_ref="prev", want_path=True):
    """One trade generator, mirroring BT.replay's contract and field names.

    Entry, r0 and the stage-1 stop are production's own values, so a trade that
    never arms is bit-identical to production. That is deliberate: it makes the
    comparison isolate exactly one thing.
    """
    K, TIGHT, kind = spec
    closes = [r["close"] for r in rows]
    n = len(rows)
    i = 0
    while i < n:
        r = rows[i]
        if (r.get("enter") != "ENTER" or not r.get("r0") or r["r0"] <= 0
                or r.get("cand") is None):
            i += 1
            continue

        entry, r0, atr = r["close"], r["r0"], r.get("atr14")
        stop = r["cand"]                       # production initial stop
        armed_on = ""
        fresh = ((r["hc55"] - r["hc22"]) / atr
                 if (atr and r.get("hc55") is not None and r.get("hc22") is not None)
                 else None)
        if fresh is not None:
            fresh = max(0.0, fresh)
        dd = ((r["hc55"] - r["hc22"]) / r["hc55"]
              if (r.get("hc55") and r.get("hc22") is not None) else None)

        j, ex, peak = i + 1, None, entry
        mae_c, mae_l = entry, entry
        hit_stop, reason, path = None, "open", []
        while j < n:
            stop_prev = stop                   # what the app published last night
            row = rows[j]
            peak = max(peak, row["close"])
            mae_c = min(mae_c, row["close"])
            mae_l = min(mae_l, row["low"])
            if want_path:
                path.append((row["date"], (row["close"] - entry) / r0))

            # --- arming (uses closes only; peak is the highest close so far)
            if kind == "two" and not armed_on and (peak - entry) / r0 >= K:
                armed_on = row["date"]

            # --- tonight's candidate, then the ratchet
            if kind == "two" and armed_on:
                pm, a14, hc = row.get("mult"), row.get("atr14"), row.get("hc55")
                # min(): tightening must never loosen the stop
                c = (hc - min(pm, TIGHT) * a14
                     if (pm is not None and a14 is not None and hc is not None) else None)
            else:
                c = row.get("cand")
            if c is not None and c > stop:
                stop = c

            # --- hard take-profit control, judged on the close
            if kind == "tp" and (row["close"] - entry) / r0 >= K:
                ex, hit_stop, reason = j, None, "tp"
                break

            level = stop_prev if stop_ref == "prev" else stop
            px = row["low"] if trigger == "low" else row["close"]
            if px < level:
                ex, hit_stop, reason = j, level, "stop"
                break
            j += 1

        closed = ex is not None
        if not closed:
            exit_px = rows[-1]["close"]
        elif fill == "nextopen":
            if ex + 1 < n:
                exit_px = rows[ex + 1]["open"]
            else:
                closed, ex, exit_px, reason = False, None, rows[-1]["close"], "open"
        elif fill == "stop" and hit_stop is not None:
            exit_px = min(hit_stop, rows[ex]["open"])
        else:
            exit_px = rows[ex]["close"]

        yield {
            "ticker": ticker, "signal_date": r["date"],
            "exit_date": rows[ex]["date"] if closed else "",
            "closed": int(closed), "entry": round(entry, 4),
            "exit": round(exit_px, 4), "r0": round(r0, 4),
            "R": round((exit_px - entry) / r0, 3),
            "move_pct": round((exit_px - entry) / entry * 100, 2),
            "peak_pct": round((peak - entry) / entry * 100, 2),
            "peak_R": round((peak - entry) / r0, 3),
            "held": (ex if closed else n - 1) - i,
            "r0_pct": round(r0 / entry * 100, 3),
            "path": path if want_path else None,
            "armed_on": armed_on, "exit_reason": reason,
            "mae_R": round((mae_c - entry) / r0, 3),
            "mae_low_R": round((mae_l - entry) / r0, 3),
            "mae_atr": round((entry - mae_c) / atr, 3) if atr else None,
            "mae_low_atr": round((entry - mae_l) / atr, 3) if atr else None,
            "er22": r.get("er22"), "er55": r.get("er55"),
            "fresh": round(fresh, 3) if fresh is not None else None,
            "dd_pct": round(dd * 100, 2) if dd is not None else None,
            "hi_age": BT.hi_age_at(closes, i),
            "atr_pct": round(r["atrpct"] * 100, 3) if r.get("atrpct") is not None else None,
            "dev": r.get("dev"), "selfvol": r.get("selfvol"),
            "tier": BT.tier_of(round(r["atrpct"] * 100, 3)
                               if r.get("atrpct") is not None else None),
            "tier_er": BT.tier_er_of(r.get("er22"), r.get("er55"), fresh),
        }
        i = (ex + 1) if closed else n


# ---------------------------------------------------------------- portfolio
RANK = {"strong": 2, "mid": 1, "weak": 0}


def sim_curve(trades, slots=22, tier_floor=None, r0_floor=None):
    """Same slot simulation as BT.simulate_portfolio, but it also returns the
    daily equity curve so drawdown can be sliced by year. Cross-checked against
    BT.simulate_portfolio below; a mismatch is printed, not swallowed.
    """
    cand = [t for t in trades if t.get("path") is not None]
    if tier_floor is not None:
        cand = [t for t in cand if RANK.get(t.get("tier"), 1) >= tier_floor]
    if r0_floor is not None:
        cand = [t for t in cand if t["r0_pct"] >= r0_floor]
    if not cand:
        return None
    by_day = {}
    for t in cand:
        by_day.setdefault(t["signal_date"], []).append(t)
    open_pos, taken = [], []
    for day in sorted(by_day):
        open_pos = [p for p in open_pos if not p["exit_date"] or p["exit_date"] > day]
        room = slots - len(open_pos)
        if room > 0:
            picks = sorted(by_day[day],
                           key=lambda t: (-RANK.get(t.get("tier"), 1), -t["r0_pct"]))
            for t in picks[:room]:
                open_pos.append(t)
                taken.append(t)
    if not taken:
        return None
    realised, unreal = {}, {}
    for t in taken:
        if t["closed"] and t["exit_date"]:
            realised[t["exit_date"]] = realised.get(t["exit_date"], 0.0) + t["R"]
            hold = t["path"][:-1] if t["path"] else []
        else:
            hold = t["path"] or []
        for d, r in hold:
            unreal[d] = unreal.get(d, 0.0) + r
    days = sorted(set(realised) | set(unreal))
    curve, run = [], 0.0
    for d in days:
        run += realised.get(d, 0.0)
        curve.append((d, run + unreal.get(d, 0.0)))
    peak = dd = 0.0
    dd_date = ""
    for d, e in curve:
        peak = max(peak, e)
        if peak - e > dd:
            dd, dd_date = peak - e, d
    return {"curve": curve, "taken": taken, "signals": len(cand),
            "totalR": sum(t["R"] for t in taken if t["closed"]),
            "maxDD_R": dd, "dd_date": dd_date}


def year_slices(curve):
    """Total R change and worst intra-year drawdown, per calendar year.

    A regime is a daily property, so slicing an equity curve by regime would
    attribute a drawdown to whichever regime it ended in. Calendar years are
    blunt but honest, and 2022 vs 2024-25 is the split that actually matters
    here: the strong-tier edge is concentrated in the later years.
    """
    out = {}
    for d, e in curve:
        y = d[:4]
        s = out.setdefault(y, {"first": e, "last": e, "peak": e, "dd": 0.0})
        s["last"] = e
        s["peak"] = max(s["peak"], e)
        s["dd"] = max(s["dd"], s["peak"] - e)
    return {y: {"R": s["last"] - s["first"], "maxDD_R": s["dd"]}
            for y, s in sorted(out.items())}


# ------------------------------------------------------------------- report
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=float, default=5.0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--slots", type=int, default=22)
    ap.add_argument("--sleep", type=float, default=0.12)
    ap.add_argument("--refresh", action="store_true", help="ignore the cache")
    ap.add_argument("--mode", default="C_close_nextopen_prev", choices=list(BT.MODES))
    ap.add_argument("--k", default="2,3,4", help="arming thresholds in R")
    ap.add_argument("--tight", default="2.5,3,3.5", help="stage-2 multiples")
    args = ap.parse_args()

    ks = [float(x) for x in args.k.split(",") if x.strip()]
    tights = [float(x) for x in args.tight.split(",") if x.strip()]
    RULES = build_rules(ks, tights)
    trig, fill, sref = BT.MODES[args.mode]

    cfg = B.read_config()
    if args.limit:
        cfg = cfg[:args.limit]
    print(f"config: {len(cfg)} tickers | {args.years:g}y | mode {args.mode} | "
          f"{len(RULES)} rules")

    # benchmarks
    bms = sorted({c["benchmark"] for c in cfg if c.get("benchmark")})
    bench_ok, hits = {}, 0
    for bm in bms:
        rows, hit = cached_fetch(bm, args.years, args.refresh, args.sleep)
        hits += hit
        if not rows:
            sys.stderr.write(f"[bench] {bm} no data\n")
            continue
        series = compute_benchmark([[r[0], r[4]] for r in rows])
        bench_ok[bm] = {d["date"]: d["ok"] for d in series if d["ok"] is not None}
    print(f"benchmarks: {len(bench_ok)}/{len(bms)} ({hits} from cache)")

    by_rule = {name: [] for name in RULES}
    breadth_hits, done, nodata, chits = {}, 0, 0, 0
    for c in cfg:
        ohlcv, hit = cached_fetch(c["ticker"], args.years, args.refresh, args.sleep)
        chits += hit
        if len(ohlcv) < 120:
            nodata += 1
            continue
        rows, _ = compute_stock(ohlcv, bench_ok.get(c["benchmark"], {}),
                               risk=c["risk"], breakout=c["breakout"])
        for name, spec in RULES.items():
            by_rule[name].extend(replay_rule(c["ticker"], rows, spec,
                                             trig, fill, sref, want_path=True))
        for r in rows:
            if r.get("mktok") is not None:
                a, b = breadth_hits.setdefault(r["date"], [0, 0])
                breadth_hits[r["date"]] = [a + (1 if r["mktok"] else 0), b + 1]
        done += 1
        if done % 50 == 0:
            print(f"  ...{done}/{len(cfg)} ({chits} cached)")
    print(f"processed {done} tickers ({nodata} unusable, {chits} from cache), "
          f"{len(by_rule['0_prod'])} production trades")

    breadth = {d: (v[0] / v[1] if v[1] else None) for d, v in breadth_hits.items()}
    for name in by_rule:
        for t in by_rule[name]:
            b = breadth.get(t["signal_date"])
            t["breadth"] = round(b, 4) if b is not None else None
            t["regime"] = BT.regime_of(b)

    # ---------------------------------------------------------- headline table
    print("\n" + "=" * 108)
    print(f"TWO-STAGE STOP — {args.slots} SLOTS, filter strong tier + R0>=8% "
          f"(your execution layer), mode {args.mode}")
    print("R/DD is the decision number. totalR alone is not: 91% of profit sits")
    print("in ~5% of trades, so any rule can buy PF by selling the tail.")
    print("=" * 108)
    hdr = (f"{'rule':<14}{'taken':>7}{'take%':>7}{'totalR':>9}{'maxDD':>8}"
           f"{'R/DD':>7}{'DD@0.25%':>10}{'held':>6}{'armed%':>8}{'tp/stop':>9}")
    print(hdr)
    rows_out, curves = [], {}
    for name in RULES:
        p = sim_curve(by_rule[name], args.slots, 2, 8.0)
        if not p:
            continue
        # backtest.py rounds maxDD to 1dp, so compare at that precision or
        # rounding alone would raise a false alarm on every rule.
        chk = BT.simulate_portfolio(by_rule[name], args.slots, 2, 8.0)
        if chk and abs(chk["maxDD_R"] - round(p["maxDD_R"], 1)) > 1e-9:
            print(f"  ! {name}: DD mismatch vs backtest.simulate_portfolio "
                  f"({chk['maxDD_R']} vs {p['maxDD_R']:.1f})")
        tk = p["taken"]
        closed = [t for t in tk if t["closed"]]
        armed = sum(1 for t in tk if t.get("armed_on"))
        tps = sum(1 for t in tk if t.get("exit_reason") == "tp")
        rdd = p["totalR"] / p["maxDD_R"] if p["maxDD_R"] > 0 else None
        held = sum(t["held"] for t in tk) / len(tk)
        curves[name] = p["curve"]
        print(f"{name:<14}{len(tk):>7}{100*len(tk)/p['signals']:>6.1f}%"
              f"{p['totalR']:>9.0f}{p['maxDD_R']:>8.1f}{(rdd or 0):>7.2f}"
              f"{p['maxDD_R']*0.25:>9.1f}%{held:>6.0f}"
              f"{100*armed/len(tk):>7.0f}%{tps:>5}/{len(closed)-tps:<4}")
        rows_out.append(dict(rule=name, K=RULES[name][0], tight=RULES[name][1],
                             kind=RULES[name][2], slots=args.slots,
                             taken=len(tk), signals=p["signals"],
                             totalR=round(p["totalR"], 1),
                             maxDD_R=round(p["maxDD_R"], 1),
                             R_per_DD=round(rdd, 2) if rdd else None,
                             dd_date=p["dd_date"], avg_held=round(held, 1),
                             armed_pct=round(100 * armed / len(tk), 1),
                             pf=round(BT.agg(closed, boot=False)["pf"], 3)
                             if closed else None))
    print("=" * 108)
    print("armed% = share of taken trades that ever reached K x R. If that is")
    print("small the rule cannot matter, whatever the other columns say.")

    # ------------------------------------------------------------ by year
    print("\nPER CALENDAR YEAR — R gained / worst drawdown inside the year")
    yrs = sorted({y for c in curves.values() for y in year_slices(c)})
    print(f"{'rule':<14}" + "".join(f"{y:>16}" for y in yrs))
    yr_rows = []
    for name, c in curves.items():
        ys = year_slices(c)
        line = f"{name:<14}"
        for y in yrs:
            s = ys.get(y)
            line += (f"{s['R']:>+8.0f}/{s['maxDD_R']:>6.1f}" if s else f"{'-':>16}")
            if s:
                yr_rows.append(dict(rule=name, year=y, R=round(s["R"], 1),
                                    maxDD_R=round(s["maxDD_R"], 1)))
        print(line)
    print("2022-23 carried near-zero strong-tier edge. A rule that only wins in")
    print("2024-25 is a bull-market rule, not an improvement.")

    # ------------------------------------------------------------ by regime
    print("\nTRADE LEVEL BY ENTRY REGIME (unlimited capital — context, not the verdict)")
    print(f"{'rule':<14}{'regime':<9}{'n':>6}{'pf':>7}{'totalR':>9}{'giveback%':>11}")
    for name in RULES:
        for reg in ("bull", "neutral", "bear"):
            sub = [t for t in by_rule[name]
                   if t["closed"] and t.get("regime") == reg
                   and t["tier"] == "strong" and t["r0_pct"] >= 8.0]
            a = BT.agg(sub, boot=False)
            if a:
                print(f"{name:<14}{reg:<9}{a['n']:>6}{a['pf']:>7.2f}"
                      f"{a['totalR']:>9.0f}{a['give_back_pct']:>10.0f}%")
        print()

    os.makedirs(OUT_DIR, exist_ok=True)
    BT.write_rows(os.path.join(OUT_DIR, "twostage.csv"), rows_out,
                  ["rule", "kind", "K", "tight", "slots", "signals", "taken",
                   "totalR", "maxDD_R", "R_per_DD", "dd_date", "avg_held",
                   "armed_pct", "pf"])
    BT.write_rows(os.path.join(OUT_DIR, "twostage_by_year.csv"), yr_rows,
                  ["rule", "year", "R", "maxDD_R"])
    print(f"\nwrote {OUT_DIR}/twostage.csv and twostage_by_year.csv")
    print("NOTE: today's universe, so survivorship/selection bias is baked in. "
          "Read rules against each other, never against 1.0.")


if __name__ == "__main__":
    main()
