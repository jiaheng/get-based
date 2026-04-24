// client-list.js — Client List modal for managing profiles

import { state } from './state.js';
import { escapeHTML, escapeAttr } from './utils.js';
import { getProfiles, getActiveProfileId, createProfile, switchProfile, deleteProfile, updateProfileMeta, getAllTags, getLocationCache, latitudeToBand, getLatitudeFromLocation, detectLatitudeWithAI, getProfileHeight } from './profile.js';
import { LATITUDE_BANDS } from './constants.js';
import { getAvatarColor } from './nav.js';

let _search = '';
let _sort = 'lastUpdated';
let _statusFilter = 'active';
let _tagFilter = '';
let _editingId = null;
let _pendingAvatar = undefined; // undefined = no change, null = remove, string = new dataURL

// Use imported escapeAttr for onclick="fn('${val}')" contexts

// ═══════════════════════════════════════════════
// AVATAR HELPERS
// ═══════════════════════════════════════════════
function _resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 80;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Center-crop to square
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function _isSafeAvatarSrc(s) { return typeof s === 'string' && s.startsWith('data:image/'); }

function _renderAvatarEl(profile) {
  if (profile.avatar && _isSafeAvatarSrc(profile.avatar)) {
    return `<img class="cl-avatar cl-avatar-img" src="${escapeAttr(profile.avatar)}" alt="">`;
  }
  const color = getAvatarColor(profile.id);
  const initial = (profile.name || '?')[0].toUpperCase();
  return `<span class="cl-avatar" style="background:${color}">${initial}</span>`;
}

// ═══════════════════════════════════════════════
// OPEN / CLOSE
// ═══════════════════════════════════════════════
export function openClientList() {
  _search = '';
  _statusFilter = 'active';
  _tagFilter = '';
  _editingId = null;
  _pendingAvatar = undefined;
  const overlay = document.getElementById('client-list-overlay');
  if (!overlay) return;
  renderClientList();
  overlay.classList.add('show');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    const input = document.getElementById('cl-search');
    if (input) input.focus();
  });
}

export function closeClientList() {
  const overlay = document.getElementById('client-list-overlay');
  if (overlay) overlay.classList.remove('show');
  document.body.style.overflow = '';
  _editingId = null;
}

// ═══════════════════════════════════════════════
// RENDER LIST
// ═══════════════════════════════════════════════
function renderClientList() {
  const modal = document.getElementById('client-list-modal');
  if (!modal) return;
  const profiles = getProfiles();
  const activeId = getActiveProfileId();
  const allTags = getAllTags();

  // Filter
  let filtered = profiles.filter(p => {
    if (_statusFilter === 'active') return p.status !== 'archived';
    if (_statusFilter === 'flagged') return p.status === 'flagged';
    if (_statusFilter === 'archived') return p.status === 'archived';
    return true; // 'all'
  });
  if (_tagFilter) {
    filtered = filtered.filter(p => Array.isArray(p.tags) && p.tags.includes(_tagFilter));
  }
  if (_search) {
    const q = _search.toLowerCase();
    filtered = filtered.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.notes || '').toLowerCase().includes(q) ||
      (Array.isArray(p.tags) && p.tags.some(t => t.toLowerCase().includes(q)))
    );
  }

  // Sort — pinned always first
  const sortFn = _getSortFn();
  const pinned = filtered.filter(p => p.pinned).sort(sortFn);
  const unpinned = filtered.filter(p => !p.pinned).sort(sortFn);
  const sorted = [...pinned, ...unpinned];

  // Archived section (only when viewing active/flagged/all)
  const archived = (_statusFilter !== 'archived')
    ? profiles.filter(p => p.status === 'archived')
    : [];

  let html = `<div class="cl-header">
    <div class="cl-header-left">
      <h2 class="cl-title">Clients <span class="cl-count">(${profiles.filter(p => p.status !== 'archived').length})</span></h2>
    </div>
    <div class="cl-header-right">
      <button class="cl-export-all-btn" onclick="document.getElementById('cl-json-import').click()">Import</button>
      <input type="file" id="cl-json-import" accept=".json" style="display:none" onchange="if(this.files[0]){closeClientList();window.importDataJSON(this.files[0]);this.value=''}">
      <button class="cl-export-all-btn" onclick="window.exportAllDataJSON()">Export All</button>
      <button class="cl-new-btn cl-demo-btn" onclick="closeClientList();window.loadDemoData('female')">+ Demo Sarah</button>
      <button class="cl-new-btn cl-demo-btn" onclick="closeClientList();window.loadDemoData('male')">+ Demo Alex</button>
      <button class="cl-new-btn" onclick="openClientForm()">+ New Client</button>
      <button class="modal-close" onclick="closeClientList()" aria-label="Close">&times;</button>
    </div>
  </div>
  <div class="cl-toolbar">
    <input type="text" class="cl-search" id="cl-search" placeholder="Search clients..." value="${escapeHTML(_search)}" oninput="window._clSearch(this.value)">
    <select class="cl-sort" onchange="window._clSort(this.value)">
      <option value="lastUpdated"${_sort === 'lastUpdated' ? ' selected' : ''}>Last Updated</option>
      <option value="az"${_sort === 'az' ? ' selected' : ''}>A \u2192 Z</option>
      <option value="za"${_sort === 'za' ? ' selected' : ''}>Z \u2192 A</option>
      <option value="created"${_sort === 'created' ? ' selected' : ''}>Created</option>
    </select>
    <select class="cl-status-filter" onchange="window._clStatusFilter(this.value)">
      <option value="active"${_statusFilter === 'active' ? ' selected' : ''}>Active</option>
      <option value="flagged"${_statusFilter === 'flagged' ? ' selected' : ''}>Flagged</option>
      <option value="all"${_statusFilter === 'all' ? ' selected' : ''}>All</option>
      <option value="archived"${_statusFilter === 'archived' ? ' selected' : ''}>Archived</option>
    </select>
  </div>`;

  // Tag filter chips
  if (allTags.length > 0) {
    html += `<div class="cl-tag-filters">`;
    for (const tag of allTags) {
      const active = _tagFilter === tag;
      html += `<button class="cl-tag-chip${active ? ' active' : ''}" onclick="window._clTagFilter('${escapeAttr(tag)}')">${escapeHTML(tag)}</button>`;
    }
    if (_tagFilter) {
      html += `<button class="cl-tag-chip cl-tag-clear" onclick="window._clTagFilter('')">Clear</button>`;
    }
    html += `</div>`;
  }

  html += `<div class="cl-list">`;
  if (sorted.length === 0) {
    html += `<div class="cl-empty">No clients match your filters</div>`;
  }
  for (const p of sorted) {
    html += _renderClientRow(p, activeId);
  }

  // Archived collapsed section — inside .cl-list so it scrolls
  if (archived.length > 0 && _statusFilter !== 'archived') {
    html += `<details class="cl-archived-section">
      <summary class="cl-archived-header">Archived (${archived.length})</summary>`;
    for (const p of archived) {
      html += _renderClientRow(p, activeId);
    }
    html += `</details>`;
  }
  html += `</div>`;
  // Shared context menu — outside .cl-list so it's not clipped by overflow
  html += `<div class="cl-row-menu" id="cl-active-menu"></div>`;

  modal.innerHTML = html;
  // Close floating menus on list scroll
  const list = modal.querySelector('.cl-list');
  if (list) list.addEventListener('scroll', _closeMenus);
}

