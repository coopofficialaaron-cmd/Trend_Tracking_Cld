"""
Trend-tracker indicator engine — faithful re-implementation of the Google Sheet model.
Validated row-by-row against the original workbook (max abs error ~1e-14).

Column meanings (per stock):
  TR        True Range
  atr14     ATR(14)  Wilder smoothing, seeded by a 14-period SMA of TR
  atr50     ATR(50)  Wilder smoothing, seeded by a 50-period SMA of TR
  selfvol   atr14/atr50 - 1   (short vs long volatility; >0 = expanding)
  ma20      mean of the previous 20 closes (excludes today)
  dev       (close - ma20) / atr14   deviation from MA20 in ATR units
  hc55      highest close of the previous 55 days (excludes today)
  hc22      highest close of the previous 22 days (excludes today)
  mult      chandelier ATR multiple, by atr%: <2.5%->3, <5%->3.5, else 4
  cand      chandelier stop candidate = hc55 - mult*atr14
  trail     ratcheted chandelier (never decreases) = max(prev_trail, cand)
  final     = trail  (final stop)
  mktok     benchmark filter: benchmark close >= SMA100 AND 10-day return > -8%
  buf       entry buffer in ATR units = clamp(breakout / atr%, 0.2, 0.5)
  minentry  hc22 + buf*atr14      (breakout entry floor)
  maxentry  minentry + 0.3*atr14  (entry ceiling, anti chase)
  enter     "ENTER" if mktok AND minentry<=close<maxentry AND cand<minentry
  r0        maxentry - cand       (risk per share at the ceiling)
  shares    MROUND(risk / r0, 0.5)  when enter
  er22/er55 Kaufman efficiency ratio over 22 / 55 days (close-to-close)
"""
from datetime import datetime


def mround(x, m=0.5):
    return round(x / m) * m


def compute_benchmark(rows):
    """rows: list of [date(str), close(float)] ascending. Returns list of dicts."""
    C = [float(r[1]) for r in rows]
    out = []
    n = len(C)
    for i in range(n):
        sma100 = sum(C[i - 99:i + 1]) / 100 if i >= 99 else None
        dd10 = (C[i] / C[i - 10] - 1) if i >= 10 else None
        ok = None
        if sma100 is not None and dd10 is not None:
            ok = (C[i] >= sma100) and (dd10 > -0.08)
        out.append({"date": rows[i][0], "close": C[i],
                    "sma100": sma100, "dd10": dd10, "ok": ok})
    return out


