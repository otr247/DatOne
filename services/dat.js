// services/dat.js — DAT load board (shared across all users).
//
// LIVE MODE: activates when DAT_API_TOKEN (Bearer) OR DAT_USERNAME+DAT_PASSWORD
// (Basic auth — the DAT REST service-account flow) is set.
//
// Endpoint contract — configurable via env so it matches the exact URLs in your
// DAT Developer Portal documentation (developer.dat.com):
//   DAT_BASE_URL         (default https://api.dat.com  — CONFIRM in your portal docs)
//   DAT_LOAD_SEARCH_PATH (default /loadboard/loads/search — CONFIRM in portal docs)
//   DAT_METHOD           (default GET; set POST if your API expects a JSON body)
//
// Response normalization: DAT load objects can arrive with different field
// names depending on API version. normalizeLoad() handles the common variants
// (camelCase / snake_case). If your portal docs show different fields, adjust
// normalizeLoad() only — everything else stays.
//
// Any error (auth, HTTP 4xx/5xx, timeout, unexpected shape) falls back to demo
// data so the app never crashes. Demo mode is used when no credentials exist.

function isConfigured() {
  return !!(process.env.DAT_API_TOKEN || (process.env.DAT_USERNAME && process.env.DAT_PASSWORD));
}

const datBaseUrl = () => (process.env.DAT_BASE_URL || 'https://api.dat.com').replace(/\/+$/, '');
const searchPath = () => (process.env.DAT_LOAD_SEARCH_PATH || '/loadboard/loads/search').replace(/^\/?/, '/');

// Full DAT equipment type list (matches real DAT One UI)
const EQUIPMENT_TYPES = [
  'Van', 'Reefer', 'Flatbed', 'Step Deck', 'RGN', 'Conestoga',
  'Lowboy', 'Power Only', 'Auto', 'Hotshot', 'Tanker', 'Bulk',
  'Double Drop', 'Stretch', 'Van/Reefer', 'Flatbed/Step Deck',
  'Container', 'Dump', 'End Dump', 'Side Dump', 'Hopper Bottom',
  'Pneumatic', 'Livestock', 'Logging', 'Car Carrier'
];

// City pairs for demo generation
const CITY_PAIRS = [
  ['Chicago, IL',      'Dallas, TX'],
  ['Atlanta, GA',      'Miami, FL'],
  ['Los Angeles, CA',  'Phoenix, AZ'],
  ['Denver, CO',       'Seattle, WA'],
  ['New York, NY',     'Charlotte, NC'],
  ['Houston, TX',      'Nashville, TN'],
  ['Kansas City, MO',  'Minneapolis, MN'],
  ['Portland, OR',     'Salt Lake City, UT'],
  ['Memphis, TN',      'Louisville, KY'],
  ['Columbus, OH',     'Pittsburgh, PA'],
  ['San Antonio, TX',  'El Paso, TX'],
  ['Indianapolis, IN', 'Cincinnati, OH'],
  ['Jacksonville, FL', 'Birmingham, AL'],
  ['Albuquerque, NM',  'Tucson, AZ'],
  ['Oklahoma City, OK','Little Rock, AR'],
  ['Fresno, CA',       'Sacramento, CA']
];

const BROKERS = ['TQL', 'CH Robinson', 'Landstar', 'Coyote', 'JB Hunt', 'Echo Global', 'RXO', 'Arrive Logistics', 'MoLo', 'Transfix', 'Convoy', 'GlobalTranz'];

// ─── Shared sort (used by demo + live paths so UX is identical) ─────────────
function sortLoads(list, sortKey) {
  const sort = sortKey || 'age_asc';
  list.sort((a, b) => {
    switch (sort) {
      case 'rate_desc':  return b.rate  - a.rate;
      case 'rpm_desc':   return b.rpm   - a.rpm;
      case 'age_asc':    return a.age_min - b.age_min;   // Newest first
      case 'dh_o_asc':   return a.dh_o  - b.dh_o;
      case 'dh_d_asc':   return a.dh_d  - b.dh_d;
      case 'miles_desc': return b.miles - a.miles;
      default:           return a.age_min - b.age_min;
    }
  });
  return list;
}