function _renderClientRow(p, activeId) {
  const color = getAvatarColor(p.id);
  const initial = (p.name || '?')[0].toUpperCase();
  const isActive = p.id === activeId;
  const timeAgo = _timeAgo(p.lastUpdated);
  const notePreview = (p.notes || '').slice(0, 60).replace(/\n/g, ' ');

  let badges = '';
  if (p.status === 'flagged') badges += `<span class="cl-badge cl-badge-flagged" title="Flagged">flagged</span>`;
  if (p.pinned) badges += `<span class="cl-badge cl-badge-pinned" title="Pinned">pinned</span>`;

  let tags = '';
  if (Array.isArray(p.tags) && p.tags.length) {
    tags = p.tags.map(t => `<span class="cl-row-tag">${escapeHTML(t)}</span>`).join('');
  }

  return `<div class="cl-row${isActive ? ' cl-row-active' : ''}" data-id="${escapeAttr(p.id)}" onclick="window._clSelect('${escapeAttr(p.id)}')">
    ${_renderAvatarEl(p)}
    <div class="cl-row-info">
      <div class="cl-row-top">
        <span class="cl-row-name">${escapeHTML(p.name)}</span>
        ${tags}${badges}
      </div>
      <div class="cl-row-bottom">
        <span class="cl-row-time">${escapeHTML(timeAgo)}</span>${notePreview ? `<span class="cl-row-sep">&middot;</span><span class="cl-row-note">${escapeHTML(notePreview)}</span>` : ''}
      </div>
    </div>
    <div class="cl-row-actions" onclick="event.stopPropagation()">
      <button class="cl-row-edit" onclick="openClientForm('${escapeAttr(p.id)}')" title="Edit">Edit</button>
      <button class="cl-row-menu-btn" onclick="window._clToggleMenu(event, '${escapeAttr(p.id)}')" title="More">&ctdot;</button>
    </div>
  </div>`;
}

