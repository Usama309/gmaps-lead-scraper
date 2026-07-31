# First run: proving MapProspector works

Everything in this project has so far been tested against data I constructed. This is the first
time it touches Google. Work through it in order and stop at the first step that does not match,
because every later step depends on the earlier ones.

Budget about fifteen minutes. Have the extension folder at `~/Sites/gmaps-lead-scraper` to hand.

---

## Before you start, two things worth knowing

**Requests go out logged out.** Every Google request the extension makes uses `credentials: 'omit'`,
so no Google account of yours is attached. There is no account to suspend. That was a deliberate
design control, not a default.

**Start small.** Step 4 uses a 2 km radius, which is a single query leg. Do not widen it until the
whole checklist has passed once. If anything is wrong, you want to find out after one query rather
than after sixty.

---

## 1. Load the extension

Use **Comet**, on the **Usama** profile. Branded Google Chrome 137 and later ignores
the command line switch that loads an unpacked extension, so the scripted route does
not work there; Comet still honours it. Verified on 2026-07-31 against Comet
150.0.7871.228.

1. Open `chrome://extensions`
2. Turn on **Developer mode**, top right
3. Click **Load unpacked** and choose `~/Sites/gmaps-lead-scraper`

**What you should see:** a card named MapProspector, version 0.1.0, with **no error text** on it.

**If the card shows errors:** copy them and stop. A content script that fails to parse reports here,
and that exact failure is what an earlier version of this code had.

Note the extension ID on the card. It should read `ghnhjhnldonkhjojmclnimghpcgocmce`. If it does not,
the pinned key in the manifest is not being read, which matters later for Google Sheets in Phase 4.

---

## 2. Verify the capture path, from the PAGE console

This is the most important step in the list and the easiest to do wrongly. The extension harvests by
lifting an opaque parameter out of a request Google itself makes. If that fails, harvesting returns
nothing and it looks exactly like an empty city.

Check it from the **page** console, not the extension's. A check against the extension's own console
passes even when the content script never ran at all.

1. Open `https://www.google.com/maps/search/dentist+in+Attock/`
2. Let the results list finish loading
3. Open DevTools on that page (Cmd+Option+I) and go to **Console**
4. Run each of these:

```js
window.__mapProspectorPatched
```
**Expected:** an object. If it says `undefined`, the observer never installed. Stop.

```js
window.fetch.name
```
**Expected:** `"observedFetch"` in a clean browser.

**In your normal Comet profile it will read something else, often an empty string, and
that is fine.** Other extensions wrap `fetch` too, and whichever wraps last owns the
name. Ours still sits in the chain and still captures. Measured in the Usama profile
on 2026-07-31: the name was empty and capture worked.

The check that actually matters is step 5 below: if `latestPb` holds a long string,
the capture path works, whatever `fetch.name` says.

5. Now open the **service worker** console: on the `chrome://extensions` card, click
   **service worker**. Run:

```js
chrome.storage.session.get('latestPb').then(console.log)
```
**Expected:** an object containing `latestPb` with a long string, well over 50 characters.

**If steps 4 passed but 5 shows nothing:** the page-side observer is working but the relay to the
extension is not. Tell me and I will look at the bridge.

6. Back on the page console, check for red errors from either content script. There should be none.

---

## 3. Open the controls

Click the MapProspector toolbar icon. The side panel opens on the right.

You should see fields for keywords, latitude, longitude and radius, pre-filled with your Attock
coordinates: `33.7609824` and `72.342874`.

---

## 4. The first harvest, deliberately tiny

1. Set **Keywords** to `dentist` only. One keyword.
2. Leave latitude and longitude as they are.
3. Set **Radius** to `2`. This is one query leg, not a sweep.
4. Click **Start harvest**

**What you should see in the log**, newest at the top:
- a starting line naming the keyword and radius
- one or more leg progress lines showing new and unique counts
- a finishing line reading `finished: end_of_list` or `finished: cap_reached`, with a non-zero count

**Roughly how long:** under a minute for 2 km.

**If you see `finished: completed_with_errors`:** the run reached the end of its queue but at least
one query failed along the way. The problems are listed underneath. The lead list is real but
incomplete, which is why it does not say plain "completed".

**If you see `PAUSED`:** Google asked us to stop. That is handled deliberately: the run halts rather
than pushing through, and it will not have hammered anything. Wait a few minutes before retrying, and
tell me what the message said.

**If you see a message about responses slowing sustainedly:** that is the throttle's early warning,
which fires before Google actually blocks anything. It needs three consecutive slow replies to
trigger, so a single slow request will not cause it. Same advice: wait a few minutes, and tell me.