// ─── Demo generator (deterministic, feels alive) ────────────────────────────
function demoLoads(q) {
  const equips = q.equipment ? [q.equipment] : ['Van', 'Reefer', 'Flatbed', 'Step Deck', 'Power Only'];
  const now = Date.now();
  const seed = Math.floor(now / 15000); // Changes every 15s so refresh feels live

  const count = 20;
  const out = [];

  for (let i = 0; i < count; i++) {
    const pairIdx = (i + seed) % CITY_PAIRS.length;
    const [defaultO, defaultD] = CITY_PAIRS[pairIdx];
    const eq = equips[i % equips.length];
    const miles = 200 + ((i * 137 + seed * 31) % 2000);
    const baseRate = miles * (1.7 + (i % 7) * 0.12);
    const rate = Math.round(baseRate / 10) * 10;
    const rpm = +(rate / miles).toFixed(2);

    const dh_o = (i * 17 + seed * 3) % 150;
    const dh_d = (i * 23 + seed * 7) % 200;
    const weight = 10000 + ((i * 2500 + seed * 1000) % 34000);
    const length = [28, 40, 48, 53][(i + seed) % 4];
    const age_min = (i * 11 + seed * 13) % 240;

    out.push({
      id: 'DAT-' + (1000 + i + (seed % 100) * 100),
      age_min,
      origin:      q.origin      || defaultO,
      destination: q.destination || defaultD,
      equipment: eq,
      miles,
      rate,
      rpm,
      dh_o,
      dh_d,
      weight,
      length,
      broker:  BROKERS[(i + seed) % BROKERS.length],
      contact: '(800) 555-0' + String(100 + i).slice(-3),
      // v2.6: listing contact extras so the Email/Call actions are testable in demo mode
      ref: 'REF-' + (8200 + i + seed * 13),
      extension: (i % 4 === 0) ? 'x' + (100 + i) : '',
      broker_email: (i % 3 === 0)
        ? 'loads@' + BROKERS[(i + seed) % BROKERS.length].toLowerCase().replace(/[^a-z0-9]/g, '') + '.com'
        : '',
      comments: (i % 5 === 0) ? 'Lumper included. Appointment required. 2 stops.' : ''
    });
  }

  let result = out;
  if (q.max_dh_o  !== undefined && q.max_dh_o !== '')  result = result.filter(l => l.dh_o  <= Number(q.max_dh_o));
  if (q.max_dh_d  !== undefined && q.max_dh_d !== '')  result = result.filter(l => l.dh_d  <= Number(q.max_dh_d));
  if (q.max_age   !== undefined && q.max_age  !== '')  result = result.filter(l => l.age_min <= Number(q.max_age));
  if (q.min_rate  !== undefined && q.min_rate !== '')  result = result.filter(l => l.rate  >= Number(q.min_rate));
  if (q.min_rpm   !== undefined && q.min_rpm  !== '')  result = result.filter(l => l.rpm   >= Number(q.min_rpm));
  if (q.max_weight !== undefined && q.max_weight !== '') result = result.filter(l => l.weight <= Number(q.max_weight));
  if (q.length    !== undefined && q.length   !== '')  result = result.filter(l => l.length === Number(q.length));

  return sortLoads(result, q.sort);
}

// ─── Live DAT API ────────────────────────────────────────────────────────────

function authHeaders() {
  if (process.env.DAT_API_TOKEN) {
    return { Authorization: `Bearer ${process.env.DAT_API_TOKEN}` };
  }
  const b64 = Buffer.from(`${process.env.DAT_USERNAME}:${process.env.DAT_PASSWORD}`).toString('base64');
  return { Authorization: `Basic ${b64}` };
}

function sortParam(sortKey) {
  switch (sortKey || 'age_asc') {
    case 'rate_desc':  return 'rate_desc';
    case 'rpm_desc':   return 'ratePerMile_desc';
    case 'dh_o_asc':   return 'deadheadOrigin_asc';
    case 'dh_d_asc':   return 'deadheadDestination_asc';
    case 'miles_desc': return 'miles_desc';
    default:           return 'age_asc';
  }
}

