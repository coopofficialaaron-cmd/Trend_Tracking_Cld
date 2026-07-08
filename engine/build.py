"""
build.py — fetch daily OHLCV (free, no API key) and compute the model.

Data source: Yahoo Finance chart API (primary) with Stooq as fallback. Both are
free and need no key. A dot in a ticker becomes a dash (MOG.A -> MOG-A). Yahoo is
used first because Stooq blocks cloud/CI IPs.

config.csv only needs:  ticker, exchange, major, sub
  - the company name is fetched automatically
  - risk ($25) and breakout (1%) use global defaults below
    (you may still add `risk` / `breakout` columns to override per stock)

Usage:
  python engine/build.py            # fetch live, write docs/data/latest.json
  python engine/build.py --seed     # use bundled engine/seed_prices.json (offline)
"""
import csv, json, os, sys, time, urllib.request
from datetime import datetime, timezone, time as dtime
try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:
    ET = None
from indicators import compute_benchmark, compute_stock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(ROOT, "config.csv")
DATA_DIR = os.path.join(ROOT, "docs", "data")
INDEX_OUT = os.path.join(DATA_DIR, "index.json")        # small: summaries + market
STOCK_DIR = os.path.join(DATA_DIR, "stocks")            # one small file per ticker
OUT = os.path.join(DATA_DIR, "latest.json")             # legacy (no longer written)
HISTORY_DIR = os.path.join(DATA_DIR, "history")         # permanent daily signal log (one CSV per month)
SEED = os.path.join(HERE, "seed_prices.json")

def safe_name(t):
    return "".join(ch if ch.isalnum() else "_" for ch in t)

def rnd(o, nd=4):
    """Recursively round floats to keep the JSON small."""
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [rnd(x, nd) for x in o]
    if isinstance(o, dict):
        return {k: rnd(v, nd) for k, v in o.items()}
    return o

HISTORY_FIELDS = [
    "date", "ticker", "name", "major", "sub", "benchmark",
    "close", "signal", "entry_pct", "minentry", "maxentry", "stop",
    "atrpct", "dev", "selfvol", "er22", "er55", "r0", "mult", "buf",
]

def append_history_log(stocks):
    """Permanent, ever-growing daily signal archive — independent of the rolling
    290-day window in docs/data/stocks/*.json. One CSV per calendar month
    (docs/data/history/YYYY-MM.csv), keyed by (date, ticker): re-running the
    workflow the same day upserts that day's row instead of duplicating it,
    so retries/self-heal reruns stay clean. Designed to be pointed at directly
    from Power BI (Get Data > Web, or a Folder query over docs/data/history/)."""
    by_month = {}
    for s in stocks:
        summ = s.get("summary") or {}
        d = summ.get("date")
        if not d or not summ.get("signal"):
            continue  # no data for this ticker on this run — nothing to log
        row = {
            "date": d, "ticker": s["ticker"], "name": s.get("name", ""),
            "major": s.get("major", ""), "sub": s.get("sub", ""),
            "benchmark": s.get("benchmark", ""),
            "close": summ.get("close"), "signal": summ.get("signal"),
            "entry_pct": summ.get("entry_pct"), "minentry": summ.get("minentry"),
            "maxentry": summ.get("maxentry"), "stop": summ.get("stop"),
            "atrpct": summ.get("atrpct"), "dev": summ.get("dev"),
            "selfvol": summ.get("selfvol"), "er22": summ.get("er22"),
            "er55": summ.get("er55"), "r0": summ.get("r0"),
            "mult": summ.get("mult"), "buf": summ.get("buf"),
        }
        by_month.setdefault(d[:7], {})[(d, s["ticker"])] = rnd(row)

    if not by_month:
        return
    os.makedirs(HISTORY_DIR, exist_ok=True)
    for month, new_rows in by_month.items():
        path = os.path.join(HISTORY_DIR, f"{month}.csv")
        existing = {}
        if os.path.exists(path):
            with open(path, newline="", encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    existing[(r["date"], r["ticker"])] = r
        existing.update(new_rows)  # today's fresh values win over any earlier retry
        ordered = sorted(existing.values(), key=lambda r: (r["date"], r["ticker"]))
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=HISTORY_FIELDS)
            w.writeheader()
            for r in ordered:
                w.writerow({k: r.get(k, "") for k in HISTORY_FIELDS})

