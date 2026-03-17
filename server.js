require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let cache = {
  hubspot: { contacts: null, deals: null, propNames: null, lastUpdated: null },
};

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_BASE = 'https://api.hubapi.com';

async function getHubspotProperties() {
  try {
    const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/properties/contacts`, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    const names = res.data.results.map(p => p.name);
    const portalProps = names.filter(n => n.includes('portal') || n.includes('country') || n.includes('campaign') || n.includes('doc'));
    console.log('Portal-related properties found:', portalProps);
    return names;
  } catch (err) {
    console.error('Could not fetch properties:', err.response?.data || err.message);
    return [];
  }
}

async function fetchHubspotContacts() {
  try {
    const allProps = await getHubspotProperties();

    // Find the right property names dynamically
    const portalCountry = allProps.find(p => p.includes('country')) || 'portal___country';
    const portalCampaign = allProps.find(p => p.includes('source_marketing') || (p.includes('campaign') && p.includes('portal'))) || 'portal___source_marketing_campaign';
    const portalDoc = allProps.find(p => (p.includes('doc') && p.includes('portal')) || p.includes('documentation')) || 'portal___documentation';

    console.log('Using property names:', { portalCountry, portalCampaign, portalDoc });

    let allContacts = [];
    let after = undefined;

    do {
      const params = {
        limit: 100,
        properties: ['firstname','lastname','email','phone','createdate','hs_lead_status','hs_marketing_contact_status', portalCountry, portalCampaign, portalDoc].join(','),
      };
      if (after) params.after = after;

      const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        params,
      });

      allContacts = allContacts.concat(res.data.results);
      after = res.data.paging?.next?.after;
    } while (after);

    cache.hubspot.propNames = { portalCountry, portalCampaign, portalDoc };
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
      const params = { limit: 100, properties: ['dealname','amount','dealstage','closedate','createdate','pipeline'].join(',') };
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
  const [contacts, deals] = await Promise.all([fetchHubspotContacts(), fetchHubspotDeals()]);
  cache.hubspot = { ...cache.hubspot, contacts, deals, lastUpdated: new Date().toISOString() };
  console.log(`HubSpot cache updated: ${contacts.length} contacts, ${deals.length} deals`);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// Debug — see raw first contact properties
app.get('/api/debug/contact', async (req, res) => {
  try {
    const allProps = await getHubspotProperties();
    const portalProps = allProps.filter(n => n.includes('portal') || n.includes('country') || n.includes('campaign'));
    const res2 = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    res.json({ total: res2.data.total, portalProperties: portalProps, sampleContact: res2.data.results?.[0]?.properties });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// HubSpot contacts summary
app.get('/api/hubspot/contacts', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspotCache();
    const contacts = cache.hubspot.contacts;
    const total = contacts.length;
    const props = cache.hubspot.propNames || { portalCountry: 'portal___country', portalCampaign: 'portal___source_marketing_campaign', portalDoc: 'portal___documentation' };

    const byCountry = {}, byCampaign = {}, byMonth = {}, byStatus = {};

    contacts.forEach(c => {
      const p = c.properties;
      const country = p[props.portalCountry] || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
      const campaign = p[props.portalCampaign] || 'Direct/Unknown';
      byCampaign[campaign] = (byCampaign[campaign] || 0) + 1;
      if (p.createdate) {
        const month = p.createdate.slice(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }
      const status = p[props.portalDoc] || 'Unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
    });

    res.json({
      total,
      byCountry: Object.fromEntries(Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,15)),
      byCampaign: Object.fromEntries(Object.entries(byCampaign).sort((a,b)=>b[1]-a[1]).slice(0,20)),
      byMonth: Object.fromEntries(Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0]))),
      byStatus,
      lastUpdated: cache.hubspot.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contacts list
app.get('/api/hubspot/contacts/list', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspotCache();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = (req.query.search || '').toLowerCase();
    const props = cache.hubspot.propNames || { portalCountry: 'portal___country', portalCampaign: 'portal___source_marketing_campaign', portalDoc: 'portal___documentation' };

    let contacts = cache.hubspot.contacts;
    if (search) {
      contacts = contacts.filter(c => {
        const p = c.properties;
        return (p.firstname||'').toLowerCase().includes(search) || (p.lastname||'').toLowerCase().includes(search) || (p.email||'').toLowerCase().includes(search) || (p[props.portalCountry]||'').toLowerCase().includes(search);
      });
    }

    const total = contacts.length;
    const paginated = contacts.slice((page-1)*limit, page*limit).map(c => ({
      id: c.id,
      name: `${c.properties.firstname||''} ${c.properties.lastname||''}`.trim(),
      email: c.properties.email || '—',
      country: c.properties[props.portalCountry] || 'Unknown',
      campaign: c.properties[props.portalCampaign] || 'Direct',
      date: c.properties.createdate ? c.properties.createdate.slice(0,10) : '—',
      status: c.properties[props.portalDoc] || 'Unknown',
    }));

    res.json({ total, page, limit, contacts: paginated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deals
app.get('/api/hubspot/deals', async (req, res) => {
  try {
    if (!cache.hubspot.deals) await refreshHubspotCache();
    const deals = cache.hubspot.deals;
    const totalValue = deals.reduce((sum, d) => sum + (parseFloat(d.properties.amount)||0), 0);
    const byStage = {};
    deals.forEach(d => { const s = d.properties.dealstage||'unknown'; byStage[s]=(byStage[s]||0)+1; });
    res.json({ total: deals.length, totalValue: Math.round(totalValue), byStage, lastUpdated: cache.hubspot.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    await refreshHubspotCache();
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ hubspot: { contacts: cache.hubspot.contacts?.length||0, deals: cache.hubspot.deals?.length||0, lastUpdated: cache.hubspot.lastUpdated } });
});

cron.schedule('0 6 * * *', () => { refreshHubspotCache(); });

app.listen(PORT, async () => {
  console.log(`OQtima backend running on port ${PORT}`);
  if (HUBSPOT_TOKEN) await refreshHubspotCache();
  else console.warn('HUBSPOT_TOKEN not set');
});