function _getSortFn() {
  switch (_sort) {
    case 'az': return (a, b) => (a.name || '').localeCompare(b.name || '');
    case 'za': return (a, b) => (b.name || '').localeCompare(a.name || '');
    case 'created': return (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    default: return (a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0);
  }
}

function _timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ═══════════════════════════════════════════════
// CLIENT FORM (create / edit)
// ═══════════════════════════════════════════════
export function openClientForm(profileId) {
  _editingId = profileId || null;
  _pendingAvatar = undefined;
  const modal = document.getElementById('client-list-modal');
  if (!modal) return;
  const profiles = getProfiles();
  const p = profileId ? profiles.find(pr => pr.id === profileId) : null;

  const name = p ? p.name : '';
  const sex = p ? (p.sex || '') : '';
  const dob = p ? (p.dob || '') : '';
  const country = p ? ((p.location || {}).country || '') : '';
  const zip = p ? ((p.location || {}).zip || '') : '';
  const tags = p ? (p.tags || []) : [];
  const notes = p ? (p.notes || '') : '';
  const status = p ? (p.status || 'active') : 'active';
  const avatar = p ? (p.avatar || '') : '';
  const heightData = p ? getProfileHeight(p.id) : { height: null, unit: 'cm' };
  const heightUnit = heightData.unit || 'cm';
  const heightDisplay = heightData.height ? (heightUnit === 'in' ? (heightData.height / 2.54).toFixed(1) : heightData.height) : '';
  const _bio = state.importedData?.biometrics;
  const hasBioData = heightData.height || (_bio && (_bio.weight?.length || _bio.bp?.length || _bio.pulse?.length));

  const avatarColor = getAvatarColor(p ? p.id : 'new');
  const avatarInitial = (name || '?')[0].toUpperCase();
  const avatarPreview = avatar && _isSafeAvatarSrc(avatar)
    ? `<img class="cl-avatar-preview-img" id="cl-avatar-img" src="${escapeAttr(avatar)}" alt="">`
    : `<span class="cl-avatar-preview-initial" id="cl-avatar-img" style="background:${avatarColor}">${escapeHTML(avatarInitial)}</span>`;

  modal.innerHTML = `<div class="cl-header">
    <div class="cl-header-left">
      <button class="cl-back-btn" onclick="window._clBackToList()">&larr;</button>
      <h2 class="cl-title">${p ? 'Edit Client' : 'New Client'}</h2>
    </div>
    <div class="cl-header-right">
      <button class="modal-close" onclick="closeClientList()" aria-label="Close">&times;</button>
    </div>
  </div>
  <form class="cl-form" onsubmit="window._clSaveForm(event)">
    <div class="cl-form-row cl-avatar-row">
      <div class="cl-avatar-picker" onclick="document.getElementById('cl-avatar-input').click()">
        ${avatarPreview}
        <span class="cl-avatar-edit-icon">&#128247;</span>
      </div>
      <input type="file" id="cl-avatar-input" accept="image/*" style="display:none" onchange="window._clAvatarChanged(this)">
      ${avatar ? `<button type="button" class="cl-avatar-remove" onclick="window._clRemoveAvatar()">Remove photo</button>` : ''}
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Name <span class="cl-required">*</span></label>
      <input type="text" class="cl-form-input" id="cl-name" value="${escapeHTML(name)}" required autofocus>
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Sex</label>
      <div class="cl-sex-toggle" id="cl-sex-toggle">
        <button type="button" class="sex-toggle-btn${sex === 'male' ? ' active' : ''}" data-sex="male" onclick="window._clSetSex('male')">Male</button>
        <button type="button" class="sex-toggle-btn${sex === 'female' ? ' active' : ''}" data-sex="female" onclick="window._clSetSex('female')">Female</button>
      </div>
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Date of Birth</label>
      <input type="date" class="cl-form-input cl-form-date" id="cl-dob" value="${escapeHTML(dob)}">
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Location <span style="font-weight:400;color:var(--text-muted);font-size:11px">(for latitude / circadian context)</span></label>
      <div class="cl-form-row-split">
        <div class="cl-form-col">
          <input type="text" class="cl-form-input" id="cl-country" value="${escapeHTML(country)}" placeholder="Country" oninput="window._clUpdateLat()">
        </div>
        <div class="cl-form-col">
          <input type="text" class="cl-form-input" id="cl-zip" value="${escapeHTML(zip)}" placeholder="ZIP / postal code" oninput="window._clUpdateLat()">
        </div>
      </div>
      <div id="cl-lat-display" style="font-size:11px;margin-top:4px"></div>
    </div>
    <div class="cl-form-row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
      <label class="cl-form-label cl-bio-toggle" onclick="window._clToggleBio()" style="cursor:pointer;user-select:none">
        <span class="cl-bio-arrow" id="cl-bio-arrow">${hasBioData ? '&#9660;' : '&#9654;'}</span> Biometrics
        <span id="cl-bio-summary" style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:6px"></span>
      </label>
      <div id="cl-bio-body" style="${hasBioData ? '' : 'display:none'}">
        <div class="cl-form-row-split" style="margin-bottom:8px">
          <div class="cl-form-col">
            <label style="font-size:11px;color:var(--text-muted)">Height <a href="#" class="cl-bio-unit-toggle" id="cl-height-unit-toggle" data-unit="${heightUnit}" onclick="window._clHeightUnitChanged();return false">${heightUnit}</a></label>
            <input type="number" class="cl-form-input" id="cl-height" value="${escapeHTML(String(heightDisplay))}" step="0.1" placeholder="${heightUnit === 'in' ? 'inches' : 'cm'}" oninput="window._clUpdateBMI()">
            <input type="hidden" id="cl-height-unit" value="${heightUnit}">
          </div>
          <div class="cl-form-col">
            <label style="font-size:11px;color:var(--text-muted)">BMI</label>
            <div class="mc-auto-value" id="cl-bmi-display"></div>
          </div>
        </div>
        <div id="cl-bio-weight"></div>
        <div id="cl-bio-bp"></div>
        <div id="cl-bio-pulse"></div>
      </div>
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">mtDNA Haplogroup <span style="font-weight:400;color:var(--text-muted);font-size:11px">(maternal lineage)</span></label>
      <div style="display:flex;align-items:center;gap:8px">
        <select class="cl-form-input" id="cl-haplogroup" style="max-width:160px" onchange="window._clHaplogroupChanged()">
          <option value="">— not set —</option>
          ${window.HAPLOGROUP_LIST ? window.HAPLOGROUP_LIST.map(h => '<option value="' + h + '"' + (state.importedData?.genetics?.mtdna?.haplogroup === h ? ' selected' : '') + '>' + h + '</option>').join('') : ''}
        </select>
        <span id="cl-hg-coupling" style="font-size:12px;color:var(--text-muted)">${state.importedData?.genetics?.mtdna?.coupling?.shortLabel || ''}</span>
      </div>
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Tags</label>
      <div class="cl-tags-wrap" id="cl-tags-wrap">
        ${tags.map(t => `<span class="cl-tag-pill">${escapeHTML(t)}<button type="button" class="cl-tag-remove" onclick="window._clRemoveTag(this)">&times;</button></span>`).join('')}
        <input type="text" class="cl-tag-input" id="cl-tag-input" placeholder="Add tag + Enter" onkeydown="window._clTagKeydown(event)">
      </div>
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Notes</label>
      <textarea class="cl-form-textarea" id="cl-notes" rows="3" placeholder="Practitioner notes...">${escapeHTML(notes)}</textarea>
    </div>
    <div class="cl-form-row">
      <label class="cl-form-label">Status</label>
      <div class="cl-status-radios">
        <label class="cl-radio"><input type="radio" name="cl-status" value="active"${status === 'active' ? ' checked' : ''}> Active</label>
        <label class="cl-radio"><input type="radio" name="cl-status" value="flagged"${status === 'flagged' ? ' checked' : ''}> Flagged</label>
        <label class="cl-radio"><input type="radio" name="cl-status" value="archived"${status === 'archived' ? ' checked' : ''}> Archived</label>
      </div>
    </div>
    <div class="cl-form-actions">
      <button type="button" class="cl-form-cancel" onclick="window._clBackToList()">Cancel</button>
      <button type="submit" class="cl-form-save">${p ? 'Save Changes' : 'Create Client'}</button>
    </div>
  </form>`;
  requestAnimationFrame(() => {
    _clUpdateLat();
    _clRenderBioField('weight');
    _clRenderBioField('bp');
    _clRenderBioField('pulse');
    _clUpdateBMI();
    _clUpdateBioSummary();
  });
}

// ═══════════════════════════════════════════════
// FORM HANDLERS
// ═══════════════════════════════════════════════
function _clSaveForm(e) {
  e.preventDefault();
  const name = (document.getElementById('cl-name')?.value || '').trim();
  if (!name) return;
  const sexBtn = document.querySelector('#cl-sex-toggle .sex-toggle-btn.active');
  const sex = sexBtn ? sexBtn.dataset.sex : null;
  const dob = document.getElementById('cl-dob')?.value || null;
  const country = (document.getElementById('cl-country')?.value || '').trim();
  const zip = (document.getElementById('cl-zip')?.value || '').trim();
  const notes = (document.getElementById('cl-notes')?.value || '').trim();
  const statusRadio = document.querySelector('input[name="cl-status"]:checked');
  const status = statusRadio ? statusRadio.value : 'active';

  // Collect tags from pills
  const tags = [];
  document.querySelectorAll('#cl-tags-wrap .cl-tag-pill').forEach(pill => {
    const text = pill.firstChild.textContent.trim();
    if (text && !tags.includes(text)) tags.push(text);
  });

  // Height — stored in cm
  const heightRaw = parseFloat(document.getElementById('cl-height')?.value);
  const heightUnit = document.getElementById('cl-height-unit')?.value || 'cm';
  const height = heightRaw ? (heightUnit === 'in' ? Math.round(heightRaw * 2.54 * 10) / 10 : heightRaw) : null;

  // Build avatar update
  const avatarUpdate = {};
  if (_pendingAvatar !== undefined) {
    avatarUpdate.avatar = _pendingAvatar; // null = remove, string = new
  }

  if (_editingId) {
    // Update existing profile
    updateProfileMeta(_editingId, { name, sex, dob, location: { country, zip }, tags, notes, status, height, heightUnit, ...avatarUpdate });
    // If editing the active profile, sync runtime state so data pipeline uses fresh values
    if (_editingId === state.currentProfile) {
      if (sex !== undefined) state.profileSex = sex;
      if (dob !== undefined) state.profileDob = dob;
    }
    window.renderProfileButton();
    window.showNotification(`"${name}" updated`, 'info');
  } else {
    // Create new profile
    const id = createProfile(name, { sex, dob, location: { country, zip }, tags, notes, status, height, heightUnit, ...avatarUpdate });
    switchProfile(id);
    window.renderProfileButton();
    window.showNotification(`"${name}" created`, 'success');
  }
  _editingId = null;
  renderClientList();
}

async function _clHaplogroupChanged() {
  const sel = document.getElementById('cl-haplogroup');
  const label = document.getElementById('cl-hg-coupling');
  if (!sel) return;
  const hg = sel.value;
  if (!hg) {
    if (label) label.textContent = '';
    return;
  }
  await window.setManualHaplogroup(hg);
  // Update coupling label
  const mt = state.importedData?.genetics?.mtdna;
  if (label) label.textContent = mt?.coupling?.shortLabel || '';
}

async function _clAvatarChanged(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await _resizeAvatar(file);
    _pendingAvatar = dataUrl;
    const container = document.querySelector('.cl-avatar-picker');
    if (container) {
      container.innerHTML = `<img class="cl-avatar-preview-img" id="cl-avatar-img" src="${escapeAttr(dataUrl)}" alt=""><span class="cl-avatar-edit-icon">&#128247;</span>`;
    }
    // Add remove button if not present
    if (!document.querySelector('.cl-avatar-remove')) {
      const row = document.querySelector('.cl-avatar-row');
      if (row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cl-avatar-remove';
        btn.textContent = 'Remove photo';
        btn.onclick = () => window._clRemoveAvatar();
        row.appendChild(btn);
      }
    }
  } catch {
    window.showNotification('Could not load image', 'error');
  }
  input.value = '';
}