// Map a raw DAT load object (camelCase/snake_case) to our UI shape.
function normalizeLoad(raw, idx) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

  const miles = num(pick('miles', 'mileage', 'distance', 'loadedMiles'));
  const rate = num(pick('rate', 'totalRate', 'offerAmount', 'lineHaulRate', 'amount'));
  let rpm = num(pick('rpm', 'ratePerMile', 'ratePerMileAmount'));
  if (!rpm) rpm = miles > 0 ? +(rate / miles).toFixed(2) : 0;

  return {
    id: String(pick('id', 'loadId', 'postingId', 'loadNumber', 'load_number') || `DAT-LIVE-${Date.now()}-${idx}`),
    age_min: num(pick('ageMin', 'age_min', 'ageInMinutes', 'postAgeMinutes', 'age')),
    origin: pick('origin', 'pickupCity', 'pickup', 'originCity', 'pickupCityName') || '',
    destination: pick('destination', 'deliveryCity', 'deliverTo', 'destinationCity', 'deliveryCityName') || '',
    equipment: pick('equipment', 'equipmentType', 'trailerType', 'equipmentGroup') || '',
    miles,
    rate,
    rpm: +rpm.toFixed(2),
    dh_o: num(pick('dh_o', 'dhO', 'deadheadOrigin', 'deadheadMilesOrigin', 'dhFromOrigin')),
    dh_d: num(pick('dh_d', 'dhD', 'deadheadDestination', 'deadheadMilesDestination', 'dhToDestination')),
    weight: num(pick('weight', 'loadWeight', 'grossWeight', 'weightLbs')),
    length: num(pick('length', 'trailerLength', 'equipmentLength', 'lengthFeet')),
    broker: pick('broker', 'brokerName', 'companyName', 'contactName', 'brokerCompany') || '',
    contact: pick('contact', 'brokerPhone', 'phone', 'contactPhone', 'brokerContact') || '',
    // v2.6: structured listing contact data — drives the one-click Email/Call
    // actions. DAT's standard loadboard API may not include email/comments
    // (those can be paid add-ons); extraction is defensive and just leaves
    // them empty when the API doesn't provide them.
    ref: pick('ref', 'reference', 'referenceNumber', 'postingRef', 'loadRef', 'brokerRef', 'refNumber') || '',
    extension: pick('extension', 'ext', 'brokerExtension', 'phoneExtension', 'contactExtension', 'extensionNumber') || '',
    broker_email: pick('brokerEmail', 'broker_email', 'contactEmail', 'postingEmail', 'brokerEmailAddress', 'email') || '',
    comments: pick('comments', 'postComments', 'notes', 'remarks', 'postingNotes', 'description', 'specialInstructions', 'freeText') || ''
  };
}

async function liveSearch(q) {
  const params = {
    origin: q.origin || undefined,
    destination: q.destination || undefined,
    equipment: q.equipment || undefined,
    maxAgeMinutes: q.max_age !== undefined && q.max_age !== '' ? Number(q.max_age) : undefined,
    minRate: q.min_rate !== undefined && q.min_rate !== '' ? Number(q.min_rate) : undefined,
    minRatePerMile: q.min_rpm !== undefined && q.min_rpm !== '' ? Number(q.min_rpm) : undefined,
    maxWeight: q.max_weight !== undefined && q.max_weight !== '' ? Number(q.max_weight) : undefined,
    length: q.length !== undefined && q.length !== '' ? Number(q.length) : undefined,
    maxDeadheadOrigin: q.max_dh_o !== undefined && q.max_dh_o !== '' ? Number(q.max_dh_o) : undefined,
    maxDeadheadDestination: q.max_dh_d !== undefined && q.max_dh_d !== '' ? Number(q.max_dh_d) : undefined,
    sortBy: sortParam(q.sort)
  };
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));

  const method = (process.env.DAT_METHOD || 'GET').toUpperCase();
  const url = `${datBaseUrl()}${searchPath()}${method === 'GET' ? '?' + new URLSearchParams(clean).toString() : ''}`;

  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders() },
    body: method === 'POST' ? JSON.stringify(clean) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`DAT API HTTP ${res.status}`);

  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.loads || data.data || data.results || data.postings);
  if (!Array.isArray(list)) throw new Error('Unexpected DAT response shape');

  return sortLoads(
    list.map((raw, i) => normalizeLoad(raw, i)).filter(l => l.origin || l.destination || l.rate),
    q.sort
  );
}

async function search(query) {
  const q = query || {};
  if (!isConfigured()) return demoLoads(q);
  try {
    const live = await liveSearch(q);
    return live; // real results (possibly empty = no matches) — never demo on success
  } catch (e) {
    console.error('[DAT] live API failed, using demo data:', e.message);
    return demoLoads(q);
  }
}

module.exports = { isConfigured, search, EQUIPMENT_TYPES };