RISK_DEFAULT = 25.0          # 可亏限额 $
BREAKOUT_DEFAULT = 0.01      # 突破确认 +1%
LOOKBACK_DAYS = 290          # ~400 calendar days, matching the original sheet window
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

NAMES = {}  # ticker -> fetched company name
EXCH = {}   # ticker -> fetched exchange (cleaned)

# Yahoo exchange codes -> friendly names
EXCH_MAP = {"NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NAS": "NASDAQ",
            "NYQ": "NYSE", "NYS": "NYSE", "PCX": "NYSE Arca", "ASE": "NYSE American",
            "BATS": "BATS", "OPR": "OTC", "PNK": "OTC"}


def yahoo_symbol(t): return t.strip().upper().replace(".", "-")
def stooq_symbol(t): return t.strip().lower().replace(".", "-") + ".us"


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json,text/plain,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _f(v, fallback): return float(v) if v is not None else float(fallback)


def _is_partial_today(date_iso):
    """True if date_iso is the current US trading date and the session hasn't
    finalized yet (before ~16:05 ET) — i.e. an in-progress intraday bar."""
    if ET is not None:
        now = datetime.now(ET)
        return date_iso == now.date().isoformat() and now.time() < dtime(16, 5)
    # fallback without tz db: US close 16:00 ET ≈ 20:00–21:00 UTC
    now = datetime.now(timezone.utc)
    return date_iso == now.date().isoformat() and now.hour < 21


def _finalize(rows):
    """Drop any in-progress current-day bar, then keep the lookback window."""
    rows.sort(key=lambda r: r[0])
    while rows and _is_partial_today(rows[-1][0]):
        rows.pop()
    return rows[-LOOKBACK_DAYS:]


def fetch_yahoo(ticker):
    """Return [[date,o,h,l,c,v], ...] ascending, or []. Also caches the name."""
    sym = yahoo_symbol(ticker)
    p2 = int(time.time()) + 86400               # tomorrow, to be sure today is included
    p1 = p2 - 760 * 86400                        # ~2 years back
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = (f"https://{host}/v8/finance/chart/{sym}"
               f"?period1={p1}&period2={p2}&interval=1d&includePrePost=false")
        try:
            data = json.loads(_get(url))
            res = (data.get("chart", {}).get("result") or [None])[0]
            if not res:
                continue
            nm = (res.get("meta") or {}).get("shortName") or (res.get("meta") or {}).get("longName")
            if nm and ticker not in NAMES:
                NAMES[ticker] = nm
            ex = (res.get("meta") or {}).get("fullExchangeName") or (res.get("meta") or {}).get("exchangeName")
            if ex and ticker not in EXCH:
                EXCH[ticker] = EXCH_MAP.get(ex, ex)
            ts = res.get("timestamp") or []
            q = (res.get("indicators", {}).get("quote") or [{}])[0]
            o, h, l, c, v = (q.get("open"), q.get("high"), q.get("low"),
                             q.get("close"), q.get("volume"))
            rows = []
            for i, t in enumerate(ts):
                if not c or c[i] is None:
                    continue
                d = datetime.fromtimestamp(t, tz=(ET or timezone.utc)).date().isoformat()
                rows.append([d, _f(o[i], c[i]), _f(h[i], c[i]), _f(l[i], c[i]),
                             float(c[i]), v[i]])
            if rows:
                return _finalize(rows)
        except Exception as e:
            sys.stderr.write(f"[warn] yahoo {ticker} ({host}): {e}\n")
    return []


