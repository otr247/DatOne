/* Dispatch Hub — app.js (multi-tenant frontend) */
(function () {
  'use strict';

  // ---------- Tiny helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const fmt$ = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtN = (n) => (Number(n) || 0).toLocaleString();

  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 2800);
  }

  // API base: same-origin in the browser; the live Render backend inside the
  // native app shell (Capacitor sets window.API_BASE in index.html).
  function apiBase() {
    return (window.API_BASE || '').replace(/\/+$/, '');
  }

  async function api(method, url, body, isForm) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    else if (body && isForm) { opts.body = body; }
    const res = await fetch(apiBase() + url, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  // ---------- State ----------
  const state = {
    me: null,
    contacts: [],
    loads: [],
    integrations: null,
    charts: {},
    datTabs: [],        // 3 independent DAT search tabs
    datActiveTab: 0,    // currently visible tab index
    datRefreshTimer: null
  };

  // ---------- Modal helpers ----------
  function openModal(title, bodyHtml, footHtml, wide) {
    const host = $('#modalHost');
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal ${wide ? 'wide' : ''}">
          <div class="modal-head">
            <h3>${esc(title)}</h3>
            <button class="modal-close" type="button">&times;</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-foot">${footHtml || ''}</div>
        </div>
      </div>`;
    const close = () => { host.innerHTML = ''; };
    $('.modal-close', host).onclick = close;
    $('.modal-backdrop', host).addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
    return { close, host };
  }

  // ---------- Auth ----------
  async function tryLogin(u, p) {
    const r = await api('POST', '/api/login', { username: u, password: p });
    state.me = r.user;
    return r.user;
  }

  async function loadMe() {
    try {
      const r = await api('GET', '/api/me');
      state.me = r.user;
      return r.user;
    } catch { return null; }
  }

  function showLogin() {
    $('#loginView').style.display = 'flex';
    $('#appView').classList.remove('visible');
  }

  // ── Forgot / reset password views ─────────────────────────────────────────
  let resetTokenState = null;

  function showForgot() {
    $('#loginView').style.display = 'none';
    $('#resetView').style.display = 'none';
    $('#forgotUserView').style.display = 'none';
    $('#forgotView').style.display = 'flex';
    $('#forgotErr').classList.remove('show');
    $('#forgotOk').classList.remove('show');
    $('#forgotId').value = '';
  }

  function showForgotUser() {
    $('#loginView').style.display = 'none';
    $('#resetView').style.display = 'none';
    $('#forgotView').style.display = 'none';
    $('#forgotUserView').style.display = 'flex';
    $('#forgotUserErr').classList.remove('show');
    $('#forgotUserOk').classList.remove('show');
    $('#forgotUserId').value = '';
  }

  function showLoginView() {
    $('#forgotView').style.display = 'none';
    $('#forgotUserView').style.display = 'none';
    $('#resetView').style.display = 'none';
    $('#loginView').style.display = 'flex';
  }

  async function showReset(token) {
    resetTokenState = token;
    $('#loginView').style.display = 'none';
    $('#forgotView').style.display = 'none';
    $('#forgotUserView').style.display = 'none';
    $('#resetView').style.display = 'flex';
    $('#resetErr').classList.remove('show');
    $('#resetOk').classList.remove('show');
    $('#resetForm').style.display = '';
    $('#resetPass').value = '';
    $('#resetPass2').value = '';
    $('#resetBack').textContent = 'Back to sign in';
    $('#resetSubmitBtn').disabled = true;
    $('#resetForUser').textContent = '';
    try {
      const r = await api('GET', '/api/reset/info?token=' + encodeURIComponent(token));
      if (r.valid) {
        $('#resetForUser').textContent = 'Reset password for: ' + r.username;
        $('#resetSubmitBtn').disabled = false;
      } else {
        $('#resetErr').textContent = 'This reset link is invalid or has expired. Request a new one.';
        $('#resetErr').classList.add('show');
      }
    } catch {
      $('#resetErr').textContent = 'Could not validate this reset link. Please request a new one.';
      $('#resetErr').classList.add('show');
    }
  }

  async function showApp() {
    $('#loginView').style.display = 'none';
    $('#appView').classList.add('visible');
    $('#whoName').textContent = state.me.full_name || state.me.username;
    $('#whoRole').textContent = state.me.role;
    // Admin-only nav visibility
    $$('.admin-only').forEach(el => el.classList.toggle('show', state.me.role === 'admin'));

    if (state.me.must_change_password) {
      openForcedPasswordChange();
    }
    await loadAllForCurrentUser();
    showPage('dashboard');
    // Handle post-Google-OAuth redirect flag
    const qp = new URLSearchParams(location.search);
    if (qp.get('google') === 'connected') { toast('Google account connected', 'success'); history.replaceState({}, '', '/'); }
    if (qp.get('google') === 'error') { toast('Google connection failed', 'error'); history.replaceState({}, '', '/'); }
  }

  async function loadAllForCurrentUser() {
    // Every request is auto-scoped server-side by owner_id = req.user.id
    const [contacts, loads] = await Promise.all([
      api('GET', '/api/contacts'),
      api('GET', '/api/loads')
    ]);
    state.contacts = contacts;
    state.loads = loads;
  }

  // ---------- Mobile menu ----------
  function closeMenu() {
    $('#sidebar') && $('#sidebar').classList.remove('open');
    $('#menuBackdrop') && $('#menuBackdrop').classList.remove('show');
  }
  function toggleMenu() {
    $('#sidebar').classList.toggle('open');
    $('#menuBackdrop').classList.toggle('show');
  }

  // ---------- Pages / routing ----------
  function showPage(name) {
    closeMenu();
    // DAT board on a phone → suggest landscape
    const hint = $('#datRotateHint');
    if (hint) hint.style.display = (name === 'datboard' && window.matchMedia('(max-width: 900px)').matches) ? 'block' : 'none';
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));

    // Stop DAT auto-refresh when leaving the page
    if (name !== 'datboard' && state.datRefreshTimer) {
      clearInterval(state.datRefreshTimer);
      state.datRefreshTimer = null;
    }
    if (name !== 'negotiations' && negTimer) {
      clearInterval(negTimer);
      negTimer = null;
    }

    const renderer = pageRenderers[name];
    if (renderer) renderer();
  }

  const pageRenderers = {
    dashboard: renderDashboard,
    loads: renderLoads,
    carriers: () => renderContacts('carrier', 'carriersBody'),
    drivers: () => renderContacts('driver', 'driversBody'),
    brokers: () => renderContacts('broker', 'brokersBody'),
    datboard: renderDatBoard,
    outreach: renderOutreach,
    voicecalls: renderCallLog,
    aichat: renderAIChat,
    templates: renderTemplates,
    negotiations: renderNegotiations,
    users: renderUsers,
    mail: renderMail,
    settings: renderSettings
  };

  // ---------- DASHBOARD ----------
  const perfState = { period: 'weekly', carrierId: '' };

  async function renderDashboard() {
    // Refresh carrier scope options (in case contacts changed)
    const carrierSel = $('#perfCarrier');
    if (carrierSel) {
      const current = carrierSel.value;
      carrierSel.innerHTML = '<option value="">All Carriers</option>' +
        state.contacts
          .filter(c => c.type === 'carrier')
          .map(c => `<option value="${c.id}">${esc(c.name)}${c.company ? ' (' + esc(c.company) + ')' : ''}</option>`)
          .join('');
      carrierSel.value = perfState.carrierId && [...carrierSel.options].some(o => o.value === perfState.carrierId) ? perfState.carrierId : '';
      perfState.carrierId = carrierSel.value;
    }

    const q = new URLSearchParams();
    if (perfState.period) q.set('period', perfState.period);
    if (perfState.carrierId) q.set('carrier_id', perfState.carrierId);
    const perf = await api('GET', '/api/performance?' + q.toString());
    const t = perf.totals || { revenue: 0, fees: 0, miles: 0, count: 0, rpm: 0 };
    const scopeLabel = perf.carrier_id ? (state.contacts.find(c => c.id == perf.carrier_id) || {}).name : 'All Carriers';
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="lbl">Total Revenue · ${esc(scopeLabel)}</div><div class="val">${fmt$(t.revenue)}</div></div>
      <div class="kpi"><div class="lbl">Dispatch Fees</div><div class="val">${fmt$(t.fees)}</div></div>
      <div class="kpi"><div class="lbl">Total Miles</div><div class="val">${fmtN(t.miles)}</div></div>
      <div class="kpi"><div class="lbl">Loads</div><div class="val">${fmtN(t.count)}</div></div>
      <div class="kpi"><div class="lbl">Avg RPM</div><div class="val">$${(t.rpm || 0).toFixed(2)}</div></div>`;
    drawRevChart(perf.series || []);
    drawRpmChart(perf.series || []);
    drawLoadsChart(perf.series || []);
    drawStatusChart(perf.statusCounts || {});
  }

  function drawRevChart(series) {
    const ctx = $('#revChart').getContext('2d');
    if (state.charts.rev) state.charts.rev.destroy();
    ctx.canvas.style.maxHeight = '220px';
    state.charts.rev = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: series.map(s => s.label),
        datasets: [
          { label: 'Revenue', data: series.map(s => s.revenue), backgroundColor: '#ff7a00' },
          { label: 'Dispatch Fee', data: series.map(s => s.fees), backgroundColor: '#0f172a' }
        ]
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 2.5, plugins: { legend: { position: 'bottom' } } }
    });
  }
  function drawRpmChart(series) {
    const ctx = $('#rpmChart').getContext('2d');
    if (state.charts.rpm) state.charts.rpm.destroy();
    ctx.canvas.style.maxHeight = '220px';
    state.charts.rpm = new Chart(ctx, {
      type: 'line',
      data: {
        labels: series.map(s => s.label),
        datasets: [{
          label: 'Avg RPM',
          data: series.map(s => (s.miles > 0 ? +(s.revenue / s.miles).toFixed(2) : 0)),
          borderColor: '#16a34a',
          backgroundColor: 'rgba(22,163,74,0.12)',
          fill: true,
          tension: 0.3
        }]
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 2.5, plugins: { legend: { position: 'bottom' } } }
    });
  }
  function drawLoadsChart(series) {
    const ctx = $('#loadsChart').getContext('2d');
    if (state.charts.loads) state.charts.loads.destroy();
    ctx.canvas.style.maxHeight = '220px';
    state.charts.loads = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: series.map(s => s.label),
        datasets: [{ label: 'Loads', data: series.map(s => s.count), backgroundColor: '#3b82f6' }]
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 2.5, plugins: { legend: { position: 'bottom' } } }
    });
  }
  function drawStatusChart(counts) {
    const ctx = $('#statusChart').getContext('2d');
    if (state.charts.status) state.charts.status.destroy();
    ctx.canvas.style.maxHeight = '220px';
    const labels = Object.keys(counts);
    state.charts.status = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: labels.map(k => counts[k]),
          backgroundColor: ['#ff7a00', '#0f172a', '#16a34a', '#dc2626', '#eab308', '#3b82f6']
        }]
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 2, plugins: { legend: { position: 'bottom' } } }
    });
  }

  // ---------- LOADS ----------
  async function renderLoads() {
    state.loads = await api('GET', '/api/loads');
    const rows = state.loads.map(l => `
      <tr>
        <td><b>${esc(l.ref)}</b></td>
        <td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td>
        <td>${esc(l.origin || '—')} → ${esc(l.destination || '—')}</td>
        <td>${esc(l.broker || '')}${l.broker_email ? `<br><span class="muted">${esc(l.broker_email)}</span>` : ''}</td>
        <td>${esc(l.carrier_name || '')}</td>
        <td>${esc(l.driver_name || '')}${(l.driver_phone || l.driver_email) ? `<br><span class="muted">${esc([l.driver_phone, l.driver_email].filter(Boolean).join(' · '))}</span>` : ''}</td>
        <td>${fmt$(l.rate)}</td>
        <td>${fmt$(l.dispatch_fee)}</td>
        <td class="row-actions">
          <button class="btn small" data-act="docs" data-id="${l.id}">📎</button>
          <button class="btn small" data-act="edit" data-id="${l.id}">✏️</button>
          <button class="btn small danger" data-act="del" data-id="${l.id}">🗑</button>
        </td>
      </tr>`).join('');
    $('#loadsBody').innerHTML = rows || '<tr><td colspan="9" class="empty">No loads yet. Click "+ New Load" to create your first one.</td></tr>';
    $$('#loadsBody [data-act]').forEach(b => b.onclick = () => {
      const l = state.loads.find(x => x.id == b.dataset.id);
      if (b.dataset.act === 'edit') openLoadForm(l);
      else if (b.dataset.act === 'del') deleteLoad(l);
      else if (b.dataset.act === 'docs') openDocsModal(l);
    });
  }

  function openLoadForm(load) {
    const isNew = !load;
    load = load || { ref: 'L-' + Date.now(), status: 'booked' };
    const carriers = state.contacts.filter(c => c.type === 'carrier');
    const drivers = state.contacts.filter(c => c.type === 'driver');
    const brokers = state.contacts.filter(c => c.type === 'broker');
    const brokerOpts = brokers.map(b => `<option value="${esc(b.company || b.name)}" data-email="${esc(b.email || '')}" data-phone="${esc(b.phone || '')}"></option>`).join('');
    const body = `
      <form id="loadForm">
        <div class="form-grid">
          <div class="field"><label>Reference</label><input name="ref" value="${esc(load.ref)}" required></div>
          <div class="field"><label>Status</label>
            <select name="status">
              ${['booked', 'in_transit', 'delivered', 'cancelled', 'available'].map(s => `<option value="${s}" ${load.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Broker</label>
            <input name="broker" value="${esc(load.broker || '')}" list="brokerList">
            <datalist id="brokerList">${brokerOpts}</datalist>
          </div>
          <div class="field"><label>Broker Email</label><input name="broker_email" value="${esc(load.broker_email || '')}"></div>
          <div class="field"><label>Broker Phone</label><input name="broker_phone" value="${esc(load.broker_phone || '')}"></div>
          <div class="field"><label>Equipment</label><input name="equipment" value="${esc(load.equipment || '')}"></div>
          <div class="field"><label>Origin</label><input name="origin" value="${esc(load.origin || '')}"></div>
          <div class="field"><label>Destination</label><input name="destination" value="${esc(load.destination || '')}"></div>
          <div class="field"><label>Pickup Date</label><input name="pickup_date" type="date" value="${esc(load.pickup_date || '')}"></div>
          <div class="field"><label>Delivery Date</label><input name="delivery_date" type="date" value="${esc(load.delivery_date || '')}"></div>
          <div class="field"><label>Miles</label><input name="miles" type="number" value="${load.miles || 0}"></div>
          <div class="field"><label>Rate ($)</label><input name="rate" type="number" step="0.01" value="${load.rate || 0}"></div>
          <div class="field"><label>Dispatch Fee ($)</label><input name="dispatch_fee" type="number" step="0.01" value="${load.dispatch_fee || 0}"></div>
          <div class="field"><label>Carrier</label>
            <select name="carrier_id"><option value="">—</option>${carriers.map(c => `<option value="${c.id}" ${load.carrier_id == c.id ? 'selected' : ''}>${esc(c.name)} ${c.company ? '(' + esc(c.company) + ')' : ''}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Driver</label>
            <select name="driver_id"><option value="">—</option>${drivers.map(d => `<option value="${d.id}" ${load.driver_id == d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Driver Email</label><input name="driver_email" value="${esc(load.driver_email || '')}"></div>
          <div class="field"><label>Driver Phone</label><input name="driver_phone" value="${esc(load.driver_phone || '')}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes" rows="3">${esc(load.notes || '')}</textarea></div>
      </form>`;
    const foot = `<button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">${isNew ? 'Create' : 'Save'}</button>`;
    const m = openModal(isNew ? 'New Load' : 'Edit Load', body, foot, true);
    $('#mCancel').onclick = m.close;

    // Auto-calculate dispatch fee when carrier or rate changes
    function recalcFee() {
      const sel = $('select[name="carrier_id"]', m.host);
      const rateEl = $('input[name="rate"]', m.host);
      const feeEl = $('input[name="dispatch_fee"]', m.host);
      if (!sel || !rateEl || !feeEl) return;
      const cid = sel.value;
      if (!cid) return;
      const carrier = state.contacts.find(c => c.id == cid);
      if (!carrier || !carrier.dispatch_pct) return;
      const rate = parseFloat(rateEl.value) || 0;
      feeEl.value = (rate * carrier.dispatch_pct / 100).toFixed(2);
    }
    $('select[name="carrier_id"]', m.host).addEventListener('change', recalcFee);
    $('input[name="rate"]', m.host).addEventListener('input', recalcFee);

    // ── Interlinked contacts: pick a broker or driver → details auto-fill ──
    const brokerInput  = $('input[name="broker"]', m.host);
    const brokerEmailEl = $('input[name="broker_email"]', m.host);
    const brokerPhoneEl = $('input[name="broker_phone"]', m.host);
    function fillBrokerFromContact() {
      const v = (brokerInput.value || '').trim().toLowerCase();
      if (!v) return;
      const match = brokers.find(b => (b.name || '').toLowerCase() === v || (b.company || '').toLowerCase() === v);
      if (match) {
        if (!brokerEmailEl.value) brokerEmailEl.value = match.email || '';
        if (!brokerPhoneEl.value) brokerPhoneEl.value = match.phone || '';
      }
    }
    if (brokerInput) {
      brokerInput.addEventListener('input', fillBrokerFromContact);
      brokerInput.addEventListener('change', fillBrokerFromContact);
    }

    const driverSel   = $('select[name="driver_id"]', m.host);
    const driverEmailEl = $('input[name="driver_email"]', m.host);
    const driverPhoneEl = $('input[name="driver_phone"]', m.host);
    function fillDriverFromContact() {
      const d = state.contacts.find(c => c.id == driverSel.value);
      if (d) {
        // Explicit driver selection → their contact details win (still editable)
        driverEmailEl.value = d.email || '';
        driverPhoneEl.value = d.phone || '';
      }
    }
    if (driverSel) driverSel.addEventListener('change', fillDriverFromContact);
    // Editing an existing load: prefill from the load snapshot if present
    if (!isNew && (load.driver_email || load.driver_phone)) {
      if (!driverEmailEl.value) driverEmailEl.value = load.driver_email || '';
      if (!driverPhoneEl.value) driverPhoneEl.value = load.driver_phone || '';
    }

    $('#mSave').onclick = async () => {
      const fd = new FormData($('#loadForm'));
      const data = Object.fromEntries(fd.entries());
      try {
        if (isNew) await api('POST', '/api/loads', data);
        else await api('PUT', '/api/loads/' + load.id, data);
        m.close();
        toast('Load saved', 'success');
        await renderLoads();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function deleteLoad(load) {
    if (!confirm(`Delete load ${load.ref}?`)) return;
    await api('DELETE', '/api/loads/' + load.id);
    toast('Load deleted', 'success');
    await renderLoads();
  }

  async function openDocsModal(load) {
    const docs = await api('GET', `/api/loads/${load.id}/documents`);
    const list = docs.map(d => `
      <li>
        <a href="/api/documents/${d.id}" target="_blank">📄 ${esc(d.filename)}</a>
        <span>
          <span class="muted">${(d.size / 1024).toFixed(1)} KB</span>
          <button class="btn small danger" data-del="${d.id}">🗑</button>
        </span>
      </li>`).join('');
    const body = `
      <p class="muted">Load <b>${esc(load.ref)}</b> — attach ratecon, POD, BOL, etc.</p>
      <ul class="doc-list">${list || '<li class="empty" style="justify-content:center">No documents yet</li>'}</ul>
      <form id="upForm">
        <div class="field"><label>Upload file (max 10 MB)</label><input type="file" name="file" required></div>
        <button class="btn primary" type="submit">Upload</button>
      </form>`;
    const m = openModal('Load Documents', body, `<button class="btn" id="mClose">Close</button>`);
    $('#mClose').onclick = m.close;
    $$('#modalHost [data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this document?')) return;
      await api('DELETE', '/api/documents/' + b.dataset.del);
      m.close();
      openDocsModal(load);
    });
    $('#upForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('POST', `/api/loads/${load.id}/documents`, fd, true);
        toast('Uploaded', 'success');
        m.close();
        openDocsModal(load);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ---------- CONTACTS (carriers / drivers / brokers) ----------
  async function renderContacts(type, bodyId) {
    state.contacts = await api('GET', '/api/contacts');
    const list = state.contacts.filter(c => c.type === type);
    let rows = '';
    if (type === 'carrier') {
      rows = list.map(c => `
        <tr>
          <td><b>${esc(c.name)}</b></td>
          <td>${esc(c.company || '')}</td>
          <td>${esc(c.manager_name || '')}</td>
          <td>${c.dispatch_pct || 0}%</td>
          <td>${esc(c.phone || '')}</td>
          <td>${esc(c.email || '')}</td>
          <td class="row-actions">
            <button class="btn small" data-act="edit" data-id="${c.id}">✏️</button>
            <button class="btn small danger" data-act="del" data-id="${c.id}">🗑</button>
          </td>
        </tr>`).join('');
    } else if (type === 'driver') {
      const carrierName = (id) => (state.contacts.find(x => x.id == id) || {}).name || '';
      rows = list.map(c => {
        const endorsements = [c.has_hazmat && 'HAZMAT', c.has_twic && 'TWIC', c.has_tsa && 'TSA'].filter(Boolean).join(', ');
        return `
        <tr>
          <td><b>${esc(c.name)}</b></td>
          <td>${esc(carrierName(c.parent_carrier_id))}</td>
          <td>${esc(c.cdl_type || '')}</td>
          <td>${esc(endorsements)}</td>
          <td>${esc(c.truck_unit || '')}</td>
          <td>${esc(c.truck_type || '')}</td>
          <td>${esc(c.phone || '')}</td>
          <td class="row-actions">
            <button class="btn small" data-act="edit" data-id="${c.id}">✏️</button>
            <button class="btn small danger" data-act="del" data-id="${c.id}">🗑</button>
          </td>
        </tr>`;
      }).join('');
    } else {
      rows = list.map(c => `
        <tr>
          <td><b>${esc(c.name)}</b></td>
          <td>${esc(c.company || '')}</td>
          <td>${esc(c.phone || '')}</td>
          <td>${esc(c.email || '')}</td>
          <td>${esc(c.notes || '')}</td>
          <td class="row-actions">
            <button class="btn small" data-act="edit" data-id="${c.id}">✏️</button>
            <button class="btn small danger" data-act="del" data-id="${c.id}">🗑</button>
          </td>
        </tr>`).join('');
    }
    $('#' + bodyId).innerHTML = rows || `<tr><td colspan="8" class="empty">No ${type}s yet.</td></tr>`;
    $$('#' + bodyId + ' [data-act]').forEach(b => b.onclick = () => {
      const c = state.contacts.find(x => x.id == b.dataset.id);
      if (b.dataset.act === 'edit') openContactForm(type, c);
      else if (b.dataset.act === 'del') deleteContact(c);
    });
  }

  function openContactForm(type, contact) {
    const isNew = !contact;
    contact = contact || { type };
    const carriers = state.contacts.filter(c => c.type === 'carrier');
    let extra = '';
    if (type === 'carrier') {
      extra = `
        <div class="form-grid">
          <div class="field"><label>Manager Name</label><input name="manager_name" value="${esc(contact.manager_name || '')}"></div>
          <div class="field"><label>Dispatch %</label><input name="dispatch_pct" type="number" step="0.1" value="${contact.dispatch_pct || 0}"></div>
        </div>`;
    } else if (type === 'driver') {
      extra = `
        <div class="form-grid">
          <div class="field"><label>Parent Carrier</label>
            <select name="parent_carrier_id"><option value="">—</option>
              ${carriers.map(c => `<option value="${c.id}" ${contact.parent_carrier_id == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>CDL Type</label>
            <select name="cdl_type">
              <option value="">—</option>
              ${['CDL-A', 'CDL-B', 'Non-CDL'].map(t => `<option ${contact.cdl_type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="check-row">
          <label><input type="checkbox" name="has_hazmat" ${contact.has_hazmat ? 'checked' : ''}> HAZMAT</label>
          <label><input type="checkbox" name="has_twic" ${contact.has_twic ? 'checked' : ''}> TWIC</label>
          <label><input type="checkbox" name="has_tsa" ${contact.has_tsa ? 'checked' : ''}> TSA</label>
        </div>
        <div class="form-grid">
          <div class="field"><label>Truck Unit</label><input name="truck_unit" value="${esc(contact.truck_unit || '')}"></div>
          <div class="field"><label>Truck Type</label><input name="truck_type" value="${esc(contact.truck_type || '')}"></div>
          <div class="field"><label>Length (ft)</label><input name="truck_length" type="number" value="${contact.truck_length || ''}"></div>
          <div class="field"><label>GVWR (lbs)</label><input name="truck_weight" type="number" value="${contact.truck_weight || ''}"></div>
        </div>
        <div class="field"><label>Driver Notes</label><textarea name="driver_notes" rows="2">${esc(contact.driver_notes || '')}</textarea></div>`;
    }
    const body = `
      <form id="contactForm">
        <input type="hidden" name="type" value="${type}">
        <div class="form-grid">
          <div class="field"><label>Name *</label><input name="name" value="${esc(contact.name || '')}" required></div>
          <div class="field"><label>Company</label><input name="company" value="${esc(contact.company || '')}"></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(contact.phone || '')}"></div>
          <div class="field"><label>Email</label><input name="email" type="email" value="${esc(contact.email || '')}"></div>
        </div>
        ${extra}
        <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(contact.notes || '')}</textarea></div>
      </form>`;
    const foot = `<button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">${isNew ? 'Create' : 'Save'}</button>`;
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    const m = openModal(isNew ? `New ${label}` : `Edit ${label}`, body, foot, true);
    $('#mCancel').onclick = m.close;
    $('#mSave').onclick = async () => {
      const fd = new FormData($('#contactForm'));
      const data = Object.fromEntries(fd.entries());
      // checkboxes only appear when checked — normalize
      data.has_hazmat = fd.get('has_hazmat') ? 1 : 0;
      data.has_twic = fd.get('has_twic') ? 1 : 0;
      data.has_tsa = fd.get('has_tsa') ? 1 : 0;
      try {
        if (isNew) await api('POST', '/api/contacts', data);
        else await api('PUT', '/api/contacts/' + contact.id, data);
        m.close();
        toast('Saved', 'success');
        await renderContacts(type, type + 'sBody');
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function deleteContact(c) {
    if (!confirm(`Delete ${c.name}?`)) return;
    await api('DELETE', '/api/contacts/' + c.id);
    toast('Deleted', 'success');
    await renderContacts(c.type, c.type + 'sBody');
  }

  // ---------- DAT BOARD ----------

  // Full equipment type list matching real DAT One
  const DAT_EQUIP_TYPES = [
    'Van', 'Reefer', 'Flatbed', 'Step Deck', 'RGN', 'Conestoga',
    'Lowboy', 'Power Only', 'Auto', 'Hotshot', 'Tanker', 'Bulk',
    'Double Drop', 'Stretch', 'Van/Reefer', 'Flatbed/Step Deck',
    'Container', 'Dump', 'End Dump', 'Side Dump', 'Hopper Bottom',
    'Pneumatic', 'Livestock', 'Logging', 'Car Carrier'
  ];

  function defaultDatQuery() {
    return {
      origin: '', destination: '', equipment: '', max_dh_o: '', max_dh_d: '',
      max_age: '', min_rate: '', min_rpm: '', max_weight: '', length: '', sort: 'age_asc'
    };
  }

  // Ensure the 3 independent search tabs exist (each keeps its own query/results)
  function ensureDatTabs() {
    if (!state.datTabs || state.datTabs.length !== 3) {
      state.datTabs = [0, 1, 2].map(i => ({
        id: i,
        label: `Search ${i + 1}`,
        query: defaultDatQuery(),
        loads: [],
        newCount: 0,
        mode: ''
      }));
    }
  }

  function activeDatTab() { return state.datTabs[state.datActiveTab]; }

  function renderDatBoard() {
    renderDatPrefChips();
    ensureDatTabs();
    // Tab bar lives in index.html; bind tab buttons each visit
    $$('.dat-tab').forEach(btn => {
      btn.onclick = () => setActiveDatTab(Number(btn.dataset.tab));
    });
    renderActiveDatTab();
    // Start auto-refresh every 5 seconds (background, active tab only)
    if (state.datRefreshTimer) clearInterval(state.datRefreshTimer);
    state.datRefreshTimer = setInterval(() => datSilentRefresh(), 5000);
  }

  function setActiveDatTab(idx) {
    state.datActiveTab = idx;
    renderActiveDatTab();
  }

  function renderActiveDatTab() {
    const tab = activeDatTab();
    $$('.dat-tab').forEach(b => b.classList.toggle('active', Number(b.dataset.tab) === tab.id));

    const filterEl = $('#datFilters');
    if (filterEl) {
      filterEl.innerHTML = datFilterHtml(tab);
      wireDatFilters(tab);
    }
    const modeEl = $('#datMode');
    if (modeEl) modeEl.textContent = tab.mode || 'Set filters and click Search';
    updateDatBadge(tab);
    renderDatRows(tab);
  }

  function datFilterHtml(tab) {
    const q = tab.query;
    const optsFor = (key, opts) => `<option value="">— Any —</option>${opts.map(o => `<option value="${esc(o)}" ${String(q[key]) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
    const numVal = (k, ph) => `<input data-f="${k}" type="number" min="0" value="${esc(q[k])}" placeholder="${ph}">`;
    return `
      <div class="dat-filter-grid">
        <div class="field"><label>Origin</label><input data-f="origin" value="${esc(q.origin)}" placeholder="e.g. Chicago, IL"></div>
        <div class="field"><label>Destination</label><input data-f="destination" value="${esc(q.destination)}" placeholder="e.g. Dallas, TX"></div>
        <div class="field"><label>Equipment</label><select data-f="equipment">${optsFor('equipment', DAT_EQUIP_TYPES)}</select></div>
        <div class="field"><label>DH-O ≤ (mi)</label>${numVal('max_dh_o', 'e.g. 100')}</div>
        <div class="field"><label>DH-D ≤ (mi)</label>${numVal('max_dh_d', 'e.g. 150')}</div>
        <div class="field"><label>Max Age (min)</label>${numVal('max_age', 'e.g. 60')}</div>
        <div class="field"><label>Min Rate ($)</label>${numVal('min_rate', 'e.g. 1500')}</div>
        <div class="field"><label>Min RPM ($/mi)</label>${numVal('min_rpm', 'e.g. 2.00')}</div>
        <div class="field"><label>Max Weight (lbs)</label>${numVal('max_weight', 'e.g. 44000')}</div>
        <div class="field"><label>Length (ft)</label><select data-f="length">${optsFor('length', ['28', '40', '48', '53'])}</select></div>
        <div class="field"><label>Sort By</label>
          <select data-f="sort">
            <option value="age_asc" ${q.sort === 'age_asc' ? 'selected' : ''}>Age — Newest First</option>
            <option value="rate_desc" ${q.sort === 'rate_desc' ? 'selected' : ''}>Rate — Highest</option>
            <option value="rpm_desc" ${q.sort === 'rpm_desc' ? 'selected' : ''}>Rate/Mile — Highest</option>
            <option value="dh_o_asc" ${q.sort === 'dh_o_asc' ? 'selected' : ''}>DH-O — Lowest</option>
            <option value="dh_d_asc" ${q.sort === 'dh_d_asc' ? 'selected' : ''}>DH-D — Lowest</option>
            <option value="miles_desc" ${q.sort === 'miles_desc' ? 'selected' : ''}>Miles — Longest</option>
          </select>
        </div>
      </div>
      <div class="dat-toolbar">
        <button class="btn primary" id="datSearchBtn">Search</button>
        <button class="btn" id="datRefreshBtn" title="Refresh results">↻ Refresh</button>
        <span id="datNewBadge" class="dat-new-badge" style="display:none"></span>
        <span id="datMode" class="muted" style="margin-left:auto;font-size:0.8rem"></span>
      </div>`;
  }

  function wireDatFilters(tab) {
    $$('#datFilters [data-f]').forEach(el => {
      el.addEventListener('input', () => { tab.query[el.dataset.f] = el.value; });
      el.addEventListener('change', () => { tab.query[el.dataset.f] = el.value; });
    });
    $('#datSearchBtn').onclick = () => searchDat(true);
    $('#datRefreshBtn').onclick = () => searchDat(false);
  }

  async function searchDat(resetNew) {
    const tab = activeDatTab();
    if (resetNew) { tab.newCount = 0; updateDatBadge(tab); }
    const url = '/api/dat/search?' + new URLSearchParams(tab.query).toString();
    try {
      const r = await api('GET', url);
      tab.loads = r.loads || [];
      tab.mode = r.live ? 'Live DAT results' : 'Demo mode — add DAT credentials in server env to go live';
      const modeEl = $('#datMode');
      if (modeEl) modeEl.textContent = tab.mode;
      renderDatRows(tab);
    } catch (e) { toast(e.message, 'error'); }
  }

  // Silent background refresh — active tab only, counts new loads, shows badge
  async function datSilentRefresh() {
    if (!$('#datBody')) return; // page not visible
    const tab = activeDatTab();
    const url = '/api/dat/search?' + new URLSearchParams(tab.query).toString();
    try {
      const r = await api('GET', url);
      const incoming = r.loads || [];
      const currentIds = new Set(tab.loads.map(l => l.id));
      const newOnes = incoming.filter(l => !currentIds.has(l.id));
      if (newOnes.length > 0) {
        tab.newCount += newOnes.length;
        updateDatBadge(tab);
      }
    } catch (_) { /* silent */ }
  }

  function updateDatBadge(tab) {
    const badge = $('#datNewBadge');
    if (!badge) return;
    if (tab.newCount > 0) {
      badge.textContent = `+${tab.newCount} new load${tab.newCount !== 1 ? 's' : ''} — click Refresh`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderDatRows(tab) {
    const tbody = $('#datBody');
    if (!tbody) return;
    const loads = (tab && tab.loads) || [];
    tbody.innerHTML = loads.map(l => `
      <tr>
        <td>${l.age_min}m</td>
        <td>${esc(l.origin)} → ${esc(l.destination)}</td>
        <td>${esc(l.equipment)}</td>
        <td>${fmtN(l.miles)}</td>
        <td>${l.dh_o ?? '—'} mi</td>
        <td>${l.dh_d ?? '—'} mi</td>
        <td>${l.weight ? fmtN(l.weight) + ' lbs' : '—'}</td>
        <td>${l.length ? l.length + ' ft' : '—'}</td>
        <td>${fmt$(l.rate)}</td>
        <td>$${(l.rpm || 0).toFixed(2)}</td>
        <td>${esc(l.broker)}<br><span class="muted">${esc(l.contact || '')}${l.extension ? esc(' · ext ' + l.extension) : ''}${l.ref ? esc(' · ' + l.ref) : ''}</span></td>
        <td class="row-actions">
          <button class="btn small primary" data-book='${JSON.stringify(l).replace(/'/g, "&#39;")}'>Book</button>
          ${l.broker_email ? `<button class="btn small" data-email='${JSON.stringify(l).replace(/'/g, "&#39;")}' title="AI sends an inquiry email to ${esc(l.broker_email)}">✉️ Email</button>` : ''}
          ${(l.contact || '').trim() ? `<button class="btn small" data-call='${JSON.stringify(l).replace(/'/g, "&#39;")}' title="AI voice agent calls the broker">📞 Call</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="12" class="empty">No results. Click Search to load.</td></tr>';
    $$('#datBody [data-book]').forEach(b => b.onclick = () => {
      const l = JSON.parse(b.dataset.book.replace(/&#39;/g, "'"));
      openLoadForm({
        ref: 'L-' + Date.now(), status: 'booked', broker: l.broker, broker_phone: l.contact,
        origin: l.origin, destination: l.destination, equipment: l.equipment,
        miles: l.miles, rate: l.rate
      });
    });
    $$('#datBody [data-email]').forEach(b => b.onclick = () => {
      datEmailAction(JSON.parse(b.dataset.email.replace(/&#39;/g, "'")));
    });
    $$('#datBody [data-call]').forEach(b => b.onclick = () => {
      datCallAction(JSON.parse(b.dataset.call.replace(/&#39;/g, "'")));
    });
  }

  // ---------- DAT listing actions: ✉️ Email / 📞 Call ----------
  // Email: AI composes an inquiry (previewable + editable) and sends it from
  // the user's connected Gmail. Call: AI voice agent dials the broker about
  // this specific load. Both are owner-scoped server-side.

  async function datEmailAction(l) {
    if (!l.broker_email) return toast('No broker email on this posting — try 📞 Call instead', 'error');
    const lane = [l.origin, l.destination].filter(Boolean).join(' → ');
    const subject = `Load Inquiry: ${lane || 'DAT posting'}${l.ref ? ' — ' + l.ref : ''}`;
    openModal(
      `✉️ Email Broker — ${esc(l.broker || '')}`,
      `
        <div class="field"><label>To</label><input id="oeTo" value="${esc(l.broker_email)}"></div>
        <div class="field"><label>Subject</label><input id="oeSubject" value="${esc(subject)}"></div>
        <div class="field"><label>Draft (AI — edit before sending)</label>
          <textarea id="oeBody" rows="9" style="font-family:monospace;font-size:13px;">${esc(
            `Hi ${l.broker || 'there'},\n\nIs the ${lane || 'load'}${l.ref ? ' (Ref ' + l.ref + ')' : ''} still available? We have a truck that fits and can commit quickly if the numbers work. What's your target rate?\n\nThanks,\n[Your Name]\n[Company] • MC #`
          )}</textarea></div>
        <p class="hint">${esc(l.rate ? 'Posting rate: $' + Number(l.rate).toLocaleString() + '. ' : '')}${esc(l.comments || '')}</p>
      `,
      `<button class="btn primary" id="oeSend">Send</button>
       <button class="btn" id="oeClose">Cancel</button>`
    );
    $('#oeClose').onclick = () => closeModal();
    $('#oeSend').onclick = async () => {
      const btn = $('#oeSend');
      btn.disabled = true; btn.textContent = 'Sending…';
      const payload = { ...l, broker_email: $('#oeTo').value.trim() };
      const bodyOverride = $('#oeBody').value;
      try {
        // Ask the server to (re)generate + send; body override is accepted too.
        const r = await api('POST', '/api/dat/outreach', { load: payload, subject: $('#oeSubject').value, body: bodyOverride });
        if (r.ok) { closeModal(); toast('Email sent to ' + r.email, 'success'); }
        else toast(r.message || r.reason || 'Send failed', 'error');
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Send'; }
    };
  }

  async function datCallAction(l) {
    const phone = (l.contact || '').trim();
    if (!phone) return toast('No phone number on this posting', 'error');
    const lane = [l.origin, l.destination].filter(Boolean).join(' → ');
    openModal(
      `📞 AI Call Broker — ${esc(l.broker || '')}`,
      `
        <p>The AI voice agent will call <b>${esc(phone)}</b>${l.extension ? ' (ext ' + esc(l.extension) + ')' : ''} and talk to ${esc(l.broker || 'the broker')} about this load.</p>
        <div class="field"><label>Context the agent will use</label>
          <textarea id="ocCtx" rows="6">${esc(
            `Load: ${lane || 'DAT posting'}${l.equipment ? ' — ' + l.equipment : ''}\nRate: $${Number(l.rate) || 0}${l.miles ? ' · ' + l.miles + ' mi' : ''}\nRef: ${l.ref || '—'}${l.comments ? '\nComments: ' + l.comments : ''}`
          )}</textarea></div>
      `,
      `<button class="btn primary" id="ocCall">Call Broker</button>
       <button class="btn" id="ocClose">Cancel</button>`
    );
    $('#ocClose').onclick = () => closeModal();
    $('#ocCall').onclick = async () => {
      const btn = $('#ocCall');
      btn.disabled = true; btn.textContent = 'Dialing…';
      try {
        const r = await api('POST', '/api/voice/call', { load: l, context: $('#ocCtx').value });
        closeModal();
        toast(r.ok ? `Call placed — watching it live` : (r.error || 'Call failed'), r.ok ? 'success' : 'error');
        if (r.ok) { callLogState.selectedId = r.callId; showPage('voicecalls'); }
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Call Broker'; }
    };
  }

  // ---------- AI Fleet Assistant (chat + preferences) ----------
  const aiChatState = { history: null, prefs: {} };

  function chatMsgHtml(role, content) {
    return `<div class="chat-msg ${role === 'user' ? 'user' : 'ai'}">${esc(content)}</div>`;
  }

  function renderChatMsgs() {
    const box = $('#chatMsgs');
    if (!box) return;
    if (!aiChatState.history || !aiChatState.history.length) {
      box.innerHTML = '<p class="muted">👋 Tell me about your fleet — MCs per area, preferred rates, weight/length limits, preferred dates and times, per truck or driver. I remember it and use it on voice calls.</p>';
      return;
    }
    box.innerHTML = aiChatState.history.slice().reverse().map(m => chatMsgHtml(m.role, m.content)).join('');
    box.scrollTop = box.scrollHeight;
  }

  function renderPrefsList() {
    const box = $('#chatPrefs');
    if (!box) return;
    const entries = Object.entries(aiChatState.prefs || {});
    box.innerHTML = entries.length
      ? entries.map(([k, v]) => `
          <div class="pref-item">
            <span><code>${esc(k)}</code> = ${esc(String(v))}</span>
            <button data-prefkey="${esc(k)}" title="Remove">✕</button>
          </div>`).join('')
      : '<p class="muted">Nothing saved yet — tell the AI about your fleet above.</p>';
    $$('#chatPrefs [data-prefkey]').forEach(b => b.onclick = async () => {
      try {
        const r = await api('POST', '/api/ai/prefs/remove', { key: b.dataset.prefkey });
        aiChatState.prefs = r.prefs || {};
        renderPrefsList(); renderDatPrefChips();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  async function sendChat() {
    const input = $('#chatInput');
    const msg = (input.value || '').trim();
    if (!msg) return;
    input.value = '';
    if (!aiChatState.history) aiChatState.history = [];
    aiChatState.history.push({ role: 'user', content: msg });
    renderChatMsgs();
    const btn = $('#chatSendBtn');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/ai/chat', { message: msg });
      aiChatState.history.push({ role: 'assistant', content: r.reply });
      aiChatState.prefs = r.prefs || {};
      renderChatMsgs();
      renderPrefsList();
      renderDatPrefChips();
    } catch (e) {
      aiChatState.history.push({ role: 'assistant', content: 'Error: ' + e.message });
      renderChatMsgs();
    } finally { btn.disabled = false; $('#chatInput').focus(); }
  }

  async function renderAIChat() {
    try {
      if (!aiChatState.history) {
        const r = await api('GET', '/api/ai/chat');
        aiChatState.history = (r.history || []).reverse();
        aiChatState.prefs = r.prefs || {};
      }
      renderChatMsgs();
      renderPrefsList();
    } catch (e) {
      const box = $('#chatMsgs');
      if (box) box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }

  // DAT board: chips showing saved fleet prefs (MC per area etc.)
  async function renderDatPrefChips() {
    const box = $('#datPrefChips');
    if (!box) return;
    try {
      if (!aiChatState.history) {
        const r = await api('GET', '/api/ai/chat');
        aiChatState.history = (r.history || []).reverse();
        aiChatState.prefs = r.prefs || {};
      }
      const entries = Object.entries(aiChatState.prefs || {});
      box.style.display = entries.length ? 'flex' : 'none';
      box.innerHTML = entries.slice(0, 12).map(([k, v]) => `<span class="chip" title="${esc(k)}">📌 ${esc(String(v))}</span>`).join('');
    } catch (_) { box.style.display = 'none'; }
  }

  // ---------- Outreach log ----------
  const OUTREACH_BADGES = {
    sent: ['Sent', 'booked'], replied: ['Replied', 'delivered'],
    failed: ['Failed', 'cancelled'], draft: ['Draft', 'pending']
  };
  function outreachBadge(status) {
    const [label, cls] = OUTREACH_BADGES[status] || [status || 'sent', 'pending'];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  async function renderOutreach() {
    const tbody = $('#outreachBody');
    if (!tbody) return;
    try {
      const r = await api('GET', '/api/dat/outreach');
      const rows = r.rows || [];
      tbody.innerHTML = rows.map(o => `
        <tr>
          <td>${esc((o.created_at || '').slice(0, 16))}</td>
          <td>${esc(o.broker_name)}<br><span class="muted">${esc(o.broker_email || '')}</span></td>
          <td>${esc(o.lane || '—')}</td>
          <td>${esc(o.ref_number || '—')}</td>
          <td>${outreachBadge(o.status)}${o.reply_snippet ? `<br><span class="muted">${esc(o.reply_snippet.slice(0, 80))}…</span>` : ''}</td>
          <td>${esc(o.subject || '')}</td>
          <td>${o.gmail_thread_id ? `<a class="btn small" href="https://mail.google.com/mail/u/0/#all/${esc(o.gmail_thread_id)}" target="_blank" rel="noopener">Open</a>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">No outreach yet — use ✉️ Email on a DAT listing.</td></tr>';
    } catch (e) { tbody.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`; }
  }

  // ---------- Call log (live control room) ----------
  const CALL_BADGES = {
    requested: ['Requested', 'pending'], 'in-progress': ['🔴 LIVE', 'booked'],
    ringing: ['Ringing', 'pending'], started: ['In progress', 'booked'],
    ended: ['Ended', 'delivered'], failed: ['Failed', 'cancelled']
  };
  function callBadge(status) {
    const [label, cls] = CALL_BADGES[status] || [status || 'requested', 'pending'];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }
  const callLogState = { calls: [], selectedId: null, timer: null, liveWs: null, audioCtx: null, alerted: new Set() };

  function isCallActive(c) { return ['requested', 'ringing', 'in-progress', 'started'].includes(c.status); }

  function maybeNotify(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { try { new Notification(title, { body }); } catch (_) {} }
    else if (Notification.permission === 'default') Notification.requestPermission();
  }

  async function renderCallLog() {
    const tbody = $('#voiceBody');
    if (!tbody) return;
    try {
      const r = await api('GET', '/api/voice/calls');
      callLogState.calls = r.calls || [];
      const calls = callLogState.calls;
      tbody.innerHTML = calls.map(c => {
        let ctx = {};
        try { ctx = JSON.parse(c.context || '{}'); } catch (_) {}
        const lane = ctx.lane || '';
        const ref = ctx.ref || '';
        const alertDot = c.needs_human ? ' <span class="badge cancelled" title="Needs you — take over">⚠ ALERT</span>' : '';
        return `
        <tr class="voice-row ${c.id === callLogState.selectedId ? 'active' : ''}" data-vid="${c.id}">
          <td>${esc((c.created_at || '').slice(11, 16))}</td>
          <td>${esc(c.broker_name || '—')}<br><span class="muted">${esc(c.phone || '')}</span></td>
          <td>${esc(lane || '—')}${ref ? '<br><span class="muted">' + esc(ref) + '</span>' : ''}</td>
          <td>${callBadge(c.status)}${alertDot}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" class="empty">No calls yet — use 📞 Call on a DAT listing.</td></tr>';
      $$('#voiceBody .voice-row').forEach(tr => tr.onclick = () => selectVoiceCall(Number(tr.dataset.vid)));

      // Alerts: first time a call flips to needs_human → notify the dispatcher
      calls.forEach(c => {
        if (c.needs_human && !callLogState.alerted.has(c.id)) {
          callLogState.alerted.add(c.id);
          toast(`⚠ ${c.broker_name || 'Broker'} — ${c.alert_reason || 'take over now'}`, 'error');
          maybeNotify(`📞 ${c.broker_name || 'Broker'} needs you`, c.alert_reason || 'Take over the call from the Call Log');
          if ($('#page-voicecalls').classList.contains('active')) selectVoiceCall(c.id);
        }
      });

      // Auto-refresh every 3s while any call is live
      const anyLive = calls.some(isCallActive);
      if (anyLive && !callLogState.timer) {
        callLogState.timer = setInterval(() => {
          renderCallLog().catch(() => {});
        }, 3000);
      } else if (!anyLive && callLogState.timer) {
        clearInterval(callLogState.timer); callLogState.timer = null;
      }
      if (callLogState.selectedId) selectVoiceCall(callLogState.selectedId, true);
    } catch (e) { tbody.innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`; }
  }

  function transcriptHtml(c) {
    const raw = (c.transcript_summary || '').split('\n').filter(Boolean);
    if (!raw.length) return '<p class="muted">Transcript will appear here live while the agent talks.</p>';
    return raw.map(line => {
      let cls = 'sys';
      if (line.startsWith('agent:')) cls = 'agent';
      else if (line.startsWith('broker:')) cls = 'broker';
      else if (line.startsWith('[Step')) cls = 'step';       // negotiation ladder
      else if (line.startsWith('[⚠ ETA')) cls = 'eta';       // timing discrepancies
      else if (line.startsWith('[system]')) cls = 'sys';
      return `<div class="t-line ${cls}">${esc(line)}</div>`;
    }).join('');
  }

  function selectVoiceCall(id, silent) {
    callLogState.selectedId = id;
    $$('#voiceBody .voice-row').forEach(tr => tr.classList.toggle('active', Number(tr.dataset.vid) === id));
    const c = callLogState.calls.find(x => x.id === id);
    const title = $('#voiceDetailTitle'); const alertEl = $('#voiceAlert'); const actEl = $('#voiceActions'); const trEl = $('#voiceTranscript');
    if (!c || !title) return;
    title.textContent = `${c.broker_name || 'Call'} — ${callBadge(c.status)}`;
    const ctx = (() => { try { return JSON.parse(c.context || '{}'); } catch (_) { return {}; } })();

    alertEl.style.display = c.needs_human ? 'block' : 'none';
    alertEl.innerHTML = c.needs_human
      ? `<b>⚠ ${esc(c.alert_reason || 'Broker is ready — take over now')}</b> — the agent is holding. Click <b>👤 Take Over</b> to get dialed into the call.`
      : '';

    const active = isCallActive(c);
    actEl.style.display = active ? 'flex' : 'none';
    actEl.innerHTML = `
      <button class="btn primary" id="vcJoinBtn" ${c.needs_human ? '' : 'disabled'} title="Dials your phone (VOICE_FORWARD_TO) into the call">👤 Take Over</button>
      <button class="btn" id="vcEndBtn">End Call</button>
      <button class="btn" id="vcLiveBtn">🔊 Listen Live</button>
      ${c.recording_url ? `<a class="btn" href="${esc(c.recording_url)}" target="_blank" rel="noopener" download>▶ Recording</a>` : ''}
      <span class="muted" style="align-self:center;">${ctx.equipment || ''} · target $${Math.round(c.target_rate || 0).toLocaleString()} · floor $${Math.round(c.min_rate || 0).toLocaleString()} · voice ${esc(c.voice || '')}</span>`;
    if (active) {
      $('#vcJoinBtn').onclick = async () => {
        try { const r = await api('POST', `/api/voice/${c.id}/join`); toast(r.ok ? 'Calling you into the call…' : (r.error || 'Join failed'), r.ok ? 'success' : 'error'); }
        catch (e) { toast(e.message, 'error'); }
      };
      $('#vcEndBtn').onclick = async () => {
        try { const r = await api('POST', `/api/voice/${c.id}/end`); toast(r.ok ? 'Call ended' : (r.error || 'Failed'), r.ok ? 'success' : 'error'); renderCallLog(); }
        catch (e) { toast(e.message, 'error'); }
      };
      $('#vcLiveBtn').onclick = () => toggleLiveListen(c.id, $('#vcLiveBtn'));
    }

    trEl.innerHTML = transcriptHtml(c);
    trEl.scrollTop = trEl.scrollHeight;
  }

  // Live listen: relayed mulaw 8kHz audio over WS → Web Audio API
  function toggleLiveListen(callId, btn) {
    if (callLogState.liveWs) { // stop
      try { callLogState.liveWs.close(); } catch (_) {}
      callLogState.liveWs = null;
      btn.textContent = '🔊 Listen Live';
      btn.classList.remove('primary');
      return;
    }
    const base = window.API_BASE || location.origin;
    const ws = new WebSocket(`${String(base).replace(/^http/, 'ws')}/api/voice/ws/live?callId=${callId}`);
    callLogState.liveWs = ws;
    btn.textContent = '⏹ Stop Listening';
    btn.classList.add('primary');
    const ctx = callLogState.audioCtx || (callLogState.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
    ctx.resume().catch(() => {});
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'audio' && m.payload) {
          const bytes = Uint8Array.from(atob(m.payload), c => c.charCodeAt(0));
          const pcm = mulawDecode(bytes);
          const buf = ctx.createBuffer(1, pcm.length, 8000);
          buf.copyToChannel(pcm, 0);
          const src = ctx.createBufferSource();
          src.buffer = buf; src.connect(ctx.destination); src.start();
        }
      } catch (_) {}
    };
    ws.onclose = () => { if (callLogState.liveWs === ws) { callLogState.liveWs = null; btn.textContent = '🔊 Listen Live'; btn.classList.remove('primary'); } };
  }

  function mulawDecode(u8) {
    const out = new Int16Array(u8.length);
    for (let i = 0; i < u8.length; i++) {
      let u = ~u8[i];
      let t = ((u & 0x0f) << 3) | 0x84;
      t <<= (u & 0x70) >> 4;
      out[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
    }
    return out;
  }

  // ---------- TEMPLATES ----------
  function renderTemplates() {
    // Reflect current AI mode in the hint
    if (state.integrations) {
      $('#tplMode').textContent = state.integrations.ai ? 'AI mode (OpenAI)' : 'Template mode — add OPENAI_API_KEY in server env for AI drafts';
    }
  }

  async function generateTemplate() {
    const payload = {
      kind: $('#tplKind').value,
      broker: $('#tplBroker').value.trim(),
      origin: $('#tplOrigin').value.trim(),
      destination: $('#tplDest').value.trim(),
      rate: $('#tplRate').value,
      ref: $('#tplRef').value.trim()
    };
    const btn = $('#tplGenBtn');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const r = await api('POST', '/api/ai/draft', payload);
      $('#tplOut').value = r.draft || '';
      $('#tplMode').textContent = r.ai ? 'AI mode (OpenAI)' : 'Template mode — add OPENAI_API_KEY in server env for AI drafts';
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Generate'; }
  }

  async function copyTemplate() {
    const text = $('#tplOut').value;
    if (!text) return toast('Nothing to copy', 'error');
    try { await navigator.clipboard.writeText(text); toast('Copied', 'success'); }
    catch { $('#tplOut').select(); document.execCommand('copy'); toast('Copied', 'success'); }
  }

  function emailTemplate() {
    const body = $('#tplOut').value;
    if (!body) return toast('Generate a draft first', 'error');
    const kindLabel = { inquiry: 'Load Inquiry', negotiate: 'Rate Negotiation', book: 'Booking Confirmation', checkcall: 'Load Update' }[$('#tplKind').value] || 'Load';
    const ref = $('#tplRef').value.trim();
    const subject = `${kindLabel}${ref ? ' — ' + ref : ''}`;
    const to = ''; // let the user pick — most brokers aren't in a contact list here
    const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
  }

  // ---------- AI NEGOTIATIONS ----------
  let negTimer = null;
  const negState = { campaigns: [], activeId: null };

  const NEG_BADGES = {
    active: ['Active', 'booked'], paused: ['Paused', 'pending'],
    negotiating: ['Negotiating', 'booked'], agreed: ['Agreed — book now', 'delivered'],
    needs_approval: ['Draft — approve', 'pending'], exhausted: ['Needs human', 'cancelled'],
    closed: ['Closed', 'cancelled']
  };
  function negBadge(status) {
    const [label, cls] = NEG_BADGES[status] || [status, 'pending'];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  async function renderNegotiations() {
    const eqSel = $('#negEquip');
    if (eqSel && !eqSel.options.length) {
      eqSel.innerHTML = '<option value="">— Any —</option>' + DAT_EQUIP_TYPES.map(t => `<option>${esc(t)}</option>`).join('');
    }
    const brSel = $('#negBrokers');
    if (brSel && brSel.options.length === 0) {
      brSel.innerHTML = state.contacts.filter(c => c.type === 'broker' && c.email)
        .map(c => `<option value="${c.id}">${esc(c.name || c.company)} — ${esc(c.email)}</option>`).join('');
    }
    await negLoad();
    if (!negTimer) negTimer = setInterval(negLoad, 15000);
  }

  async function negLoad() {
    try {
      const r = await api('GET', '/api/negotiation/campaigns');
      negState.campaigns = r.campaigns || [];
      $('#negList').innerHTML = negState.campaigns.length ? negState.campaigns.map(c => `
        <div class="neg-camp ${c.id == negState.activeId ? 'active' : ''}" data-id="${c.id}">
          <div class="neg-camp-name">${esc(c.name)} ${negBadge(c.status)}</div>
          <div class="muted" style="font-size:12px;">${esc(c.origin || '—')} → ${esc(c.destination || '—')} · ${c.threads || 0} threads · ${c.agreed || 0} agreed${c.pending ? ` · ${c.pending} pending` : ''}</div>
        </div>`).join('') : '<p class="muted">No campaigns yet — start one above.</p>';
      $$('#negList .neg-camp').forEach(el => el.onclick = () => negSelect(el.dataset.id));
      if (negState.activeId) await negDetail(negState.activeId);
    } catch (_) { /* silent during poll */ }
  }

  async function negSelect(id) { negState.activeId = id; await negDetail(id); }

  async function negDetail(id) {
    try {
      const r = await api('GET', `/api/negotiation/campaigns/${id}`);
      const c = r.campaign;
      $('#negDetailTitle').innerHTML = `${esc(c.name)} ${negBadge(c.status)}`;
      const msgByThread = {};
      (r.messages || []).forEach(m => { (msgByThread[m.thread_id] = msgByThread[m.thread_id] || []).push(m); });
      $('#negDetail').innerHTML = `
        <div class="muted" style="margin-bottom:10px;">${esc(c.origin || '—')} → ${esc(c.destination || '—')} · ${esc(c.equipment || 'any equip')} · pickup ${esc(c.pickup_date || '—')} · target $${c.target_rate || '—'} · floor $${c.min_rate || '—'} · max ${c.max_rounds} rounds</div>
        <div class="dat-toolbar" style="padding-top:0;">
          ${c.status === 'active' ? `<button class="btn small" data-neg="pause" data-id="${c.id}">Pause</button>` : `<button class="btn small" data-neg="resume" data-id="${c.id}">Resume</button>`}
        </div>
        ${(r.threads || []).map(t => `
          <div class="neg-thread">
            <div class="neg-thread-head"><b>${esc(t.broker_name || t.broker_email)}</b> ${negBadge(t.status)} <span class="muted" style="font-size:12px;">round ${t.round}/${c.max_rounds}</span></div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">${esc(t.summary || '')}</div>
            <div class="neg-msgs">
              ${(msgByThread[t.id] || []).map(m => `
                <div class="neg-msg ${m.direction}">
                  <span class="neg-tag">${m.direction === 'out' ? '→ sent' : m.direction === 'in' ? '← broker' : '✎ draft'}</span>
                  <div class="neg-subj">${esc(m.subject || '')}</div>
                  <div class="neg-body">${esc(m.body || '')}</div>
                </div>`).join('') || '<div class="muted">No messages yet</div>'}
            </div>
            ${t.status === 'needs_approval' ? `<button class="btn small primary" data-neg="approve" data-thread="${t.id}">Approve &amp; Send Draft</button>` : ''}
            ${t.status === 'agreed' ? `<button class="btn small primary" data-neg="book" data-camp="${c.id}" data-thread="${t.id}" data-broker="${esc(t.broker_name || t.broker_email)}" data-email="${esc(t.broker_email)}">Book Load</button>` : ''}
          </div>`).join('') || '<p class="muted">No threads yet.</p>'}`;
      $$('#negDetail [data-neg]').forEach(b => b.onclick = () => {
        const act = b.dataset.neg;
        if (act === 'pause') negPause(b.dataset.id);
        else if (act === 'resume') negResume(b.dataset.id);
        else if (act === 'approve') negApprove(b.dataset.thread);
        else if (act === 'book') negBook(b.dataset);
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  async function negPause(id) { await api('POST', `/api/negotiation/campaigns/${id}/pause`); toast('Campaign paused', 'success'); negLoad(); }
  async function negResume(id) { await api('POST', `/api/negotiation/campaigns/${id}/resume`); toast('Campaign resumed', 'success'); negLoad(); }
  async function negApprove(threadId) {
    try { await api('POST', `/api/negotiation/threads/${threadId}/approve`); toast('Draft sent', 'success'); negLoad(); }
    catch (e) { toast(e.message, 'error'); }
  }

  function negBook(d) {
    const c = negState.campaigns.find(x => x.id == d.camp) || {};
    openLoadForm({
      ref: 'L-' + Date.now(), status: 'booked',
      broker: d.broker, broker_email: d.email,
      origin: c.origin || '', destination: c.destination || '', equipment: c.equipment || '',
      rate: c.target_rate || 0
    });
  }

  // ---------- INBOX MONITOR (admin only) ----------
  const mailState = { accounts: [], userId: '', messages: [], selectedId: null };

  async function renderMail() {
    if (state.me.role !== 'admin') { showPage('dashboard'); return; }
    try {
      const r = await api('GET', '/api/mail/accounts');
      mailState.accounts = r.accounts || [];
    } catch (e) { toast(e.message, 'error'); }
    const sel = $('#mailAccount');
    sel.innerHTML = '<option value="">— Select connected account —</option>' +
      mailState.accounts.map(a => `<option value="${a.user_id}" ${mailState.userId == a.user_id ? 'selected' : ''}>${esc(a.google_email || a.username)} (${esc(a.username)})</option>`).join('');
    if (mailState.userId && !mailState.accounts.some(a => a.user_id == mailState.userId)) mailState.userId = '';
    sel.value = mailState.userId || '';
    $('#mailList').innerHTML = mailState.messages.length
      ? mailState.messages.map(mailMsgRow).join('')
      : '<p class="muted">Select an account and search to load messages.</p>';
    $('#mailDetail').innerHTML = '<p class="muted">Click a message to read it.</p>';
  }

  function mailMsgRow(m) {
    const active = m.id === mailState.selectedId ? ' active' : '';
    return `<div class="mail-item${active}" data-id="${m.id}">
      <div class="mail-subj">${esc(m.subject)}</div>
      <div class="mail-meta">${esc(m.from)} · ${esc(String(m.date || ''))}</div>
      <div class="mail-snip">${esc(m.snippet || '')}</div>
    </div>`;
  }

  async function mailSearch() {
    if (!mailState.userId) { toast('Select a connected account first', 'error'); return; }
    const q = $('#mailQuery').value.trim();
    $('#mailList').innerHTML = '<p class="muted">Loading…</p>';
    try {
      const r = await api('GET', `/api/mail/search?user_id=${mailState.userId}&q=${encodeURIComponent(q)}`);
      mailState.messages = r.messages || [];
      mailState.selectedId = null;
      $('#mailList').innerHTML = mailState.messages.length
        ? mailState.messages.map(mailMsgRow).join('')
        : '<p class="muted">No messages found.</p>';
      $('#mailDetail').innerHTML = '<p class="muted">Click a message to read it.</p>';
      $$('#mailList .mail-item').forEach(el => el.onclick = () => mailOpen(el.dataset.id));
    } catch (e) {
      toast(e.message, 'error');
      $('#mailList').innerHTML = '<p class="muted">Search failed.</p>';
    }
  }

  async function mailOpen(id) {
    if (!mailState.userId) return;
    mailState.selectedId = id;
    $$('#mailList .mail-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    $('#mailDetail').innerHTML = '<p class="muted">Loading…</p>';
    try {
      const r = await api('GET', `/api/mail/read?user_id=${mailState.userId}&id=${encodeURIComponent(id)}`);
      const m = r.message;
      $('#mailDetailTitle').textContent = m.subject || 'Message';
      $('#mailDetail').innerHTML = `
        <div class="mail-head"><b>From:</b> ${esc(m.from)}<br><b>To:</b> ${esc(m.to || '')}<br><b>Date:</b> ${esc(String(m.date || ''))}</div>
        <div class="mail-body">${m.bodyHtml ? m.bodyHtml : esc(m.bodyText || '')}</div>`;
    } catch (e) {
      toast(e.message, 'error');
      $('#mailDetail').innerHTML = '<p class="muted">Could not load message.</p>';
    }
  }

  // ---------- USERS (admin) ----------
  async function renderUsers() {
    if (state.me.role !== 'admin') return;
    const users = await api('GET', '/api/users');
    $('#usersBody').innerHTML = users.map(u => `
      <tr>
        <td><b>${esc(u.username)}</b></td>
        <td>${esc(u.full_name || '')}</td>
        <td>${esc(u.email || '')}</td>
        <td><span class="badge ${u.role === 'admin' ? 'delivered' : 'booked'}">${esc(u.role)}</span></td>
        <td>${esc((u.created_at || '').split(' ')[0])}</td>
        <td class="row-actions">
          <button class="btn small" data-act="pw" data-id="${u.id}" data-name="${esc(u.username)}">Reset PW</button>
          ${u.id !== state.me.id ? `<button class="btn small danger" data-act="del" data-id="${u.id}" data-name="${esc(u.username)}">🗑</button>` : ''}
        </td>
      </tr>`).join('');
    $$('#usersBody [data-act]').forEach(b => b.onclick = () => {
      if (b.dataset.act === 'pw') resetPw(b.dataset.id, b.dataset.name);
      else if (b.dataset.act === 'del') deleteUser(b.dataset.id, b.dataset.name);
    });
  }

  function openNewUserForm() {
    const body = `
      <form id="userForm">
        <div class="err-msg" id="uErr"></div>
        <div class="form-grid">
          <div class="field"><label>Username *</label><input name="username" required></div>
          <div class="field"><label>Password *</label><input name="password" type="text" required></div>
          <div class="field"><label>Full Name</label><input name="full_name"></div>
          <div class="field"><label>Email</label><input name="email" type="email"></div>
          <div class="field"><label>Phone</label><input name="phone"></div>
          <div class="field"><label>Role</label>
            <select name="role"><option value="dispatcher">dispatcher</option><option value="admin">admin</option></select>
          </div>
        </div>
        <div class="check-row">
          <label><input type="checkbox" name="seed_sample"> Add a sample carrier / driver / broker / load to their workspace</label>
        </div>
        <p class="hint">The new user gets their own private, empty workspace — they'll only see data they add (or the optional sample above). They'll be prompted to change the password on first login.</p>
        <p class="hint">If an email is entered above, an invite with the username, default password and app link is emailed automatically (uses SMTP if configured, otherwise the admin's connected Google).</p>
      </form>`;
    const m = openModal('New User', body, `<button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Create</button>`);
    $('#mCancel').onclick = m.close;
    $('#mSave').onclick = async () => {
      const fd = new FormData($('#userForm'));
      const data = Object.fromEntries(fd.entries());
      data.seed_sample = fd.get('seed_sample') ? 1 : 0;
      try {
        const r = await api('POST', '/api/users', data);
        m.close();
        if (r.email === 'sent') toast('User created — invite email sent', 'success');
        else if (r.email === 'failed') toast('User created, but the invite email failed to send (' + (r.email_reason || 'error') + ')', 'error');
        else if (r.email_reason === 'no_email') toast('User created — no email address entered, so no invite was sent', 'success');
        else toast('User created — no invite email sent. Set SMTP env vars or connect Google in Settings first.', 'success');
        renderUsers();
      } catch (e) {
        $('#uErr').textContent = e.message; $('#uErr').classList.add('show');
      }
    };
  }

  async function resetPw(id, name) {
    const pw = prompt(`Set a new password for ${name} (min 6 chars):`);
    if (!pw) return;
    try { await api('POST', `/api/users/${id}/reset-password`, { password: pw }); toast('Password reset', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function deleteUser(id, name) {
    if (!confirm(`Delete user "${name}"? This wipes all of THEIR loads, carriers, drivers, brokers, and Google connection.`)) return;
    try { await api('DELETE', '/api/users/' + id); toast('User deleted', 'success'); renderUsers(); }
    catch (e) { toast(e.message, 'error'); }
  }

  // ---------- SETTINGS ----------
  async function renderSettings() {
    // Prefill profile from state.me
    $('#pfName').value = state.me.full_name || '';
    $('#pfEmail').value = state.me.email || '';
    $('#pfPhone').value = state.me.phone || '';
    await loadIntegrations();
  }

  async function loadIntegrations() {
    const r = await api('GET', '/api/settings/integrations');
    state.integrations = r;

    // Google (per-user)
    const g = r.google || {};
    const gConfigured = !!g.configured;
    const gConnected = !!g.connected;
    $('#dotGoogle').className = 'dot ' + (gConnected ? 'on' : 'off');
    $('#stGoogle').textContent = !gConfigured ? 'Not configured on server' : (gConnected ? 'Connected' : 'Not connected');
    $('#googleConnectBtn').style.display = (gConfigured && !gConnected) ? 'inline-block' : 'none';
    $('#googleDisconnectBtn').style.display = (gConfigured && gConnected) ? 'inline-block' : 'none';
    $('#googleEmailLbl').textContent = (gConnected && g.email) ? `Signed in as ${g.email}` : (gConfigured ? '' : 'Ask the admin to set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the server environment.');

    // DAT
    $('#dotDat').className = 'dot ' + (r.dat ? 'on' : 'off');
    $('#stDat').textContent = r.dat ? 'Live' : 'Demo';

    // AI
    $('#dotAi').className = 'dot ' + (r.ai ? 'on' : 'off');
    $('#stAi').textContent = r.ai ? 'AI (OpenAI)' : 'Templates';
  }

  // ---------- Forced password change ----------
  function openForcedPasswordChange() {
    const body = `
      <p class="hint">For security, please change your password before continuing.</p>
      <form id="fpwForm">
        <div class="err-msg" id="fpwErr"></div>
        <div class="field"><label>New Password (min 6 chars)</label><input id="fpwNew" type="password" required></div>
      </form>`;
    const m = openModal('Change your password', body, `<button class="btn primary" id="mSave">Save</button>`);
    // Prevent close via backdrop for forced change
    $('#modalHost .modal-close').style.display = 'none';
    $('#modalHost .modal-backdrop').onclick = null;
    $('#mSave').onclick = async () => {
      const np = $('#fpwNew').value;
      try {
        await api('POST', '/api/change-password', { new_password: np });
        state.me.must_change_password = 0;
        m.close();
        toast('Password updated', 'success');
      } catch (e) { $('#fpwErr').textContent = e.message; $('#fpwErr').classList.add('show'); }
    };
  }

  // ---------- Wire up ----------
  function bind() {
    // Login
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#loginErr').classList.remove('show');
      try {
        await tryLogin($('#loginUser').value, $('#loginPass').value);
        await showApp();
      } catch (err) {
        $('#loginErr').textContent = err.message || 'Login failed';
        $('#loginErr').classList.add('show');
      }
    });

    // Forgot username / password
    $('#forgotUserLink').onclick = (e) => { e.preventDefault(); showForgotUser(); };
    $('#forgotUserBack').onclick = (e) => { e.preventDefault(); showLoginView(); };
    $('#forgotUserForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#forgotUserErr').classList.remove('show');
      $('#forgotUserOk').classList.remove('show');
      const btn = $('#forgotUserSendBtn');
      btn.disabled = true;
      try {
        await api('POST', '/api/forgot-username', { identifier: $('#forgotUserId').value });
        $('#forgotUserId').value = '';
        $('#forgotUserOk').classList.add('show');
      } catch (err) {
        $('#forgotUserErr').textContent = err.message || 'Something went wrong. Please try again.';
        $('#forgotUserErr').classList.add('show');
      } finally { btn.disabled = false; }
    });
    $('#forgotLink').onclick = (e) => { e.preventDefault(); showForgot(); };
    $('#forgotBack').onclick = (e) => { e.preventDefault(); showLoginView(); };
    $('#forgotForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#forgotErr').classList.remove('show');
      $('#forgotOk').classList.remove('show');
      const btn = $('#forgotSendBtn');
      btn.disabled = true;
      try {
        await api('POST', '/api/forgot-password', { identifier: $('#forgotId').value });
        $('#forgotId').value = '';
        $('#forgotOk').classList.add('show');
      } catch (err) {
        $('#forgotErr').textContent = err.message || 'Something went wrong. Please try again.';
        $('#forgotErr').classList.add('show');
      } finally {
        btn.disabled = false;
      }
    });

    // Reset password
    $('#resetBack').onclick = (e) => { e.preventDefault(); history.replaceState({}, '', '/'); showLoginView(); };
    $('#resetForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#resetErr').classList.remove('show');
      $('#resetOk').classList.remove('show');
      const p1 = $('#resetPass').value;
      const p2 = $('#resetPass2').value;
      if (p1 !== p2) { $('#resetErr').textContent = 'Passwords do not match.'; $('#resetErr').classList.add('show'); return; }
      if (p1.length < 6) { $('#resetErr').textContent = 'Password must be at least 6 characters.'; $('#resetErr').classList.add('show'); return; }
      const btn = $('#resetSubmitBtn');
      btn.disabled = true;
      try {
        await api('POST', '/api/reset-password', { token: resetTokenState, new_password: p1 });
        $('#resetForm').style.display = 'none';
        $('#resetOk').classList.add('show');
        history.replaceState({}, '', '/');
        $('#resetBack').textContent = 'Sign in';
      } catch (err) {
        $('#resetErr').textContent = err.message || 'Could not reset the password. Please request a new link.';
        $('#resetErr').classList.add('show');
      } finally {
        btn.disabled = false;
      }
    });

    // Sidebar
    $$('.nav-item[data-page]').forEach(b => b.onclick = () => showPage(b.dataset.page));
    $('#logoutBtn').onclick = async () => { await api('POST', '/api/logout'); location.reload(); };

    // Dashboard period + carrier scope
    $('#perfPeriod').onchange = () => { perfState.period = $('#perfPeriod').value; renderDashboard(); };
    $('#perfCarrier').onchange = () => { perfState.carrierId = $('#perfCarrier').value; renderDashboard(); };

    // Inbox Monitor (admin)
    $('#mailAccount').onchange = () => { mailState.userId = $('#mailAccount').value; };
    $('#mailSearchBtn').onclick = () => mailSearch();
    $('#mailQuery').addEventListener('keydown', e => { if (e.key === 'Enter') mailSearch(); });

    // AI Negotiations
    $('#negNewBtn').onclick = () => { $('#negCreate').style.display = 'block'; };
    $('#negCancelBtn').onclick = () => { $('#negCreate').style.display = 'none'; };
    $('#negCreateBtn').onclick = async () => {
      const broker_ids = [...$('#negBrokers').selectedOptions].map(o => Number(o.value));
      const payload = {
        name: $('#negName').value.trim(),
        origin: $('#negOrigin').value.trim(),
        destination: $('#negDest').value.trim(),
        equipment: $('#negEquip').value,
        pickup_date: $('#negPickup').value,
        target_rate: $('#negTarget').value,
        min_rate: $('#negMin').value,
        max_rounds: $('#negRounds').value,
        auto_send: $('#negAuto').checked,
        broker_ids
      };
      if (!payload.origin || !payload.destination) { toast('Origin and destination are required', 'error'); return; }
      try {
        const r = await api('POST', '/api/negotiation/campaigns', payload);
        $('#negCreate').style.display = 'none';
        toast('Campaign started — initial emails sent', 'success');
        negState.activeId = r.id;
        await negLoad();
      } catch (e) {
        $('#negErr').textContent = e.message;
        $('#negErr').classList.add('show');
      }
    };

    // Install App (PWA) — uses the deferred install prompt if available
    $('#installAppBtn').onclick = () => {
      const p = window.__pwaPrompt;
      if (p) {
        p.prompt();
        if (p.userChoice) p.userChoice.then(() => { window.__pwaPrompt = null; });
      } else {
        const m = openModal('Install DAT One', `
          <p class="hint">DAT One is a Progressive Web App — it installs like a native app, no download needed. You get a home-screen icon that opens it full-screen (and it works offline).</p>
          <ul style="margin:12px 0;padding-left:20px;font-size:13px;color:#334155;">
            <li style="margin-bottom:6px;"><b>Phone (Android / iPhone):</b> open the app in Chrome or Safari → browser menu → <b>Add to Home Screen</b> (or <b>Install App</b>).</li>
            <li style="margin-bottom:6px;"><b>Desktop (Chrome / Edge):</b> click the <b>install icon</b> (monitor with a down-arrow) in the address bar, or menu → <b>Install DAT One</b>.</li>
            <li>Works on Windows, macOS, Android and iPhone — one app, no App Store.</li>
          </ul>
        `, '<button class="btn" id="mClose">Close</button>');
        $('#mClose', m.host).onclick = () => m.close();
      }
    };

    // Loads
    $('#addLoadBtn').onclick = () => openLoadForm(null);
    // Carriers / Drivers / Brokers
    $('#addCarrierBtn').onclick = () => openContactForm('carrier', null);
    $('#addDriverBtn').onclick = () => openContactForm('driver', null);
    $('#addBrokerBtn').onclick = () => openContactForm('broker', null);
    // DAT — search/refresh buttons are injected by renderDatBoard(), not bound here
    // Outreach / Call Log
    $('#outreachRefreshBtn').onclick = renderOutreach;
    $('#voiceRefreshBtn').onclick = renderCallLog;
    $('#outreachPollBtn').onclick = async () => {
      const btn = $('#outreachPollBtn');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const r = await api('POST', '/api/dat/outreach/poll');
        toast(r.found ? `${r.found} new reply${r.found !== 1 ? 's' : ''} found` : 'No new replies', 'success');
        renderOutreach();
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = '↻ Check Replies'; }
    };
    // Mobile menu
    $('#menuBtn').onclick = toggleMenu;
    $('#menuBackdrop').onclick = closeMenu;

    // AI Fleet Assistant
    $('#chatSendBtn').onclick = sendChat;
    $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    // Templates — direct email send
    $('#tplSendBtn').onclick = async () => {
      const to = ($('#tplTo').value || '').trim();
      const subject = $('#tplSubject').value || 'Load inquiry';
      const body = $('#tplOut').value;
      if (!to) return toast('Enter the recipient email first', 'error');
      if (!body) return toast('Generate a draft first', 'error');
      const btn = $('#tplSendBtn');
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/mail/send', { to, subject, body });
        toast(r.ok ? `Sent to ${to}` : (r.error || 'Send failed'), r.ok ? 'success' : 'error');
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; }
    };

    // Templates
    $('#tplGenBtn').onclick = generateTemplate;
    $('#tplCopyBtn').onclick = copyTemplate;
    $('#tplEmailBtn').onclick = emailTemplate;
    // Users
    $('#addUserBtn').onclick = openNewUserForm;
    // Profile
    $('#profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/api/profile', {
          full_name: $('#pfName').value, email: $('#pfEmail').value, phone: $('#pfPhone').value
        });
        Object.assign(state.me, { full_name: $('#pfName').value, email: $('#pfEmail').value, phone: $('#pfPhone').value });
        $('#whoName').textContent = state.me.full_name || state.me.username;
        toast('Profile saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
    // Password change
    $('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#pwErr').classList.remove('show');
      try {
        await api('POST', '/api/change-password', { current_password: $('#pwCur').value, new_password: $('#pwNew').value });
        $('#pwCur').value = ''; $('#pwNew').value = '';
        toast('Password changed', 'success');
      } catch (err) { $('#pwErr').textContent = err.message; $('#pwErr').classList.add('show'); }
    });
    // Google connect/disconnect (per-user)
    $('#googleConnectBtn').onclick = () => { window.location.href = '/auth/google'; };
    $('#googleDisconnectBtn').onclick = async () => {
      if (!confirm('Disconnect your Google account? Drive / Sheets / Gmail will stop working until you reconnect.')) return;
      try { await api('POST', '/api/google/disconnect'); toast('Google disconnected', 'success'); await loadIntegrations(); }
      catch (e) { toast(e.message, 'error'); }
    };
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    // Password-reset link: https://…/?reset=<token>
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) { showReset(resetToken); return; }
    const u = await loadMe();
    if (u) await showApp();
    else showLogin();
  });
})();
