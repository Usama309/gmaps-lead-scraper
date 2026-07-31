/**
 * Filter-rail interaction that dashboard.js does not otherwise drive.
 *
 * EXTRACTED FROM AN INLINE <script>, which never ran. An MV3 extension page forbids
 * inline script under `script-src 'self'`, so every line of this was silently blocked
 * and threw a CSP error on every load: the category typeahead and the location-mode
 * toggle were dead controls that looked live. Found by reading the extension's own
 * runtime errors during the Phase 3 live run, not by any test.
 *
 * tests/filter.test.js now forbids an inline script in this page, which closes the
 * whole class rather than this one instance.
 */
(function () {
  // The sample-data render path (LEADS, LASTDAYS, passes(), stripeColor(), render())
  // is gone. dashboard.js owns real data, real filtering and real rendering now;
  // everything left in this block is cosmetic rail interaction that dashboard.js
  // does not otherwise drive (category typeahead, location-mode toggle, export
  // format toggle, sort-arrow display).
  var state = { web:"any", phone:"any", mob:"any", book:"any", mail:"any",
                tech:[], score:55, minrev:10, maxrev:500, lastrev:0,
                sort:"score", dir:-1, fmt:"CSV" };

  // Representative slice of the Google Business Profile taxonomy. The real build
  // bundles the full published list and matches on it.
  var CATEGORIES = ("Accountant,Advertising agency,Air conditioning repair service,Architect,"+
    "Auto body shop,Auto repair shop,Bakery,Bank,Bar,Barber shop,Beauty salon,Bicycle shop,"+
    "Bookstore,Butcher shop,Cafe,Car dealer,Car wash,Carpenter,Caterer,Chiropractor,"+
    "Cleaning service,Clothing store,Coffee shop,Computer repair service,Construction company,"+
    "Consultant,Dance school,Day care center,Dentist,Dermatologist,Driving school,Dry cleaner,"+
    "Electrician,Employment agency,Event planner,Eye care center,Financial consultant,"+
    "Fitness centre,Florist,Funeral home,Furniture store,Garden centre,General contractor,"+
    "Grocery store,Gym,Hair salon,Hardware store,Home builder,Hotel,Insurance agency,"+
    "Interior designer,Internet marketing service,Jeweler,Laundry service,Law firm,Lawyer,"+
    "Locksmith,Marketing agency,Massage therapist,Medical clinic,Mobile phone repair shop,"+
    "Mortgage broker,Moving company,Nail salon,Notary public,Nutritionist,Optician,"+
    "Orthodontist,Painter,Pest control service,Pet groomer,Pharmacy,Photographer,"+
    "Physiotherapist,Plumber,Print shop,Real estate agency,Restaurant,Roofing contractor,"+
    "School,Security service,Solar energy company,Spa,Sporting goods store,Storage facility,"+
    "Supermarket,Tailor,Tattoo shop,Tax preparation service,Taxi service,Therapist,Tyre shop,"+
    "Towing service,Travel agency,Tutoring service,Used car dealer,Veterinarian,Web designer,"+
    "Wedding planner,Yoga studio").split(",");

  var $ = function (s) { return document.querySelector(s); };

  function esc(t) {
    return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // Segmented groups toggle visually here. dashboard.js binds its own listener to
  // the same buttons and drives the real filter state and re-render from that.
  document.querySelectorAll(".mp-seg").forEach(function (grp) {
    grp.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        grp.querySelectorAll("button").forEach(function (b) {
          b.setAttribute("aria-pressed", "false");
        });
        btn.setAttribute("aria-pressed", "true");
        Object.keys(btn.dataset).forEach(function (k) { state[k] = btn.dataset[k]; });
      });
    });
  });

  // Technology chips are owned by dashboard.js, which binds its own toggle to
  // .mp-chip[data-tech]. Binding the same read-then-flip toggle here too would
  // race the two handlers and cancel the visible state out on every click, so
  // this legacy handler is scoped to the chips dashboard.js does not touch
  // (social links), which stay decorative until Phase 2 wires that filter.
  document.querySelectorAll(".mp-chip:not([data-tech])").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", on ? "false" : "true");
    });
  });

  $("#f-score").addEventListener("input", function (e) {
    state.score = +e.target.value;
    $("#f-scoreval").textContent = state.score;
  });
  $("#f-lastrev").addEventListener("change", function (e) {
    state.lastrev = +e.target.value;
  });

  // Locate by place name vs raw coordinates
  document.querySelectorAll("[data-locmode]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var coords = btn.dataset.locmode === "coords";
      $("#loc-coords").hidden = !coords;
      $("#loc-place").hidden = coords;
    });
  });

  // Category typeahead with chips
  var catList = $("#cat-list"), catChips = $("#cat-chips"), catInput = $("#f-cat");
  var chosen = [];
  CATEGORIES.forEach(function (c) {
    var o = document.createElement("option"); o.value = c; catList.appendChild(o);
  });
  function drawCats() {
    catChips.innerHTML = chosen.map(function (c, i) {
      return '<span>' + esc(c) + ' <b data-i="' + i + '" role="button" tabindex="0" ' +
             'aria-label="Remove ' + esc(c) + '">&times;</b></span>';
    }).join("");
    $("#cat-count").textContent = chosen.length;
    catChips.querySelectorAll("b").forEach(function (x) {
      x.addEventListener("click", function () { chosen.splice(+x.dataset.i, 1); drawCats(); });
    });
  }
  function addCat(v) {
    v = (v || "").trim();
    if (v && chosen.indexOf(v) === -1) { chosen.push(v); drawCats(); }
    catInput.value = "";
  }
  catInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addCat(catInput.value); }
  });
  catInput.addEventListener("change", function () {
    if (CATEGORIES.indexOf(catInput.value) !== -1) addCat(catInput.value);
  });
  drawCats();

  $("#f-minrev").addEventListener("input", function (e) { state.minrev = +e.target.value || 0; });
  $("#f-maxrev").addEventListener("input", function (e) { state.maxrev = +e.target.value || 1e9; });

  // Sort-arrow display only. Column-header sorting is not wired to the real
  // dataset in this phase; DEFAULT_FILTER_STATE still drives sort via sortBy.
  document.querySelectorAll("th.sortable").forEach(function (th) {
    th.addEventListener("click", function () {
      var k = th.dataset.sort;
      state.dir = (state.sort === k) ? -state.dir : -1;
      state.sort = k;
      document.querySelectorAll("th.sortable .arw").forEach(function (a) { a.remove(); });
      var arw = document.createElement("span");
      arw.className = "arw";
      arw.innerHTML = state.dir === -1 ? "&nbsp;&#9660;" : "&nbsp;&#9650;";
      th.appendChild(arw);
    });
  });

  document.querySelectorAll("[data-fmt]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("[data-fmt]").forEach(function (b) {
        b.setAttribute("aria-pressed", "false");
      });
      btn.setAttribute("aria-pressed", "true");
      state.fmt = btn.dataset.fmt;
    });
  });

  // The real export button is bound in dashboard.js, which calls MSG.EXPORT and
  // markExported. Nothing here duplicates that.
})();