function _clRemoveAvatar() {
  _pendingAvatar = null;
  const container = document.querySelector('.cl-avatar-picker');
  if (container) {
    const color = getAvatarColor(_editingId || 'new');
    const nameInput = document.getElementById('cl-name');
    const initial = ((nameInput?.value || '?')[0]).toUpperCase();
    container.innerHTML = `<span class="cl-avatar-preview-initial" id="cl-avatar-img" style="background:${color}">${escapeHTML(initial)}</span><span class="cl-avatar-edit-icon">&#128247;</span>`;
  }
  const removeBtn = document.querySelector('.cl-avatar-remove');
  if (removeBtn) removeBtn.remove();
}

function _clSetSex(sex) {
  document.querySelectorAll('#cl-sex-toggle .sex-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sex === sex);
  });
}

function _clShowLat(el, lat, suffix) {
  var band = latitudeToBand(lat);
  el.style.color = 'var(--green)';
  el.textContent = '\u2713 ' + Math.abs(Math.round(lat)) + '\u00b0' + (lat >= 0 ? 'N' : 'S') + ' \u2014 ' + LATITUDE_BANDS[band] + (suffix || '');
}

var _clLatTimer = null;
function _clUpdateLat() {
  const country = (document.getElementById('cl-country')?.value || '').trim();
  const zip = (document.getElementById('cl-zip')?.value || '').trim();
  const el = document.getElementById('cl-lat-display');
  if (!el) return;
  if (!country) { el.textContent = ''; return; }

  var cache = getLocationCache();
  var cacheKey = (country + '|' + zip).toLowerCase();
  var cached = cache[cacheKey];

  // Exact cache hit — show immediately, done
  if (cached !== undefined) {
    var countryLat = zip ? cache[(country + '|').toLowerCase()] : undefined;
    var zipSuffix = '';
    if (zip && countryLat !== undefined) zipSuffix = Math.round(cached) !== Math.round(countryLat) ? ' (ZIP-refined)' : ' (ZIP \u2014 same area)';
    _clShowLat(el, cached, zipSuffix);
    return;
  }

  // No exact hit — check if country-only is cached (show it as interim when ZIP is being refined)
  var countryOnly = zip ? cache[(country + '|').toLowerCase()] : undefined;
  if (countryOnly !== undefined) {
    _clShowLat(el, countryOnly, ' \u2014 refining with ZIP\u2026');
  } else {
    // Hardcoded fallback (instant, no AI needed)
    var bandLabel = getLatitudeFromLocation(country, zip);
    if (bandLabel) {
      el.style.color = 'var(--green)';
      el.textContent = '\u2713 ' + bandLabel + (window.hasAIProvider() ? ' \u2014 refining\u2026' : '');
    } else if (window.hasAIProvider()) {
      el.style.color = 'var(--text-muted)';
      el.textContent = 'Detecting\u2026';
    } else {
      el.style.color = 'var(--text-muted)';
      el.textContent = 'Country not recognized \u2014 try the full name';
    }
  }

  // Debounced AI refinement
  if (_clLatTimer) clearTimeout(_clLatTimer);
  if (window.hasAIProvider()) {
    _clLatTimer = setTimeout(function() {
      detectLatitudeWithAI(country, zip).then(() => {
        var freshCache = getLocationCache();
        var updated = freshCache[(country + '|' + zip).toLowerCase()];
        if (updated !== undefined) {
          var cOnly = zip ? freshCache[(country + '|').toLowerCase()] : undefined;
          var zSuffix = '';
          if (zip && cOnly !== undefined) zSuffix = Math.round(updated) !== Math.round(cOnly) ? ' (ZIP-refined)' : ' (ZIP \u2014 same area)';
          var display = document.getElementById('cl-lat-display');
          if (display) _clShowLat(display, updated, zSuffix);
        }
      });
    }, 1500);
  }
}

