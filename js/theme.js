// theme.js — Theme management, chart colors, time format

export function getTimeFormat() { return localStorage.getItem('labcharts-time-format') || '24h'; }
export function setTimeFormat(fmt) { localStorage.setItem('labcharts-time-format', fmt); }

export function formatTime(time24) {
  if (!time24) return '';
  if (getTimeFormat() === '24h') return time24;
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function parseTimeInput(val) {
  if (!val) return '';
  const v = val.trim().toUpperCase();
  // 24h format: "14:30" or "8:00"
  const m24 = v.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1]), m = parseInt(m24[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  // 12h format: "2:30 PM", "2:30PM", "2PM"
  const m12 = v.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (m12) {
    let h = parseInt(m12[1]);
    const m = parseInt(m12[2] || '0');
    const p = m12[3];
    if (p === 'AM' && h === 12) h = 0;
    else if (p === 'PM' && h !== 12) h += 12;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  return '';
}

export function getTheme() { return localStorage.getItem('labcharts-theme') || 'dark'; }

export function setTheme(theme) {
  localStorage.setItem('labcharts-theme', theme);
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#ffffff' : '#1a1d27';
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  const activeNav = document.querySelector('.nav-item.active');
  const activeCat = activeNav ? activeNav.dataset.category : 'dashboard';
  window.destroyAllCharts();
  window.navigate(activeCat);
  // If the Settings modal is open, the wearables list (and other theme-sensitive
  // panels) won't re-render via navigate(). Vendor logos in the integrations
  // list use theme-aware iconLight/iconDark assets — refresh in place.
  if (document.getElementById('settings-modal')?.classList.contains('show')) {
    window.refreshSettingsWearables?.();
  }
}

export function getChartColors() {
  const s = getComputedStyle(document.documentElement);
  const g = v => s.getPropertyValue(v).trim();
  return {
    tooltipBg: g('--bg-card'), tooltipTitle: g('--text-primary'),
    tooltipBody: g('--text-secondary'), tooltipBorder: g('--border'),
    tickColor: g('--text-muted'), gridColor: g('--chart-grid'),
    legendColor: g('--text-secondary'), lineColor: g('--accent'),
    lineFill: getTheme() === 'light' ? 'rgba(59,124,245,0.1)' : 'rgba(79,140,255,0.1)',
    canvasTooltipBg: g('--chart-tooltip-bg'), canvasTooltipText: g('--text-primary'),
    chronoLineColor: g('--text-muted'),
    green: g('--green'), red: g('--red'), yellow: g('--yellow'),
  };
}

Object.assign(window, { getTheme, setTheme, toggleTheme, getTimeFormat, setTimeFormat, formatTime, parseTimeInput, getChartColors });
