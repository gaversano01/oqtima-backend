require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_BASE = 'https://api.hubapi.com';

// Google Sheets CSV URLs — set these as env vars in Render
const GADS_CSV_URL = process.env.GADS_CSV_URL;
const GA4_CSV_URL = process.env.GA4_CSV_URL;

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cache = {
  hubspot: { contacts: null, deals: null, lastUpdated: null },
  googleAds: { data: null, lastUpdated: null },
  ga4: { data: null, lastUpdated: null },
};

// ─── HUBSPOT ──────────────────────────────────────────────────────────────────
const PROPS = {
  country: 'portal___country',
  campaign: 'portal___source_marketing_campaign',
  documentation: 'portal___documentation',
  docStatus: 'portal___documentation_status',
  clientStatus: 'portal___client_status',
  ftdUsd: 'portal___ftd_usd',
  lifetimeDeposit: 'portal___lifetime_gross_deposit_usd',
  lifetimeNet: 'portal___lifetime_net_deposit_usd',
  lifetimePnl: 'portal___lifetime_pnl_usd',
  madeDeposit: 'portal___made_a_deposit_',
  userType: 'portal___user_type',
};

async function fetchHubspotContacts() {
  try {
    let all = [], after;
    do {
      const params = { limit: 100, properties: Object.values(PROPS).concat(['firstname','lastname','email','createdate']).join(',') };
      if (after) params.after = after;
      const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }, params });
      all = all.concat(res.data.results);
      after = res.data.paging?.next?.after;
    } while (after);
    return all;
  } catch (e) { console.error('HubSpot error:', e.response?.data || e.message); return []; }
}