function _clTagKeydown(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const input = e.target;
  const val = input.value.trim();
  if (!val) return;
  // Check for duplicates
  const existing = [];
  document.querySelectorAll('#cl-tags-wrap .cl-tag-pill').forEach(pill => {
    existing.push(pill.firstChild.textContent.trim().toLowerCase());
  });
  if (existing.includes(val.toLowerCase())) { input.value = ''; return; }
  const pill = document.createElement('span');
  pill.className = 'cl-tag-pill';
  pill.innerHTML = `${escapeHTML(val)}<button type="button" class="cl-tag-remove" onclick="window._clRemoveTag(this)">&times;</button>`;
  const wrap = document.getElementById('cl-tags-wrap');
  wrap.insertBefore(pill, input);
  input.value = '';
}

function _clRemoveTag(btn) {
  btn.parentElement.remove();
}

function _clBackToList() {
  _editingId = null;
  renderClientList();
}

// ═══════════════════════════════════════════════
// LIST ACTIONS
// ═══════════════════════════════════════════════
function _clSelect(id) {
  switchProfile(id);
  window.renderProfileButton();
  closeClientList();
}

function _clSearch(val) {
  _search = val;
  renderClientList();
  // Restore focus + cursor position
  requestAnimationFrame(() => {
    const input = document.getElementById('cl-search');
    if (input) { input.focus(); input.setSelectionRange(val.length, val.length); }
  });
}

function _clSort(val) { _sort = val; renderClientList(); }
function _clStatusFilter(val) { _statusFilter = val; renderClientList(); }
function _clTagFilter(val) { _tagFilter = (_tagFilter === val) ? '' : val; renderClientList(); }

function _clToggleMenu(e, id) {
  e.stopPropagation();
  const menu = document.getElementById('cl-active-menu');
  if (!menu) return;
  // Toggle off if already open for this profile
  if (menu.classList.contains('show') && menu.dataset.profileId === id) {
    menu.classList.remove('show');
    return;
  }
  // Build menu items for this profile
  const profiles = getProfiles();
  const p = profiles.find(pr => pr.id === id);
  if (!p) return;
  menu.dataset.profileId = id;
  const eid = escapeAttr(id);
  menu.innerHTML =
    (p.pinned
      ? `<div class="cl-menu-item" onclick="window._clUnpin('${eid}')">Unpin</div>`
      : `<div class="cl-menu-item" onclick="window._clPin('${eid}')">Pin</div>`) +
    (p.status === 'flagged'
      ? `<div class="cl-menu-item" onclick="window._clUnflag('${eid}')">Unflag</div>`
      : `<div class="cl-menu-item" onclick="window._clFlag('${eid}')">Flag</div>`) +
    `<div class="cl-menu-sep"></div>` +
    `<div class="cl-menu-item" onclick="window._clExport('${eid}')">Export</div>` +
    `<div class="cl-menu-item" onclick="window._clExportChat('${eid}')">Export with Chat</div>` +
    `<div class="cl-menu-sep"></div>` +
    (p.status === 'archived'
      ? `<div class="cl-menu-item" onclick="window._clUnarchive('${eid}')">Unarchive</div>`
      : `<div class="cl-menu-item" onclick="window._clArchive('${eid}')">Archive</div>`) +
    `<div class="cl-menu-item cl-menu-danger" onclick="window._clDelete('${eid}')">Delete</div>`;
  // Position relative to the modal (absolute positioned child)
  const btn = e.currentTarget;
  const modal = menu.parentElement;
  const modalRect = modal.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  menu.style.right = (modalRect.right - btnRect.right) + 'px';
  // Show first so we can measure menu height
  menu.classList.add('show');
  const menuH = menu.offsetHeight;
  const modalH = modalRect.height;
  const btnBottom = btnRect.bottom - modalRect.top;
  const btnTop = btnRect.top - modalRect.top;
  // Prefer below; flip above if more space there
  const spaceBelow = modalH - btnBottom;
  const spaceAbove = btnTop;
  let top;
  if (spaceBelow >= menuH + 8 || spaceBelow >= spaceAbove) {
    top = btnBottom + 4;
  } else {
    top = btnTop - menuH - 4;
  }
  menu.style.top = top + 'px';
}

