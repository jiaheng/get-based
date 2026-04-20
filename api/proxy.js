// Vercel Edge Function — AI API proxy
// Eliminates CORS restrictions for all AI providers.
// Keys pass through from the client, never stored server-side.

export const config = { runtime: 'edge' };

// Allowlisted provider URL prefixes — these always pass without further
// checks. User-configured endpoints (Custom API, decentralized Routstr
// nodes) are allowed too, but only over HTTPS with a non-private host.
const ALLOWED_ORIGINS = [
  'https://openrouter.ai/',
  'https://api.venice.ai/',
  'https://api.routstr.com/',
  'https://api.ppq.ai/',
];

/// Block literal IPs in private / reserved / cloud-metadata ranges so
/// attackers can't use the proxy to probe Vercel's internal network or
/// hit cloud metadata services (AWS/GCP 169.254.169.254, Azure
/// 168.63.129.16). Hostnames that DNS-resolve to private IPs would still
/// reach them; that's the next-tier fix (DNS resolution + re-check
/// before fetch), out of scope for this pass.
function _isBlockedHost(host) {
  if (!host) return true;
  // Loopback + localhost aliases
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  // Azure metadata
  if (host === '168.63.129.16') return true;
  // IPv4 literal check — reject strictly-decimal 0-255 octets in reserved ranges
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const octet = m[i];
    // Strict decimal — reject leading zeros (0255 is octal territory)
    if (octet.length > 1 && octet[0] === '0') return true;
    const n = +octet;
    if (n > 255) return true;
  }
  const a = +m[1], b = +m[2];
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // loopback
  if (a === 169 && b === 254) return true;            // link-local + AWS/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64.0.0/10
  if (a === 0) return true;                           // 0.0.0.0/8
  return false;
}

function isAllowedUrl(url) {
  if (ALLOWED_ORIGINS.some(origin => url.startsWith(origin))) return true;
  // Allow any HTTPS endpoint (Custom API, decentralized Routstr nodes)
  // provided the host is public — blocks SSRF into Vercel's internal
  // network and cloud metadata services.
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (_isBlockedHost(u.hostname)) return false;
    return true;
  } catch { return false; }
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed. Use POST with {url, headers, body?, method?}' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const { url, headers, body, method: upstreamMethod } = payload;

  if (!url || !isAllowedUrl(url)) {
    return new Response(JSON.stringify({ error: 'URL not allowed' }), {
      status: 403,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  try {
    const fetchMethod = (upstreamMethod || 'POST').toUpperCase();
    const fetchOpts = {
      method: fetchMethod,
      headers: {
        ...(fetchMethod !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    };
    if (fetchMethod !== 'GET' && body) {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const upstreamRes = await fetch(url, fetchOpts);

    // For non-streaming responses or errors, forward as-is
    const contentType = upstreamRes.headers.get('content-type') || '';
    const isStream = contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');

    if (!isStream) {
      const responseBody = await upstreamRes.text();
      return new Response(responseBody, {
        status: upstreamRes.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': contentType || 'application/json',
        },
      });
    }

    // Stream SSE response through
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Upstream error: ${e.message}` }), {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
