# DAT Board — Competitive Feature Review

Compare of the **DAT Load Board tab inside Dispatch Hub (DAT One app)** against the
leading load-board / TMS tools. Sources are listed inline; anything not from a
source is marked as *assessment*.

---

## 1. Feature matrix

| Feature | Dispatch Hub DAT tab | DAT One (load board) | Truckstop | Notes |
|---|---|---|---|---|
| Lane search (origin → destination) | ✅ | ✅ | ✅ | |
| Equipment type filter (25 types) | ✅ (full DAT list) | ✅ | ✅ | |
| Max age / min rate / min RPM filters | ✅ | ✅ | ✅ | |
| Deadhead filters (DH-O / DH-D) | ✅ | ✅ | ✅ | DAT One shows DH in results |
| Max weight / trailer length filters | ✅ | ✅ | ⚠️ varies | |
| Sorting (age, rate, RPM, DH, miles) | ✅ | ✅ | ✅ | |
| **Multiple simultaneous searches (3 tabs)** | ✅ 3 independent tabs, each auto-refreshing | ⚠️ DAT One uses saved searches, not parallel tabs | ⚠️ saved searches | *Assessment:* parallel tabs is a differentiator for dispatchers juggling lanes |
| Auto-refresh + "+N new loads" badge | ✅ 5s, active tab only | ✅ | ✅ | |
| Book load → creates load record | ✅ one click into Loads + Sheets | ✅ | ✅ | |
| Broker name + phone on result | ✅ | ✅ | ✅ | |
| Broker **credit score / days-to-pay** | ❌ (needs DAT credit add-on) | ✅ (paid add-on) | ✅ | **Gap** — see recommendations |
| Lane rate history / benchmarks (15-day avg) | ❌ (needs DAT RateView API) | ✅ (65k+ lanes, 15-day avg) | ✅ | **Gap** — see recommendations |
| Live real-time feed (paid DAT API) | ✅ when DAT_API_TOKEN set (wired v2.3) | ✅ | ✅ | same DAT source |
| Demo mode (no credentials) | ✅ seamless | n/a | n/a | lets you use the board before paying for DAT |
| PWA install (phone/desktop icon, offline) | ✅ | ✅ (native + web) | ✅ | |
| Mobile-first | ✅ PWA, responsive | ✅ | ✅ | |

Sources: [dat.com/load-boards](https://www.dat.com/load-boards),
[dat.com/solutions/power-only-load-board](https://www.dat.com/solutions/power-only-load-board)
(15-day averages, 65,000+ lanes), [freightwaves.com power-only guide](https://www.freightwaves.com/checkpoint/power-only-load-boards/)
(broker credit data, market data), [dat.com/api-integration](https://www.dat.com/api-integration)
(Load Board / BookNow / Tracking / Freight Posting APIs).

---

## 2. Where we already win

- **3 parallel search tabs** — DAT One and Truckstop use saved searches; our 3 live
  tabs let a dispatcher watch three lanes at once with independent auto-refresh.
- **Zero-cost demo** — the board is fully usable before you pay for the DAT API;
  one env var flips it to live.
- **Tight integration** — Book → Load record → Google Sheets + Drive paperwork in
  two clicks, which standalone boards don't do.
- **Unlimited seats** — one DAT subscription feeds the whole team (DAT One charges
  per user tier: Standard $49 → Office $290/mo per
  [americantruckersllc.com](https://www.americantruckersllc.com/blog/best-load-boards-owner-operators-2026.html)).

## 3. Gaps vs the big boards (and how to close them)

1. **Broker credit score + days-to-pay** — the #1 thing carriers check before
   booking. DAT exposes this as a paid add-on via its APIs; wire it into the DAT
   result row (and into the Loads sheet as two columns). *Requires DAT credit add-on.*
2. **Lane rate benchmarks (15-day averages)** — DAT RateView API gives per-lane
   averages; add a "Lane Avg" chip on results + in the Templates rate negotiation
   text. *Requires RateView API.*
3. **Saved searches / alerts** — persist each tab's filters per user and add
   optional email alerts when a matching load posts. *Frontend + small DB table.*
4. **One-click BookNow** — DAT's BookNow API can submit the booking directly to the
   broker instead of the current "create record + you call" flow. *Requires BookNow API.*
5. **Sort on broker** and a **"hide loads from brokers already contacted"** toggle —
   cheap wins that reduce spam when you've booked a lane.
6. **Distance/rate badges on mobile** — row density is already mobile-friendly; add
   rate-per-mile color coding (green ≥ $2.5) for at-a-glance scanning. *Pure CSS.*

## 4. Recommendation

Our board already matches the core filter/sort/refresh functionality of DAT One and
Truckstop and adds parallel tabs + full app integration. To be genuinely "best":
prioritize **#1 broker credit** and **#2 lane benchmarks** (both are DAT paid
add-ons on the same subscription) — they're the features dispatchers name first
when asked why they keep DAT One open. #3 saved searches and #4 BookNow are the
next tier. Everything else is polish.

*Assessment note: specific Truckstop UI details vary by plan; the matrix reflects
publicly documented capabilities, not per-plan availability.*