function _clPin(id) { updateProfileMeta(id, { pinned: true }); renderClientList(); }
function _clUnpin(id) { updateProfileMeta(id, { pinned: false }); renderClientList(); }
function _clFlag(id) { updateProfileMeta(id, { status: 'flagged' }); renderClientList(); window.renderProfileButton(); }
function _clUnflag(id) { updateProfileMeta(id, { status: 'active' }); renderClientList(); window.renderProfileButton(); }
function _clArchive(id) { updateProfileMeta(id, { status: 'archived' }); renderClientList(); window.renderProfileButton(); }
function _clUnarchive(id) { updateProfileMeta(id, { status: 'active' }); renderClientList(); window.renderProfileButton(); }
function _closeMenus() { const m = document.getElementById('cl-active-menu'); if (m) m.classList.remove('show'); }
function _clExport(id) { _closeMenus(); window.exportClientJSON(id); }
function _clExportChat(id) { _closeMenus(); window.exportClientJSON(id, true); }
function _clDelete(id) { _closeMenus(); deleteProfile(id, () => renderClientList()); }

// Close context menus on click outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cl-row-menu-btn')) _closeMenus();
});

// ═══════════════════════════════════════════════
// BIOMETRICS HELPERS
// ═══════════════════════════════════════════════

function _getBio() {
  if (!state.importedData) return { weight: [], bp: [], pulse: [] };
  if (!state.importedData.biometrics) state.importedData.biometrics = { weight: [], bp: [], pulse: [] };
  const b = state.importedData.biometrics;
  if (!b.weight) b.weight = [];
  if (!b.bp) b.bp = [];
  if (!b.pulse) b.pulse = [];
  return b;
}

function _fmtBioDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function _clRenderBioField(type) {
  const container = document.getElementById(`cl-bio-${type}`);
  if (!container) return;
  const bio = _getBio();
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'weight') {
    const entries = [...(bio.weight || [])].sort((a, b) => b.date.localeCompare(a.date));
    const avgKg = _clBioAvg(entries.map(e => e.unit === 'lbs' ? e.value / 2.205 : e.value));
    const displayUnit = entries.length ? entries[0].unit : 'kg';
    const avgText = avgKg !== null
      ? `avg ${(displayUnit === 'lbs' ? (avgKg * 2.205).toFixed(1) : avgKg.toFixed(1))} ${displayUnit}`
      : '';
    const countLink = entries.length ? `<a href="#" class="cl-bio-history-link" onclick="window._clToggleBioHistory('weight');return false">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</a>` : '';
    const hint = [avgText, countLink].filter(Boolean).join(' · ');
    const wUnit = entries.length ? entries[0].unit : 'kg';
    container.innerHTML = `
      <div class="cl-form-row" style="margin-bottom:0">
        <label class="cl-form-label" style="font-size:12px">Weight <a href="#" class="cl-bio-unit-toggle" id="cl-bio-weight-unit-toggle" onclick="window._clWeightUnitChanged();return false">${wUnit}</a></label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" class="cl-form-input" id="cl-bio-weight-val" step="0.1" placeholder="value" style="flex:1">
          <input type="hidden" id="cl-bio-weight-unit" value="${wUnit}">
          <input type="date" class="cl-form-input cl-form-date" id="cl-bio-weight-date" value="${today}" style="flex:0 0 auto">
          <button type="button" class="cl-bio-add" onclick="window._clAddBioEntry('weight')">Add</button>
        </div>
        ${hint ? `<div class="cl-bio-hint">${hint}</div>` : ''}
      </div>
      ${_clBioHistory(entries, 'weight')}`;
  } else if (type === 'bp') {
    const entries = [...(bio.bp || [])].sort((a, b) => b.date.localeCompare(a.date));
    const avgSys = _clBioAvg(entries.map(e => e.sys));
    const avgDia = _clBioAvg(entries.map(e => e.dia));
    const avgText = avgSys !== null ? `avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg` : '';
    const countLink = entries.length ? `<a href="#" class="cl-bio-history-link" onclick="window._clToggleBioHistory('bp');return false">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</a>` : '';
    const hint = [avgText, countLink].filter(Boolean).join(' · ');
    container.innerHTML = `
      <div class="cl-form-row" style="margin-bottom:0">
        <label class="cl-form-label" style="font-size:12px">Blood Pressure</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" class="cl-form-input" id="cl-bio-bp-sys" placeholder="sys" style="flex:1">
          <span style="color:var(--text-muted)">/</span>
          <input type="number" class="cl-form-input" id="cl-bio-bp-dia" placeholder="dia" style="flex:1">
          <input type="date" class="cl-form-input cl-form-date" id="cl-bio-bp-date" value="${today}" style="flex:0 0 auto">
          <button type="button" class="cl-bio-add" onclick="window._clAddBioEntry('bp')">Add</button>
        </div>
        ${hint ? `<div class="cl-bio-hint">${hint}</div>` : ''}
      </div>
      ${_clBioHistory(entries, 'bp')}`;
  } else if (type === 'pulse') {
    const entries = [...(bio.pulse || [])].sort((a, b) => b.date.localeCompare(a.date));
    const avg = _clBioAvg(entries.map(e => e.value));
    const avgText = avg !== null ? `avg ${Math.round(avg)} bpm` : '';
    const countLink = entries.length ? `<a href="#" class="cl-bio-history-link" onclick="window._clToggleBioHistory('pulse');return false">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</a>` : '';
    const hint = [avgText, countLink].filter(Boolean).join(' · ');
    container.innerHTML = `
      <div class="cl-form-row" style="margin-bottom:0">
        <label class="cl-form-label" style="font-size:12px">Resting Pulse</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" class="cl-form-input" id="cl-bio-pulse-val" placeholder="bpm" style="flex:1">
          <input type="date" class="cl-form-input cl-form-date" id="cl-bio-pulse-date" value="${today}" style="flex:0 0 auto">
          <button type="button" class="cl-bio-add" onclick="window._clAddBioEntry('pulse')">Add</button>
        </div>
        ${hint ? `<div class="cl-bio-hint">${hint}</div>` : ''}
      </div>
      ${_clBioHistory(entries, 'pulse')}`;
  }
}

