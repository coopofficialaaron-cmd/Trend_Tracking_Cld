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
OUT = os.path.join(ROOT, "docs", "data", "latest.json")
SEED = os.path.join(HERE, "seed_prices.json")

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
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = (f"https://{host}/v8/finance/chart/{sym}"
               f"?range=2y&interval=1d&includePrePost=false")
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
    out = []
    with open(CONFIG, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            t = (row.get("ticker") or "").strip()
            if not t:
                continue
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

    have = sum(1 for s in stocks if s.get("rows"))
    if have == 0 and not use_seed:
        sys.stderr.write("[keep] no data fetched this run; existing latest.json left unchanged\n")
        return

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "seed" if use_seed else "yahoo/stooq",
        "market": market,
        "stocks": stocks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    enter = sum(1 for s in stocks if s.get("summary", {}).get("signal") == "Enter")
    print(f"wrote {OUT}: {have}/{len(stocks)} stocks with data, {enter} ENTER, source={payload['source']}")


if __name__ == "__main__":
    main()