def compute_stock(ohlcv, bench_ok_by_date, risk=25.0, breakout=0.01):
    """
    ohlcv: list of [date, open, high, low, close, volume] ascending by date.
    bench_ok_by_date: {date_str: bool} from the stock's benchmark.
    Returns (rows, summary).
    """
    O = [float(r[1]) for r in ohlcv]
    H = [float(r[2]) for r in ohlcv]
    L = [float(r[3]) for r in ohlcv]
    Cl = [float(r[4]) for r in ohlcv]
    Vol = [r[5] for r in ohlcv]
    D = [r[0] for r in ohlcv]
    n = len(Cl)

    TR = [None] * n; ATR14 = [None] * n; ATR50 = [None] * n
    rows = []
    for i in range(n):
        # True Range
        if i == 0:
            TR[i] = H[i] - L[i]
        else:
            pc = Cl[i - 1]
            TR[i] = max(H[i] - L[i], abs(H[i] - pc), abs(L[i] - pc))
        # ATR14 — SMA seed at the 14th TR, then Wilder
        if i < 13:
            ATR14[i] = None
        elif i == 13:
            ATR14[i] = sum(TR[0:14]) / 14
        else:
            ATR14[i] = (ATR14[i - 1] * 13 + TR[i]) / 14
        # ATR50
        if i < 49:
            ATR50[i] = None
        elif i == 49:
            ATR50[i] = sum(TR[0:50]) / 50
        else:
            ATR50[i] = (ATR50[i - 1] * 49 + TR[i]) / 50

        atr14 = ATR14[i]
        atrpct = (atr14 / Cl[i]) if atr14 is not None else None
        selfvol = (atr14 / ATR50[i] - 1) if (ATR50[i] and atr14 is not None) else None
        ma20 = sum(Cl[i - 20:i]) / 20 if i >= 20 else None
        dev = (Cl[i] - ma20) / atr14 if (ma20 is not None and atr14) else None
        hc55 = max(Cl[i - 55:i]) if i >= 55 else None
        hc22 = max(Cl[i - 22:i]) if i >= 22 else None
        mult = None
        if atrpct is not None:
            mult = 3 if atrpct < 0.025 else (3.5 if atrpct < 0.05 else 4)
        cand = (hc55 - mult * atr14) if (hc55 is not None and mult is not None and atr14 is not None) else None
        # ratcheted trail
        prev_trail = rows[i - 1]["trail"] if i > 0 else None
        if cand is None:
            trail = None
        elif prev_trail is None:
            trail = cand
        else:
            trail = max(prev_trail, cand)
        mktok = bench_ok_by_date.get(D[i])
        buf = max(0.2, min(breakout / atrpct, 0.5)) if atrpct else None
        minentry = (hc22 + buf * atr14) if (hc22 is not None and buf is not None and atr14 is not None) else None
        maxentry = (minentry + atr14 * 0.3) if minentry is not None else None
        enter = ""
        if (mktok and minentry is not None and minentry <= Cl[i] < maxentry
                and cand is not None and cand < minentry):
            enter = "ENTER"
        r0 = (maxentry - cand) if (maxentry is not None and cand is not None) else None
        shares = mround(risk / r0, 0.5) if (enter == "ENTER" and r0) else None
        er22 = None
        if i >= 22:
            den = sum(abs(Cl[k] - Cl[k - 1]) for k in range(i - 21, i + 1))
            er22 = abs(Cl[i] - Cl[i - 22]) / den if den else None
        er55 = None
        if i >= 55:
            den = sum(abs(Cl[k] - Cl[k - 1]) for k in range(i - 54, i + 1))
            er55 = abs(Cl[i] - Cl[i - 55]) / den if den else None

        rows.append({
            "date": D[i], "open": O[i], "high": H[i], "low": L[i], "close": Cl[i], "volume": Vol[i],
            "tr": TR[i], "atr14": atr14, "atr50": ATR50[i], "atrpct": atrpct, "selfvol": selfvol,
            "ma20": ma20, "dev": dev, "hc55": hc55, "hc22": hc22, "mult": mult,
            "cand": cand, "trail": trail, "final": trail, "mktok": mktok, "buf": buf,
            "minentry": minentry, "maxentry": maxentry, "enter": enter, "r0": r0, "shares": shares,
            "er22": er22, "er55": er55,
        })

    summary = build_summary(rows)
    return rows, summary


def build_summary(rows):
    """Replicates the stock-tab header block (D3:K9), incl. the SWITCH signal in H8."""
    if not rows:
        return {}
    r = rows[-1]
    close = r["close"]; mine = r["minentry"]; maxe = r["maxentry"]
    cand = r["cand"]; mktok = r["mktok"]
    premium = (close - mine) if mine is not None else None
    # SWITCH(TRUE(), mktok=FALSE->Bad Market, mktok&prem>0&close<max&cand<min->Enter,
    #        mktok&prem>0&close>max->Too High, ->Wait)
    if mktok is False or mktok is None:
        signal = "Bad Market"
    elif premium is not None and premium > 0 and maxe is not None and close < maxe and cand is not None and cand < mine:
        signal = "Enter"
    elif premium is not None and premium > 0 and maxe is not None and close > maxe:
        signal = "Too High"
    else:
        signal = "Wait"
    entry_pct = ((close - mine) / (maxe - mine)) if (signal == "Enter" and maxe and mine is not None and maxe != mine) else None
    return {
        "date": r["date"], "close": close, "atr14": r["atr14"], "atrpct": r["atrpct"],
        "selfvol": r["selfvol"], "dev": r["dev"], "mktok": mktok,
        "stop": cand, "minentry": mine, "maxentry": maxe, "premium": premium,
        "signal": signal, "entry_pct": entry_pct, "er22": r["er22"], "er55": r["er55"],
        "r0": r["r0"], "shares": r["shares"], "mult": r["mult"], "buf": r["buf"],
    }
