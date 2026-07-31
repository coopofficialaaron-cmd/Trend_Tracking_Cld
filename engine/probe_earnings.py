#!/usr/bin/env python3
"""
Probe which free earnings-calendar source works from a GitHub Actions runner.

Run once via the probe-earnings workflow, then paste the log back.
It only READS public endpoints and writes nothing.
"""
import json, sys, time, urllib.request, urllib.error, http.cookiejar
from datetime import date, timedelta

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TEST = ["AAPL", "NVDA", "XOM", "MOG.A", "KGS"]   # mix of large + small caps


def get(url, headers=None, opener=None, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    op = opener or urllib.request.build_opener()
    with op.open(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def show(name, ok, detail):
    mark = "PASS" if ok else "FAIL"
    print(f"\n[{mark}] {name}\n      {detail}")


# ---------- 1) Yahoo quoteSummary, no auth ----------
def probe_yahoo_plain():
    try:
        st, body = get("https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL"
                       "?modules=calendarEvents")
        j = json.loads(body)
        ev = j["quoteSummary"]["result"][0]["calendarEvents"]["earnings"]["earningsDate"]
        show("Yahoo quoteSummary (no auth)", True, f"AAPL earningsDate raw={ev}")
        return True
    except Exception as e:
        show("Yahoo quoteSummary (no auth)", False, f"{type(e).__name__}: {e}")
        return False


# ---------- 2) Yahoo quoteSummary with cookie + crumb ----------
def probe_yahoo_crumb():
    try:
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        # seed cookies
        try:
            get("https://fc.yahoo.com", opener=op)
        except Exception:
            pass          # this endpoint often 404s but still sets cookies
        st, crumb = get("https://query2.finance.yahoo.com/v1/test/getcrumb", opener=op)
        crumb = crumb.strip()
        if not crumb or len(crumb) > 40:
            show("Yahoo quoteSummary (cookie+crumb)", False, f"no usable crumb (got {crumb!r})")
            return False
        out = {}
        for t in TEST:
            sym = t.replace(".", "-")
            try:
                st, body = get(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{sym}"
                               f"?modules=calendarEvents&crumb={urllib.parse.quote(crumb)}", opener=op)
                j = json.loads(body)
                ed = j["quoteSummary"]["result"][0]["calendarEvents"]["earnings"]["earningsDate"]
                dates = [time.strftime("%Y-%m-%d", time.gmtime(d["raw"])) for d in ed if d.get("raw")]
                out[t] = dates or "empty"
            except Exception as e:
                out[t] = f"ERR {type(e).__name__}"
            time.sleep(0.3)
        ok = sum(1 for v in out.values() if isinstance(v, list) and v)
        show("Yahoo quoteSummary (cookie+crumb)", ok >= 3,
             f"crumb={crumb!r}  results={json.dumps(out, ensure_ascii=False)}")
        return ok >= 3
    except Exception as e:
        show("Yahoo quoteSummary (cookie+crumb)", False, f"{type(e).__name__}: {e}")
        return False


# ---------- 3) Nasdaq earnings calendar by date ----------
def probe_nasdaq():
    """We only ever need a small window, so per-date pages are cheap."""
    try:
        d = date.today()
        found, pages = {}, 0
        for off in range(0, 6):                   # next 6 calendar days
            day = d + timedelta(days=off)
            if day.weekday() >= 5:
                continue
            url = f"https://api.nasdaq.com/api/calendar/earnings?date={day.isoformat()}"
            st, body = get(url, headers={"Accept": "application/json"})
            pages += 1
            j = json.loads(body)
            rows = ((j.get("data") or {}).get("rows")) or []
            for r in rows:
                sym = (r.get("symbol") or "").strip().upper()
                if sym:
                    found.setdefault(sym, (day.isoformat(), r.get("time", "")))
            time.sleep(0.4)
        sample = {t: found.get(t.upper(), "not in window") for t in TEST}
        show("Nasdaq calendar/earnings", pages > 0 and len(found) > 50,
             f"{pages} pages, {len(found)} tickers in next ~6d\n      "
             f"sample={json.dumps(sample, ensure_ascii=False)}")
        return len(found) > 50
    except Exception as e:
        show("Nasdaq calendar/earnings", False, f"{type(e).__name__}: {e}")
        return False


# ---------- 4) Yahoo v7 quote (earningsTimestamp) ----------
def probe_yahoo_v7():
    try:
        st, body = get("https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,NVDA")
        j = json.loads(body)
        res = j["quoteResponse"]["result"]
        got = {r["symbol"]: r.get("earningsTimestamp") for r in res}
        show("Yahoo v7 quote (earningsTimestamp)", bool(res), f"{got}")
        return bool(res)
    except Exception as e:
        show("Yahoo v7 quote (earningsTimestamp)", False, f"{type(e).__name__}: {e}")
        return False


if __name__ == "__main__":
    import urllib.parse
    print("=" * 68)
    print("EARNINGS-DATE SOURCE PROBE  (read-only, writes nothing)")
    print("=" * 68)
    results = {
        "yahoo_plain": probe_yahoo_plain(),
        "yahoo_crumb": probe_yahoo_crumb(),
        "nasdaq":      probe_nasdaq(),
        "yahoo_v7":    probe_yahoo_v7(),
    }
    print("\n" + "=" * 68)
    print("SUMMARY:", json.dumps(results))
    winners = [k for k, v in results.items() if v]
    print("USABLE SOURCES:", winners or "NONE — need another approach")
    print("=" * 68)