def fetch_stooq(ticker):
    url = f"https://stooq.com/q/d/l/?s={stooq_symbol(ticker)}&i=d"
    try:
        text = _get(url)
        lines = text.strip().splitlines()
        if not lines or not lines[0].lower().startswith("date"):
            raise ValueError(f"non-CSV response: {text[:60]!r}")
        rows = []
        for ln in lines[1:]:
            p = ln.split(",")
            if len(p) < 6 or p[1] in ("", "N/D"):
                continue
            rows.append([p[0], float(p[1]), float(p[2]), float(p[3]),
                         float(p[4]), float(p[5]) if p[5] not in ("", "N/D") else None])
        return _finalize(rows)
    except Exception as e:
        sys.stderr.write(f"[warn] stooq {ticker}: {e}\n")
    return []


def fetch_name(ticker):
    """Best-effort company name via Yahoo search (no key)."""
    if ticker in NAMES:
        return NAMES[ticker]
    try:
        url = f"https://query1.finance.yahoo.com/v1/finance/search?q={yahoo_symbol(ticker)}"
        data = json.loads(_get(url))
        for q in data.get("quotes", []):
            if (q.get("symbol") or "").upper() == yahoo_symbol(ticker):
                nm = q.get("shortname") or q.get("longname")
                if nm:
                    NAMES[ticker] = nm
                    return nm
    except Exception as e:
        sys.stderr.write(f"[warn] name {ticker}: {e}\n")
    return ticker


def fetch(ticker, retries=2):
    for attempt in range(retries):
        rows = fetch_yahoo(ticker) or fetch_stooq(ticker)
        if rows:
            return rows
        time.sleep(1.5 * (attempt + 1))
    return []