async function fetchHubspotDeals() {
  try {
    let all = [], after;
    do {
      const params = { limit: 100, properties: ['dealname','amount','dealstage','closedate','createdate'].join(',') };
      if (after) params.after = after;
      const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/deals`, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }, params });
      all = all.concat(res.data.results);
      after = res.data.paging?.next?.after;
    } while (after);
    return all;
  } catch (e) { console.error('Deals error:', e.message); return []; }
}

async function refreshHubspot() {
  console.log('Refreshing HubSpot...');
  const [contacts, deals] = await Promise.all([fetchHubspotContacts(), fetchHubspotDeals()]);
  cache.hubspot = { contacts, deals, lastUpdated: new Date().toISOString() };
  console.log(`HubSpot: ${contacts.length} contacts, ${deals.length} deals`);
}

// ─── GOOGLE ADS CSV ───────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  // Find the real header row — must have 3+ columns and contain known header keywords
  // This skips SyncWith title rows like "Standard Metrics - Last 90 Days"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cols = lines[i].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase()).filter(h => h.length > 0);
    const isRealHeader = cols.length >= 3 && (
      cols.some(c => c === 'day' || c === 'date') ||
      cols.some(c => c === 'sessions') ||
      cols.some(c => c === 'clicks') ||
      cols.some(c => c === 'impr.' || c === 'impressions')
    );
    if (isRealHeader) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    console.warn('CSV header not found. First 3 lines:', lines.slice(0,3).join(' | '));
    return [];
  }
  console.log('CSV header found at row', headerIdx, ':', lines[headerIdx]);
  const headers = lines[headerIdx].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    if (vals.every(v => !v)) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
    rows.push(obj);
  }
  return rows;
}

function cleanNum(val) {
  if (!val) return 0;
  return parseFloat(val.toString().replace(/[$,%]/g, '')) || 0;
}

async function refreshGoogleAds() {
  if (!GADS_CSV_URL) { console.warn('GADS_CSV_URL not set'); return; }
  try {
    console.log('Refreshing Google Ads...');
    const res = await axios.get(GADS_CSV_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = parseCSV(res.data);

    let totalImpr = 0, totalClicks = 0, totalCost = 0, totalConv = 0;
    const byDay = {}, byDate = [];

    rows.forEach(r => {
      const day = r['day'] || r['date'] || '';
      const impr = cleanNum(r['impr.'] || r['impressions']);
      const clicks = cleanNum(r['clicks']);
      const cost = cleanNum(r['cost']);
      const conv = cleanNum(r['conversions']);
      const ctr = cleanNum(r['ctr']);
      const cpc = cleanNum(r['avg. cpc'] || r['avg cpc']);

      totalImpr += impr;
      totalClicks += clicks;
      totalCost += cost;
      totalConv += conv;

      if (day) {
        byDate.push({ day, impr, clicks, cost, conv, ctr, cpc });
        const month = day.slice(0, 7);
        if (!byDay[month]) byDay[month] = { impr: 0, clicks: 0, cost: 0, conv: 0 };
        byDay[month].impr += impr;
        byDay[month].clicks += clicks;
        byDay[month].cost += cost;
        byDay[month].conv += conv;
      }
    });

    const avgCTR = totalImpr > 0 ? ((totalClicks / totalImpr) * 100).toFixed(2) : 0;
    const avgCPC = totalClicks > 0 ? (totalCost / totalClicks).toFixed(2) : 0;
    const costPerConv = totalConv > 0 ? (totalCost / totalConv).toFixed(2) : 0;

    cache.googleAds = {
      data: {
        summary: {
          totalImpressions: Math.round(totalImpr),
          totalClicks: Math.round(totalClicks),
          totalCost: parseFloat(totalCost.toFixed(2)),
          totalConversions: parseFloat(totalConv.toFixed(1)),
          avgCTR: parseFloat(avgCTR),
          avgCPC: parseFloat(avgCPC),
          costPerConversion: parseFloat(costPerConv),
        },
        byMonth: byDay,
        daily: byDate.slice(-30),
      },
      lastUpdated: new Date().toISOString(),
    };
    console.log(`Google Ads: ${rows.length} rows, $${totalCost.toFixed(2)} spend`);
  } catch (e) { console.error('Google Ads error:', e.message); }
}

// ─── GA4 CSV ──────────────────────────────────────────────────────────────────
async function refreshGA4() {
  if (!GA4_CSV_URL) { console.warn('GA4_CSV_URL not set'); return; }
  try {
    console.log('Refreshing GA4...');
    const res = await axios.get(GA4_CSV_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = parseCSV(res.data);

    let totalSessions = 0, totalUsers = 0, totalNewUsers = 0, totalEvents = 0;
    const byCountry = {}, byMedium = {}, byDay = {};

    rows.forEach(r => {
      const sessions = cleanNum(r['sessions']);
      const users = cleanNum(r['total users'] || r['users']);
      const newUsers = cleanNum(r['new users']);
      const events = cleanNum(r['event count']);
      const country = r['country'] || 'Unknown';
      const medium = r['session medium'] || r['medium'] || 'Unknown';
      const day = r['day'] || r['date'] || '';

      totalSessions += sessions;
      totalUsers += users;
      totalNewUsers += newUsers;
      totalEvents += events;

      byCountry[country] = (byCountry[country] || 0) + sessions;
      byMedium[medium] = (byMedium[medium] || 0) + sessions;

      if (day) {
        const month = day.slice(0, 7);
        if (!byDay[month]) byDay[month] = { sessions: 0, users: 0 };
        byDay[month].sessions += sessions;
        byDay[month].users += users;
      }
    });

    const bounceRate = rows.length > 0 ? (rows.reduce((s, r) => s + cleanNum(r['bounce rate']), 0) / rows.length).toFixed(1) : 0;

    cache.ga4 = {
      data: {
        summary: {
          totalSessions: Math.round(totalSessions),
          totalUsers: Math.round(totalUsers),
          totalNewUsers: Math.round(totalNewUsers),
          totalEvents: Math.round(totalEvents),
          avgBounceRate: parseFloat(bounceRate),
        },
        byCountry: Object.fromEntries(Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,15)),
        byMedium: Object.fromEntries(Object.entries(byMedium).sort((a,b)=>b[1]-a[1]).slice(0,10)),
        byMonth: byDay,
      },
      lastUpdated: new Date().toISOString(),
    };
    console.log(`GA4: ${rows.length} rows, ${Math.round(totalSessions)} sessions`);
  } catch (e) { console.error('GA4 error:', e.message); }
}

async function refreshAll() {
  await Promise.all([refreshHubspot(), refreshGoogleAds(), refreshGA4()]);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() }));

app.get('/api/status', (req, res) => res.json({
  hubspot: { contacts: cache.hubspot.contacts?.length || 0, lastUpdated: cache.hubspot.lastUpdated },
  googleAds: { rows: cache.googleAds.data?.daily?.length || 0, lastUpdated: cache.googleAds.lastUpdated },
  ga4: { rows: Object.keys(cache.ga4.data?.byMonth || {}).length, lastUpdated: cache.ga4.lastUpdated },
}));

// HubSpot contacts summary
app.get('/api/hubspot/contacts', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspot();
    const contacts = cache.hubspot.contacts;
    const total = contacts.length;
    const byCountry = {}, byCampaign = {}, byMonth = {}, byStatus = {}, byClientStatus = {};
    let totalFTD = 0, totalDeposit = 0, totalPnl = 0, withDeposit = 0, kycApproved = 0;

    contacts.forEach(c => {
      const p = c.properties;
      const country = p[PROPS.country] || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
      const campaign = p[PROPS.campaign] || 'Direct/Unknown';
      byCampaign[campaign] = (byCampaign[campaign] || 0) + 1;
      if (p.createdate) { const m = p.createdate.slice(0,7); byMonth[m] = (byMonth[m]||0)+1; }
      const doc = p[PROPS.documentation] || p[PROPS.docStatus] || 'Unknown';
      byStatus[doc] = (byStatus[doc]||0)+1;
      if (doc === 'Approved') kycApproved++;
      const cs = p[PROPS.clientStatus] || 'Unknown';
      byClientStatus[cs] = (byClientStatus[cs]||0)+1;
      totalFTD += parseFloat(p[PROPS.ftdUsd])||0;
      totalDeposit += parseFloat(p[PROPS.lifetimeDeposit])||0;
      totalPnl += parseFloat(p[PROPS.lifetimePnl])||0;
      if (p[PROPS.madeDeposit]==='true' || parseFloat(p[PROPS.lifetimeDeposit])>0) withDeposit++;
    });

    res.json({
      total, kycApproved, withDeposit,
      conversionRate: total > 0 ? ((withDeposit/total)*100).toFixed(1) : 0,
      financials: { totalFTD: Math.round(totalFTD), totalDeposit: Math.round(totalDeposit), totalPnl: Math.round(totalPnl) },
      byCountry: Object.fromEntries(Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,15)),
      byCampaign: Object.fromEntries(Object.entries(byCampaign).sort((a,b)=>b[1]-a[1]).slice(0,20)),
      byMonth: Object.fromEntries(Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0]))),
      byStatus, byClientStatus,
      lastUpdated: cache.hubspot.lastUpdated,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HubSpot contacts list
app.get('/api/hubspot/contacts/list', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspot();
    const page = parseInt(req.query.page)||1;
    const limit = parseInt(req.query.limit)||50;
    const search = (req.query.search||'').toLowerCase();
    let contacts = cache.hubspot.contacts;
    if (search) contacts = contacts.filter(c => {
      const p = c.properties;
      return (p.firstname||'').toLowerCase().includes(search) || (p.lastname||'').toLowerCase().includes(search) ||
             (p.email||'').toLowerCase().includes(search) || (p[PROPS.country]||'').toLowerCase().includes(search);
    });
    const total = contacts.length;
    const paginated = contacts.slice((page-1)*limit, page*limit).map(c => ({
      id: c.id,
      name: `${c.properties.firstname||''} ${c.properties.lastname||''}`.trim()||'N/D',
      email: c.properties.email||'—',
      country: c.properties[PROPS.country]||'Unknown',
      campaign: c.properties[PROPS.campaign]||'Direct',
      date: c.properties.createdate?c.properties.createdate.slice(0,10):'—',
      status: c.properties[PROPS.documentation]||c.properties[PROPS.docStatus]||'Unknown',
      clientStatus: c.properties[PROPS.clientStatus]||'—',
      ftd: parseFloat(c.properties[PROPS.ftdUsd])||0,
      deposit: parseFloat(c.properties[PROPS.lifetimeDeposit])||0,
    }));
    res.json({ total, page, limit, contacts: paginated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Google Ads
app.get('/api/google-ads', async (req, res) => {
  try {
    if (!cache.googleAds.data) await refreshGoogleAds();
    if (!cache.googleAds.data) return res.json({ error: 'Google Ads data not available. Set GADS_CSV_URL env variable.' });
    res.json({ ...cache.googleAds.data, lastUpdated: cache.googleAds.lastUpdated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GA4
app.get('/api/ga4', async (req, res) => {
  try {
    if (!cache.ga4.data) await refreshGA4();
    if (!cache.ga4.data) return res.json({ error: 'GA4 data not available. Set GA4_CSV_URL env variable.' });
    res.json({ ...cache.ga4.data, lastUpdated: cache.ga4.lastUpdated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Force refresh all
app.post('/api/refresh', async (req, res) => {
  try {
    await refreshAll();
    res.json({ success: true, timestamp: new Date().toISOString(), contacts: cache.hubspot.contacts?.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scheduled refresh every hour
cron.schedule('0 * * * *', () => { console.log('Scheduled refresh...'); refreshAll(); });

app.listen(PORT, async () => {
  console.log(`OQtima backend running on port ${PORT}`);
  if (HUBSPOT_TOKEN) await refreshAll();
  else console.warn('HUBSPOT_TOKEN not set');
});
