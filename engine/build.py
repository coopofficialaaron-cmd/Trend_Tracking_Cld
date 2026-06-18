"""
build.py — fetch daily OHLCV (free, no API key) and compute the model.

Data source: Yahoo Finance chart API (primary) with Stooq as fallback.
Both are free and need no key. US symbols use the plain ticker; a dot becomes
a dash (MOG.A -> MOG-A). Yahoo is used first because Stooq blocks cloud/CI IPs.

Usage:
  python engine/build.py            # fetch live, write docs/data/latest.json
  python engine/build.py --seed     # use bundled engine/seed_prices.json (offline)

Add a stock: append a row to config.csv. The next run picks it up. No new tab.
"""
import csv, json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone
from indicators import compute_benchmark, compute_stock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(ROOT, "config.csv")
OUT = os.path.join(ROOT, "docs", "data", "latest.json")
SEED = os.path.join(HERE, "seed_prices.json")
LOOKBACK_DAYS = 420  # enough for SMA100 + 55-day windows with margin
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def yahoo_symbol(ticker):
    return ticker.strip().upper().replace(".", "-")


def stooq_symbol(ticker):
    return ticker.strip().lower().replace(".", "-") + ".us"


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json,text/plain,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _f(v, fallback):
    return float(v) if v is not None else float(fallback)


def fetch_yahoo(ticker):
    """Return [[date, o, h, l, c, v], ...] ascending, or []."""
    sym = yahoo_symbol(ticker)
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = (f"https://{host}/v8/finance/chart/{sym}"
               f"?range=2y&interval=1d&includePrePost=false")
        try:
            data = json.loads(_get(url))
            res = (data.get("chart", {}).get("result") or [None])[0]
            if not res:
                continue
            ts = res.get("timestamp") or []
            q = (res.get("indicators", {}).get("quote") or [{}])[0]
            o, h, l, c, v = (q.get("open"), q.get("high"), q.get("low"),
                             q.get("close"), q.get("volume"))
            rows = []
            for i, t in enumerate(ts):
                if not c or c[i] is None:
                    continue
                d = datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()
                rows.append([d, _f(o[i], c[i]), _f(h[i], c[i]), _f(l[i], c[i]),
                             float(c[i]), v[i]])
            if rows:
                rows.sort(key=lambda r: r[0])
                return rows[-LOOKBACK_DAYS:]
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
        rows.sort(key=lambda r: r[0])
        return rows[-LOOKBACK_DAYS:]
    except Exception as e:
        sys.stderr.write(f"[warn] stooq {ticker}: {e}\n")
    return []


def fetch(ticker, retries=2):
    """Yahoo first, then Stooq. Light retry with backoff."""
    for attempt in range(retries):
        rows = fetch_yahoo(ticker)
        if rows:
            return rows
        rows = fetch_stooq(ticker)
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
                "benchmark": (row.get("benchmark") or "").strip(),
                "risk": float(row.get("risk") or 25),
                "breakout": float(row.get("breakout") or 0.01),
                "type": (row.get("type") or "").strip(),
                "name": (row.get("name") or "").strip() or t,
            })
    return out


def meta(c):
    return {"ticker": c["ticker"], "name": c["name"], "type": c["type"],
            "benchmark": c["benchmark"], "risk": c["risk"], "breakout": c["breakout"]}


def main():
    use_seed = "--seed" in sys.argv
    cfg = read_config()
    benches = sorted({c["benchmark"] for c in cfg if c["benchmark"]})

    if use_seed:
        seed = json.load(open(SEED, encoding="utf-8"))
        get_ohlcv = lambda t: seed["prices"].get(t, [])
        get_bench = lambda b: seed["benchmarks"].get(b, [])
    else:
        cache = {}
        def get_ohlcv(t):
            if t not in cache:
                cache[t] = fetch(t)
            return cache[t]
        def get_bench(b):
            return [[x[0], x[4]] for x in get_ohlcv(b)]  # date, close

    market, bench_ok = {}, {}
    for b in benches:
        raw = get_bench(b)
        series = compute_benchmark(raw) if raw else []
        bench_ok[b] = {r["date"]: r["ok"] for r in series if r["ok"] is not None}
        market[b] = series[-1] if series else None

    stocks = []
    for c in cfg:
        ohlcv = get_ohlcv(c["ticker"])
        if not ohlcv:
            sys.stderr.write(f"[skip] no data for {c['ticker']}\n")
            stocks.append({**meta(c), "summary": {}, "rows": [], "error": "no_data"})
            continue
        rows, summary = compute_stock(ohlcv, bench_ok.get(c["benchmark"], {}),
                                      risk=c["risk"], breakout=c["breakout"])
        stocks.append({**meta(c), "summary": summary, "rows": rows})

    have = sum(1 for s in stocks if s.get("rows"))
    if have == 0 and not use_seed:
        sys.stderr.write("[keep] no data fetched this run; existing latest.json left unchanged\n")
        return  # exit 0 — keep the previous file, don't fail the scheduled job

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