**If it finishes with zero businesses:** stop, and tell me. That is the symptom that means the
payload indices have moved, and the canary should have caught it and said so rather than returning an
empty list quietly.

**If you see `COVERAGE CUT`:** that is the tool being honest, not an error. It means the caps shrank
the area actually searched, and it tells you by how much. At 2 km you should not see it.

**You WILL see a line about results falling outside the radius, and it will be a big number.** At
2 km live it read `195 results fell outside the 2 km radius and were discarded`, against 17 kept.
That is correct and expected. Google treats the radius as a hint and widens a search when local
results run out, so it returned businesses as far away as Peshawar. The radius is enforced on our
side, after the fact, which is the only place it can be enforced. The number is shown rather than
hidden because its size tells you something real: a large one means the radius is thinner than the
keyword can fill.

---

## 5. Look at the results

Click **Open dashboard**. A new tab opens with the filter rail and the table.

**Check these four things:**

1. **The businesses are real.** You should recognise them as actual Attock dentists. If you see
   Al-Shifa Dental Clinic or Glow Beauty Salon exactly as they appeared in the mockup I showed you
   earlier, that is sample data leaking through and I need to know.
2. **Scores are present and the reasons make sense.** Each row carries short chips explaining its
   score, like `No website` or `dentist, no online booking`. Read a couple and check they match what
   you would say about that business.
3. **Some rows may say "score provisional".** That is correct at this stage. Website enrichment is
   Phase 2, so mobile-friendliness and booking are not yet known, and the score is a floor rather
   than a final number.
4. **Filtering costs nothing.** Drag the score slider and toggle Website to **None**. The row count
   should change instantly. Open the Network tab first if you like: there should be no requests at
   all. That is the whole point of the design.

---

## 6. Export, and prove the duplicate skipping works

1. Click **Export**. A CSV downloads.
2. Open it in Numbers or Excel.

**Check:**
- Column count matches the header, and nothing is shifted
- The `Why it scored` column is readable
- A `Score provisional` column reads **yes** on every row. That is correct for Phase 1 and it is in
  the file deliberately, so a CSV that outlives this conversation still says its scores are a floor
- `Mobile friendly` and `Online booking` read **unknown** rather than blank or no. That distinction
  is deliberate: unknown means never inspected, which is different from inspected and absent
- No cell begins with a bare `=` or `@`. Business names that start with those are prefixed with an
  apostrophe so your spreadsheet cannot execute them

3. Go back to the dashboard and click **Export** again. **Skip duplicates** is ticked by default, so
   leave it alone.

**Expected:** the count drops to zero. Every lead was already exported, so there is nothing new. That
proves cross-run deduplication works, which is what stops you phoning the same dentist twice. Untick
Skip duplicates and the full count comes back.

4. Re-run the same 2 km harvest from step 4.

**Expected:** the unique count in the dashboard does not double. Merging on re-harvest works.

---

## What a real run will cost you in time

These are **measured on 2026-07-30 against Attock**, not estimated. An earlier version of this table
was estimated and was wrong by roughly an order of magnitude, because it assumed a leg stops early in
a thin market. It does not: Google widens a search that runs out of local results, so almost every
leg runs to the 247 cap regardless of how small the town is.

| Search | Query legs | Measured | Notes |
|---|---|---|---|
| 1 keyword, 2 km | 1 | 40 seconds, 17 leads | the first-run setting above |
| 1 keyword, 15 km | 21 | about 60 seconds per leg, so 20 min | 7 legs in 5 min gave 42 leads |

The second row is the important one, and its shape is worth understanding before you widen anything.
Leg 1 returned 40 businesses. Legs 2 through 7 added **two more between them**. That is not a fault:
every tile query returns much the same widened result set, and the radius filter then keeps the same
local businesses each time. A wider radius mostly buys more waiting.

**The practical advice:** run one keyword at a time and start at 2 km. Widen only when a radius stops
producing new names.

The throttle is deliberately slow: 1.2 to 2.8 seconds between requests, randomised. That is what
keeps the run below the rate where recon saw any pressure from Google, and it is the main reason a
wide search takes minutes rather than seconds.

Note the third and fourth rows both report COVERAGE CUT. That is the tool telling you it searched
less than you asked for, and by how much. It is not an error, and the honest response is either to
narrow the radius or run one keyword at a time.

## When it all passes

Tell me and I will widen the defaults, and we can talk about Phase 2, which adds website enrichment:
platform detection, mobile friendliness, booking widgets and email. That is what turns a provisional
score into a real one, and it is what most of your actual pitch depends on.

## If something fails

Copy the exact text and tell me which step. Do not widen the radius to see if it "works better" at a
larger size, because a fault at 2 km becomes sixty faults at 30 km, and the throttling is there to
keep you out of trouble.