function _clBioAvg(values) {
  const nums = values.filter(v => v != null && !isNaN(v));
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function _clBioHistory(entries, type) {
  if (!entries.length) return '';
  const show = entries.slice(0, 5);
  let items = '';
  for (const e of show) {
    let display = '';
    if (type === 'weight') display = `${e.value} ${e.unit}`;
    else if (type === 'bp') display = `${e.sys}/${e.dia} mmHg`;
    else if (type === 'pulse') display = `${e.value} bpm`;
    items += `<div class="supp-list-item">
      <div class="supp-list-info">
        <div class="supp-list-name">${escapeHTML(_fmtBioDate(e.date))}</div>
        <div class="supp-list-meta">${escapeHTML(display)}</div>
      </div>
      <div class="supp-list-actions">
        <button class="delete" onclick="window._clDeleteBioEntry('${type}','${escapeAttr(e.date)}')">&times;</button>
      </div>
    </div>`;
  }
  if (entries.length > 5) {
    items += `<button type="button" class="cl-bio-show-all" onclick="window._clBioShowAll('${type}')">Show all (${entries.length})</button>`;
  }
  return `<div class="supp-list cl-bio-history" id="cl-bio-history-${type}" style="display:none;margin-top:4px">${items}</div>`;
}

function _clAddBioEntry(type) {
  const bio = _getBio();
  // Dual-write shape: `manualWrite` holds the wearables-IDB payload the async
  // hook at the end of this function ships into the manual source. The
  // in-memory biometrics update above keeps working as-is so the modal UI
  // renders synchronously; the IDB write catches up and refreshes the strip.
  let manualWrite = null;
  if (type === 'weight') {
    const val = parseFloat(document.getElementById('cl-bio-weight-val')?.value);
    const unit = document.getElementById('cl-bio-weight-unit')?.value || 'kg';
    const date = document.getElementById('cl-bio-weight-date')?.value;
    if (!val || val <= 0 || !date) { window.showNotification('Enter a valid weight and date', 'error'); return; }
    const maxW = unit === 'lbs' ? 1100 : 500;
    if (val > maxW) { window.showNotification(`Weight over ${maxW} ${unit} seems unlikely`, 'error'); return; }
    bio.weight = bio.weight.filter(e => e.date !== date);
    bio.weight.push({ date, value: val, unit, source: 'manual' });
    bio.weight.sort((a, b) => a.date.localeCompare(b.date));
    // Canonicalize to kg for the wearables store.
    const kg = unit === 'lbs' ? val / 2.20462 : val;
    manualWrite = { kind: 'metric', metric: 'weight', date, value: kg };
  } else if (type === 'bp') {
    const sys = parseInt(document.getElementById('cl-bio-bp-sys')?.value);
    const dia = parseInt(document.getElementById('cl-bio-bp-dia')?.value);
    const date = document.getElementById('cl-bio-bp-date')?.value;
    if (!sys || !dia || sys <= 0 || dia <= 0 || !date) { window.showNotification('Enter valid systolic, diastolic and date', 'error'); return; }
    if (sys > 300 || dia > 200) { window.showNotification('BP values seem too high', 'error'); return; }
    if (dia >= sys) { window.showNotification('Diastolic should be lower than systolic', 'error'); return; }
    bio.bp = bio.bp.filter(e => e.date !== date);
    bio.bp.push({ date, sys, dia, source: 'manual' });
    bio.bp.sort((a, b) => a.date.localeCompare(b.date));
    manualWrite = { kind: 'bp', date, systolic: sys, diastolic: dia };
  } else if (type === 'pulse') {
    const val = parseInt(document.getElementById('cl-bio-pulse-val')?.value);
    const date = document.getElementById('cl-bio-pulse-date')?.value;
    if (!val || val <= 0 || !date) { window.showNotification('Enter a valid pulse and date', 'error'); return; }
    if (val > 250) { window.showNotification('Pulse over 250 bpm seems unlikely', 'error'); return; }
    bio.pulse = bio.pulse.filter(e => e.date !== date);
    bio.pulse.push({ date, value: val, source: 'manual' });
    bio.pulse.sort((a, b) => a.date.localeCompare(b.date));
    manualWrite = { kind: 'metric', metric: 'rhr', date, value: val };
  }
  if (window.recordChange) window.recordChange('biometrics');
  window.saveImportedData();
  _clRenderBioField(type);
  _clUpdateBMI();
  _clUpdateBioSummary();

  // Dual-write into the wearables IDB so the dashboard strip reflects the
  // new entry alongside Oura/Withings/etc. Fire-and-forget — the modal UI
  // doesn't block on it. Summary resync happens after the write lands.
  if (manualWrite) {
    (async () => {
      try {
        const { logManualMetric, logManualBP, refreshManualSummary } = await import('./wearables-manual.js');
        if (manualWrite.kind === 'metric') {
          await logManualMetric(state.currentProfile, manualWrite.metric, { date: manualWrite.date, value: manualWrite.value });
        } else if (manualWrite.kind === 'bp') {
          await logManualBP(state.currentProfile, { date: manualWrite.date, systolic: manualWrite.systolic, diastolic: manualWrite.diastolic });
        }
        await refreshManualSummary(state.currentProfile);
      } catch (e) {
        if (window.isDebugMode?.()) console.warn('[client-list] manual dual-write failed:', e.message);
      }
    })();
  }
}

function _clDeleteBioEntry(type, date) {
  const bio = _getBio();
  if (bio[type]) {
    bio[type] = bio[type].filter(e => e.date !== date);
    if (window.recordChange) window.recordChange('biometrics');
    window.saveImportedData();
    _clRenderBioField(type);
    _clUpdateBMI();
    _clUpdateBioSummary();
  }
  // Mirror the delete into the wearables store so the dashboard strip stays
  // in sync. `bp` deletions clear both systolic and diastolic for that date.
  (async () => {
    try {
      const { deleteManualMetric, refreshManualSummary } = await import('./wearables-manual.js');
      if (type === 'weight') await deleteManualMetric(state.currentProfile, 'weight', date);
      else if (type === 'pulse') await deleteManualMetric(state.currentProfile, 'rhr', date);
      else if (type === 'bp') {
        await deleteManualMetric(state.currentProfile, 'bp_systolic', date);
        await deleteManualMetric(state.currentProfile, 'bp_diastolic', date);
      }
      await refreshManualSummary(state.currentProfile);
    } catch (e) {
      if (window.isDebugMode?.()) console.warn('[client-list] manual delete mirror failed:', e.message);
    }
  })();
}

function _clBioShowAll(type) {
  const bio = _getBio();
  const entries = [...(bio[type] || [])].sort((a, b) => b.date.localeCompare(a.date));
  const container = document.querySelector(`#cl-bio-${type} .supp-list`);
  if (!container) return;
  let html = '';
  for (const e of entries) {
    let display = '';
    if (type === 'weight') display = `${e.value} ${e.unit}`;
    else if (type === 'bp') display = `${e.sys}/${e.dia} mmHg`;
    else if (type === 'pulse') display = `${e.value} bpm`;
    html += `<div class="supp-list-item">
      <div class="supp-list-info">
        <div class="supp-list-name">${escapeHTML(_fmtBioDate(e.date))}</div>
        <div class="supp-list-meta">${escapeHTML(display)}</div>
      </div>
      <div class="supp-list-actions">
        <button class="delete" onclick="window._clDeleteBioEntry('${type}','${escapeAttr(e.date)}')">&times;</button>
      </div>
    </div>`;
  }
  container.innerHTML = html;
}

function _clUpdateBMI() {
  const el = document.getElementById('cl-bmi-display');
  if (!el) return;
  const heightRaw = parseFloat(document.getElementById('cl-height')?.value);
  const heightUnit = document.getElementById('cl-height-unit')?.value || 'cm';
  const heightCm = heightRaw ? (heightUnit === 'in' ? heightRaw * 2.54 : heightRaw) : null;

  // Get latest weight
  const bio = _getBio();
  const weights = bio.weight || [];
  const latest = weights.length ? [...weights].sort((a, b) => b.date.localeCompare(a.date))[0] : null;
  const weightKg = latest ? (latest.unit === 'lbs' ? latest.value / 2.205 : latest.value) : null;

  if (heightCm && weightKg) {
    const htM = heightCm / 100;
    const bmi = weightKg / (htM * htM);
    let cat = '> 30';
    if (bmi < 18.5) cat = '< 18.5';
    else if (bmi < 25) cat = 'normal';
    else if (bmi < 30) cat = '25–30';
    el.className = 'mc-auto-value';
    el.textContent = `${bmi.toFixed(1)} (${cat})`;
  } else {
    el.className = 'mc-auto-value mc-auto-pending';
    el.textContent = heightCm ? 'add weight' : weightKg ? 'add height' : '--';
  }
  _clUpdateBioSummary();
}

function _clToggleBioHistory(type) {
  const el = document.getElementById(`cl-bio-history-${type}`);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function _clToggleBio() {
  const body = document.getElementById('cl-bio-body');
  const arrow = document.getElementById('cl-bio-arrow');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (arrow) arrow.innerHTML = open ? '&#9654;' : '&#9660;';
}

function _clUpdateBioSummary() {
  const el = document.getElementById('cl-bio-summary');
  if (!el) return;
  const bio = _getBio();
  const h = parseFloat(document.getElementById('cl-height')?.value);
  const parts = [];
  if (h) parts.push(`${document.getElementById('cl-height')?.value} ${document.getElementById('cl-height-unit')?.value || 'cm'}`);
  if (bio.weight?.length) {
    const latest = [...bio.weight].sort((a, b) => b.date.localeCompare(a.date))[0];
    parts.push(`${latest.value} ${latest.unit}`);
  }
  if (bio.bp?.length) {
    const latest = [...bio.bp].sort((a, b) => b.date.localeCompare(a.date))[0];
    parts.push(`${latest.sys}/${latest.dia}`);
  }
  if (bio.pulse?.length) {
    const latest = [...bio.pulse].sort((a, b) => b.date.localeCompare(a.date))[0];
    parts.push(`${latest.value} bpm`);
  }
  el.textContent = parts.length ? parts.join(' · ') : '';
}

function _clWeightUnitChanged() {
  const hidden = document.getElementById('cl-bio-weight-unit');
  const toggle = document.getElementById('cl-bio-weight-unit-toggle');
  if (!hidden || !toggle) return;
  const next = hidden.value === 'kg' ? 'lbs' : 'kg';
  hidden.value = next;
  toggle.textContent = next;
}

function _clHeightUnitChanged() {
  const input = document.getElementById('cl-height');
  const hidden = document.getElementById('cl-height-unit');
  const toggle = document.getElementById('cl-height-unit-toggle');
  if (!input || !hidden || !toggle) return;
  const current = hidden.value;
  const next = current === 'cm' ? 'in' : 'cm';
  const val = parseFloat(input.value);
  if (val) {
    input.value = next === 'in' ? (val / 2.54).toFixed(1) : (val * 2.54).toFixed(1);
  }
  input.placeholder = next === 'in' ? 'inches' : 'cm';
  hidden.value = next;
  toggle.textContent = next;
  toggle.dataset.unit = next;
  _clUpdateBMI();
}

Object.assign(window, {
  openClientList, closeClientList, openClientForm,
  _clSearch, _clSort, _clStatusFilter, _clTagFilter, _clSelect,
  _clSaveForm, _clSetSex, _clUpdateLat, _clTagKeydown, _clRemoveTag, _clBackToList,
  _clAvatarChanged, _clRemoveAvatar, _clHaplogroupChanged,
  _clToggleMenu, _clPin, _clUnpin, _clFlag, _clUnflag, _clArchive, _clUnarchive, _clExport, _clExportChat, _clDelete,
  _clAddBioEntry, _clDeleteBioEntry, _clBioShowAll, _clUpdateBMI, _clHeightUnitChanged, _clWeightUnitChanged, _clToggleBio, _clToggleBioHistory,
});