def read_config():
    out, seen = [], set()
    with open(CONFIG, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            t = (row.get("ticker") or "").strip()
            if not t:
                continue
            key = t.upper()
            if key in seen:        # skip duplicate tickers (first one wins)
                sys.stderr.write(f"[dedup] skipping duplicate ticker {t}\n")
                continue
            seen.add(key)
            out.append({
                "ticker": t,
                "exchange": (row.get("exchange") or "").strip(),
                "major": (row.get("major") or row.get("大类") or "国防航空航天").strip(),
                "sub": (row.get("sub") or row.get("小类") or "").strip(),
                "benchmark": (row.get("benchmark") or row.get("对标") or "").strip().upper(),
                "name": (row.get("name") or "").strip(),          # blank -> auto fetch
                "risk": float(row.get("risk") or RISK_DEFAULT),
                "breakout": float(row.get("breakout") or BREAKOUT_DEFAULT),
            })
    return out


def meta(c, name):
    exch = c["exchange"] or EXCH.get(c["ticker"], "")
    return {"ticker": c["ticker"], "name": name, "exchange": exch,
            "major": c["major"], "sub": c["sub"],
            "benchmark": c.get("benchmark", ""), "risk": c["risk"], "breakout": c["breakout"]}


def main():
    use_seed = "--seed" in sys.argv
    cfg = read_config()
    for c in cfg:
        if not c["benchmark"]:
            c["benchmark"] = "SPY"
            sys.stderr.write(f"[warn] {c['ticker']}: no benchmark in config.csv, defaulting to SPY\n")
    benches = sorted({c["benchmark"] for c in cfg if c["benchmark"]})

    if use_seed:
        seed = json.load(open(SEED, encoding="utf-8"))
        NAMES.update(seed.get("names", {}))
        get_ohlcv = lambda t: seed["prices"].get(t, [])
        get_bench = lambda b: seed["benchmarks"].get(b, [])
    else:
        cache = {}
        def get_ohlcv(t):
            if t not in cache:
                cache[t] = fetch(t)
                time.sleep(0.2)   # be polite to Yahoo across hundreds of tickers
            return cache[t]
        def get_bench(b):
            return [[x[0], x[4]] for x in get_ohlcv(b)]

    market, bench_ok = {}, {}
    for b in benches:
        raw = get_bench(b)
        series = compute_benchmark(raw) if raw else []
        bench_ok[b] = {r["date"]: r["ok"] for r in series if r["ok"] is not None}
        market[b] = series[-1] if series else None

    stocks = []
    for c in cfg:
        ohlcv = get_ohlcv(c["ticker"])
        name = c["name"] or NAMES.get(c["ticker"]) or (fetch_name(c["ticker"]) if not use_seed else c["ticker"])
        if not ohlcv:
            sys.stderr.write(f"[skip] no data for {c['ticker']}\n")
            stocks.append({**meta(c, name), "summary": {}, "rows": [], "error": "no_data"})
            continue
        rows, summary = compute_stock(ohlcv, bench_ok.get(c["benchmark"], {}),
                                      risk=c["risk"], breakout=c["breakout"])
        stocks.append({**meta(c, name), "summary": summary, "rows": rows})

    # Self-heal: some tickers fall a day behind when their first fetch fell back to
    # Stooq (slower EOD). Re-fetch the stragglers via Yahoo to pull them level with
    # the freshest date the rest of the universe reached.
    if not use_seed:
        cfg_by = {c["ticker"]: c for c in cfg}
        dated = [s for s in stocks if s.get("rows")]
        if dated:
            target = max(s["rows"][-1]["date"] for s in dated)
            lagging = [s for s in stocks if s.get("rows") and s["rows"][-1]["date"] < target]
            if lagging:
                sys.stderr.write(f"[heal] retrying {len(lagging)} tickers behind {target}\n")
            for s in lagging[:150]:
                t = s["ticker"]
                rows2 = fetch_yahoo(t)
                time.sleep(0.15)
                if rows2 and rows2[-1][0] > s["rows"][-1]["date"]:
                    c = cfg_by[t]
                    r2, sm2 = compute_stock(rows2, bench_ok.get(c["benchmark"], {}),
                                            risk=c["risk"], breakout=c["breakout"])
                    s["rows"], s["summary"] = r2, sm2

    have = sum(1 for s in stocks if s.get("rows"))
    if have == 0 and not use_seed:
        sys.stderr.write("[keep] no data fetched this run; existing files left unchanged\n")
        return

    os.makedirs(STOCK_DIR, exist_ok=True)
    gen = datetime.now(timezone.utc).isoformat(timespec="seconds")
    src = "seed" if use_seed else "yahoo/stooq"

    # 1) small index.json — meta + summary for every stock (NO history rows)
    index = {
        "generated_at": gen, "source": src, "market": rnd(market),
        "stocks": [{
            "ticker": s["ticker"], "name": s["name"], "exchange": s["exchange"],
            "benchmark": s.get("benchmark", ""), "major": s.get("major", ""),
            "sub": s.get("sub", ""), "risk": s.get("risk"), "breakout": s.get("breakout"),
            "file": safe_name(s["ticker"]) if s.get("rows") else None,
            "summary": rnd(s.get("summary", {})),
        } for s in stocks],
    }
    json.dump(index, open(INDEX_OUT, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))

    # 1b) permanent daily signal archive (survives beyond the 290-day rolling window)
    append_history_log(stocks)

    # 2) one compact file per stock — just the history rows (lazy-loaded on demand)
    keep = set()
    for s in stocks:
        if not s.get("rows"):
            continue
        fn = safe_name(s["ticker"]); keep.add(fn + ".json")
        json.dump({"ticker": s["ticker"], "rows": rnd(s["rows"])},
                  open(os.path.join(STOCK_DIR, fn + ".json"), "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
    # prune stale per-stock files (tickers removed from config)
    for f in os.listdir(STOCK_DIR):
        if f.endswith(".json") and f not in keep:
            try: os.remove(os.path.join(STOCK_DIR, f))
            except OSError: pass
    # drop the old monolithic file if present
    if os.path.exists(OUT):
        try: os.remove(OUT)
        except OSError: pass

    enter = sum(1 for s in stocks if s.get("summary", {}).get("signal") == "Enter")
    print(f"wrote {INDEX_OUT} + {len(keep)} stock files: "
          f"{have}/{len(stocks)} with data, {enter} ENTER, source={src}")


if __name__ == "__main__":
    main()
