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
  hubspot: { contacts: null, deals: null, lastUpdated: null },
};

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_BASE = 'https://api.hubapi.com';

// Exact property names confirmed from your HubSpot account
const PROPS = {
  country: 'portal___country',
  campaign: 'portal___source_marketing_campaign',
  documentation: 'portal___documentation',
  docStatus: 'portal___documentation_status',
  clientStatus: 'portal___client_status',
  accountType: 'portal___account_type',
  ftdUsd: 'portal___ftd_usd',
  ftdTime: 'portal___ftd_time',
  lifetimeDeposit: 'portal___lifetime_gross_deposit_usd',
  lifetimeNet: 'portal___lifetime_net_deposit_usd',
  lifetimePnl: 'portal___lifetime_pnl_usd',
  lifetimeWithdraw: 'portal___lifetime_withdraw_usd',
  madeDeposit: 'portal___made_a_deposit_',
  openTrades: 'portal___open_trades',
  openTradesAmount: 'portal___open_trades_amount',
  closedTrades: 'portal___closed_trades',
  closedTradeAmount: 'portal___closed_trade_amount',
  l30dDeposit: 'portal___l30d_deposit_usd',
  l60dDeposit: 'portal___l60d_deposit_usd',
  l90dDeposit: 'portal___l90d_deposit_usd',
  liveAccountDate: 'portal___live_account_created_date',
  userType: 'portal___user_type',
  registrationEntry: 'portal___registration_entry',
  salesCode: 'portal___sales_code',
  ltd: 'portal___ltd',
};

async function fetchHubspotContacts() {
  try {
    let allContacts = [];
    let after = undefined;

    do {
      const params = {
        limit: 100,
        properties: [
          'firstname', 'lastname', 'email', 'phone', 'createdate',
          PROPS.country, PROPS.campaign, PROPS.documentation, PROPS.docStatus,
          PROPS.clientStatus, PROPS.accountType, PROPS.ftdUsd, PROPS.ftdTime,
          PROPS.lifetimeDeposit, PROPS.lifetimeNet, PROPS.lifetimePnl,
          PROPS.madeDeposit, PROPS.openTrades, PROPS.closedTrades,
          PROPS.l30dDeposit, PROPS.liveAccountDate, PROPS.userType,
          PROPS.registrationEntry, PROPS.salesCode, PROPS.ltd,
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
  cache.hubspot = { contacts, deals, lastUpdated: new Date().toISOString() };
  console.log(`HubSpot cache updated: ${contacts.length} contacts, ${deals.length} deals`);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// Full KYC + marketing summary
app.get('/api/hubspot/contacts', async (req, res) => {
  try {
    if (!cache.hubspot.contacts) await refreshHubspotCache();
    const contacts = cache.hubspot.contacts;
    const total = contacts.length;

    const byCountry = {}, byCampaign = {}, byMonth = {}, byStatus = {},
          byClientStatus = {}, byUserType = {}, byAccountType = {};
    let totalFTD = 0, totalDeposit = 0, totalPnl = 0;
    let withDeposit = 0, kycApproved = 0;

    contacts.forEach(c => {
      const p = c.properties;

      // Country
      const country = p[PROPS.country] || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;

      // Campaign
      const campaign = p[PROPS.campaign] || 'Direct/Unknown';
      byCampaign[campaign] = (byCampaign[campaign] || 0) + 1;

      // Monthly
      if (p.createdate) {
        const month = p.createdate.slice(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }

      // KYC / doc status
      const doc = p[PROPS.documentation] || p[PROPS.docStatus] || 'Unknown';
      byStatus[doc] = (byStatus[doc] || 0) + 1;
      if (doc === 'Approved') kycApproved++;

      // Client status
      const cs = p[PROPS.clientStatus] || 'Unknown';
      byClientStatus[cs] = (byClientStatus[cs] || 0) + 1;

      // User type
      const ut = p[PROPS.userType] || 'Unknown';
      byUserType[ut] = (byUserType[ut] || 0) + 1;

      // Account type
      const at = p[PROPS.accountType] || 'Unknown';
      byAccountType[at] = (byAccountType[at] || 0) + 1;

      // Financials
      const ftd = parseFloat(p[PROPS.ftdUsd]) || 0;
      const deposit = parseFloat(p[PROPS.lifetimeDeposit]) || 0;
      const pnl = parseFloat(p[PROPS.lifetimePnl]) || 0;
      totalFTD += ftd;
      totalDeposit += deposit;
      totalPnl += pnl;
      if (p[PROPS.madeDeposit] === 'true' || deposit > 0) withDeposit++;
    });

    res.json({
      total,
      kycApproved,
      withDeposit,
      conversionRate: total > 0 ? ((withDeposit / total) * 100).toFixed(1) : 0,
      financials: {
        totalFTD: Math.round(totalFTD),
        totalDeposit: Math.round(totalDeposit),
        totalPnl: Math.round(totalPnl),
      },
      byCountry: Object.fromEntries(Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,15)),
      byCampaign: Object.fromEntries(Object.entries(byCampaign).sort((a,b)=>b[1]-a[1]).slice(0,20)),
      byMonth: Object.fromEntries(Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0]))),
      byStatus,
      byClientStatus,
      byUserType,
      byAccountType,
      lastUpdated: cache.hubspot.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contacts list (paginated + searchable)
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
        return (p.firstname||'').toLowerCase().includes(search) ||
               (p.lastname||'').toLowerCase().includes(search) ||
               (p.email||'').toLowerCase().includes(search) ||
               (p[PROPS.country]||'').toLowerCase().includes(search) ||
               (p[PROPS.campaign]||'').toLowerCase().includes(search);
      });
    }

    const total = contacts.length;
    const paginated = contacts.slice((page-1)*limit, page*limit).map(c => ({
      id: c.id,
      name: `${c.properties.firstname||''} ${c.properties.lastname||''}`.trim() || 'N/D',
      email: c.properties.email || '—',
      country: c.properties[PROPS.country] || 'Unknown',
      campaign: c.properties[PROPS.campaign] || 'Direct',
      date: c.properties.createdate ? c.properties.createdate.slice(0,10) : '—',
      status: c.properties[PROPS.documentation] || c.properties[PROPS.docStatus] || 'Unknown',
      clientStatus: c.properties[PROPS.clientStatus] || '—',
      ftd: parseFloat(c.properties[PROPS.ftdUsd]) || 0,
      deposit: parseFloat(c.properties[PROPS.lifetimeDeposit]) || 0,
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
    const totalValue = deals.reduce((sum,d) => sum + (parseFloat(d.properties.amount)||0), 0);
    const byStage = {};
    deals.forEach(d => { const s = d.properties.dealstage||'unknown'; byStage[s]=(byStage[s]||0)+1; });
    res.json({ total: deals.length, totalValue: Math.round(totalValue), byStage, lastUpdated: cache.hubspot.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force refresh
app.post('/api/refresh', async (req, res) => {
  try {
    await refreshHubspotCache();
    res.json({ success: true, contacts: cache.hubspot.contacts?.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status
app.get('/api/status', (req, res) => {
  res.json({ hubspot: { contacts: cache.hubspot.contacts?.length||0, deals: cache.hubspot.deals?.length||0, lastUpdated: cache.hubspot.lastUpdated } });
});

// Scheduled daily refresh at 6am
cron.schedule('0 6 * * *', () => { refreshHubspotCache(); });

app.listen(PORT, async () => {
  console.log(`OQtima backend running on port ${PORT}`);
  if (HUBSPOT_TOKEN) await refreshHubspotCache();
  else console.warn('HUBSPOT_TOKEN not set');
});
