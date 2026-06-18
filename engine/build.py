"""
build.py — fetch daily OHLCV (free, no API key) and compute the model.

Data source: Stooq (https://stooq.com).  US symbols use the ".us" suffix,
e.g. AIR -> air.us, MOG.A -> mog-a.us, ITA -> ita.us.

Usage:
  python engine/build.py            # fetch live from Stooq, write data/latest.json
  python engine/build.py --seed     # use bundled engine/seed_prices.json (offline)

Add a stock: append a row to config.csv. The next run picks it up. No new tab.
"""
import csv, json, os, sys, time, urllib.request
from datetime import datetime, timezone
from indicators import compute_benchmark, compute_stock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(ROOT, "config.csv")
OUT = os.path.join(ROOT, "docs", "data", "latest.json")
SEED = os.path.join(HERE, "seed_prices.json")
LOOKBACK_DAYS = 420  # enough for SMA100 + 55-day windows with margin


def stooq_symbol(ticker):
    return ticker.strip().lower().replace(".", "-") + ".us"


def fetch_stooq(ticker, retries=3):
    """Return list of [date, open, high, low, close, volume] ascending, or []."""
    url = f"https://stooq.com/q/d/l/?s={stooq_symbol(ticker)}&i=d"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", "replace")
            lines = text.strip().splitlines()
            if not lines or not lines[0].lower().startswith("date"):
                raise ValueError(f"unexpected response for {ticker}: {text[:80]!r}")
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
            sys.stderr.write(f"[warn] {ticker} attempt {attempt+1}: {e}\n")
            time.sleep(2 * (attempt + 1))
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


def main():
    use_seed = "--seed" in sys.argv
    cfg = read_config()
    benches = sorted({c["benchmark"] for c in cfg if c["benchmark"]})

    if use_seed:
        seed = json.load(open(SEED, encoding="utf-8"))
        price_of = lambda t: seed["prices"].get(t, [])
        bench_raw = lambda b: seed["benchmarks"].get(b, [])
    else:
        cache = {}
        def price_of(t):
            if t not in cache:
                cache[t] = fetch_stooq(t)
            return cache[t]
        bench_raw = lambda b: price_of_bench(b, cache)

    def price_of_bench(b, cache):
        if b not in cache:
            r = fetch_stooq(b)
            cache[b] = [[x[0], x[4]] for x in r]  # date, close
        return cache[b]

    # benchmark ok maps
    market = {}
    bench_ok = {}
    for b in benches:
        raw = bench_raw(b)
        series = compute_benchmark(raw) if raw else []
        bench_ok[b] = {r["date"]: r["ok"] for r in series if r["ok"] is not None}
        market[b] = series[-1] if series else None

    stocks = []
    for c in cfg:
        ohlcv = price_of(c["ticker"])
        if not ohlcv:
            sys.stderr.write(f"[skip] no data for {c['ticker']}\n")
            stocks.append({**meta(c), "summary": {}, "rows": [], "error": "no_data"})
            continue
        okmap = bench_ok.get(c["benchmark"], {})
        rows, summary = compute_stock(ohlcv, okmap, risk=c["risk"], breakout=c["breakout"])
        stocks.append({**meta(c), "summary": summary, "rows": rows})

    have = sum(1 for s in stocks if s.get("rows"))
    if have == 0 and not use_seed:
        sys.stderr.write("[abort] no data fetched for any ticker; keeping existing latest.json\n")
        sys.exit(1)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "seed" if use_seed else "stooq",
        "market": market,
        "stocks": stocks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    enter = sum(1 for s in stocks if s.get("summary", {}).get("signal") == "Enter")
    print(f"wrote {OUT}: {len(stocks)} stocks, {enter} ENTER signals, source={payload['source']}")


def meta(c):
    return {"ticker": c["ticker"], "name": c["name"], "type": c["type"],
            "benchmark": c["benchmark"], "risk": c["risk"], "breakout": c["breakout"]}


if __name__ == "__main__":
    main()
