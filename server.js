require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Cache (in-memory, refreshed every morning) ───────────────────────────────
let cache = {
  hubspot: { contacts: null, deals: null, lastUpdated: null },
};

// ─── HUBSPOT ──────────────────────────────────────────────────────────────────
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_BASE = 'https://api.hubapi.com';

async function fetchHubspotContacts() {
  try {
    let allContacts = [];
    let after = undefined;

    // Paginate through all contacts
    do {
      const params = {
        limit: 100,
        properties: [
          'firstname', 'lastname', 'email', 'phone',
          'createdate', 'hs_lead_status',
          'portal___country', 'portal___source_marketing_campaign',
          'portal___documentation'
        ].join(','),
      };
      if (after) params.after = after;

      const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        params,
      });

      allContacts = allContacts.concat(res.data.results);
      after = res.data.paging?.next?.after;
    } while (after);

    return allContacts;
  } catch (err) {
    console.error('HubSpot contacts error:', err.response?.data || err.message);
    return [];
  }
}

async function fetchHubspotDeals() {
  try {
    let allDeals = [];
    let after = undefined;

    do {
      const params = {
        limit: 100,
        properties: ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'pipeline'].join(','),
      };
      if (after) params.after = after;

      const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        params,
      });

      allDeals = allDeals.concat(res.data.results);
      after = res.data.paging?.next?.after;
    } while (after);

    return allDeals;
  } catch (err) {
    console.error('HubSpot deals error:', err.response?.data || err.message);
    return [];
  }
}

async function refreshHubspotCache() {
  console.log('Refreshing HubSpot cache...');
  const [contacts, deals] = await Promise.all([
    fetchHubspotContacts(),
    fetchHubspotDeals(),
  ]);
  cache.hubspot = { contacts, deals, lastUpdated: new Date().toISOString() };
  console.log(`HubSpot cache updated: ${contacts.length} contacts, ${deals.length} deals`);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// HubSpot — contacts summary
app.get('/api/hubspot/contacts', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspotCache();

    const contacts = cache.hubspot.contacts;
    const total = contacts.length;

    // Country distribution
    const byCountry = {};
    const byCampaign = {};
    const byMonth = {};
    const byStatus = {};

    contacts.forEach(c => {
      const p = c.properties;

      // Country
      const country = p.portal___country || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;

      // Campaign
      const campaign = p.portal___source_marketing_campaign || 'Direct/Unknown';
      byCampaign[campaign] = (byCampaign[campaign] || 0) + 1;

      // Monthly trend
      if (p.createdate) {
        const month = p.createdate.slice(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }

      // Documentation status
      const status = p.portal___documentation || 'Unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
    });

    // Sort
    const sortedCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sortedCampaigns = Object.entries(byCampaign).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const sortedMonths = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));

    res.json({
      total,
      byCountry: Object.fromEntries(sortedCountries),
      byCampaign: Object.fromEntries(sortedCampaigns),
      byMonth: Object.fromEntries(sortedMonths),
      byStatus,
      lastUpdated: cache.hubspot.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HubSpot — contacts list (paginated)
app.get('/api/hubspot/contacts/list', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspotCache();

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = (req.query.search || '').toLowerCase();

    let contacts = cache.hubspot.contacts;

    if (search) {
      contacts = contacts.filter(c => {
        const p = c.properties;
        return (
          (p.firstname || '').toLowerCase().includes(search) ||
          (p.lastname || '').toLowerCase().includes(search) ||
          (p.email || '').toLowerCase().includes(search) ||
          (p.portal___country || '').toLowerCase().includes(search) ||
          (p.portal___source_marketing_campaign || '').toLowerCase().includes(search)
        );
      });
    }

    const total = contacts.length;
    const paginated = contacts.slice((page - 1) * limit, page * limit).map(c => ({
      id: c.id,
      name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim(),
      email: c.properties.email || '—',
      country: c.properties.portal___country || 'Unknown',
      campaign: c.properties.portal___source_marketing_campaign || 'Direct',
      date: c.properties.createdate ? c.properties.createdate.slice(0, 10) : '—',
      status: c.properties.portal___documentation || 'Unknown',
    }));

    res.json({ total, page, limit, contacts: paginated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HubSpot — deals summary
app.get('/api/hubspot/deals', async (req, res) => {
  try {
    if (!cache.hubspot.deals) await refreshHubspotCache();

    const deals = cache.hubspot.deals;
    const total = deals.length;
    const totalValue = deals.reduce((sum, d) => sum + (parseFloat(d.properties.amount) || 0), 0);

    const byStage = {};
    deals.forEach(d => {
      const stage = d.properties.dealstage || 'unknown';
      byStage[stage] = (byStage[stage] || 0) + 1;
    });

    res.json({
      total,
      totalValue: Math.round(totalValue),
      byStage,
      lastUpdated: cache.hubspot.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force cache refresh
app.post('/api/refresh', async (req, res) => {
  try {
    await refreshHubspotCache();
    res.json({ success: true, message: 'Cache refreshed', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cache status
app.get('/api/status', (req, res) => {
  res.json({
    hubspot: {
      contacts: cache.hubspot.contacts?.length || 0,
      deals: cache.hubspot.deals?.length || 0,
      lastUpdated: cache.hubspot.lastUpdated,
    },
  });
});

// ─── SCHEDULED REFRESH — every day at 6am ────────────────────────────────────
cron.schedule('0 6 * * *', () => {
  console.log('Running scheduled cache refresh...');
  refreshHubspotCache();
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`OQtima backend running on port ${PORT}`);
  // Load cache on startup
  if (HUBSPOT_TOKEN) {
    await refreshHubspotCache();
  } else {
    console.warn('HUBSPOT_TOKEN not set — skipping initial cache load');
  }
});
