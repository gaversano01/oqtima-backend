# OQtima Marketing Dashboard — Backend

Node.js backend that connects to HubSpot (and later Google Ads, GA4, Microsoft Ads) and serves data to the OQtima dashboard.

## Deploy on Render

1. Push this repo to GitHub
2. Go to render.com → New → Web Service
3. Connect this GitHub repo
4. Set these values:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment**: Node
5. Add environment variables (see below)
6. Click Deploy

## Environment Variables (add in Render → Environment tab)

| Variable | Where to find it |
|---|---|
| `HUBSPOT_TOKEN` | HubSpot → Settings → Private Apps → your app → Access Token |

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/status` | Cache status |
| `GET /api/hubspot/contacts` | KYC summary (totals, by country, by campaign, by month) |
| `GET /api/hubspot/contacts/list` | Paginated contacts list (supports ?search=&page=&limit=) |
| `GET /api/hubspot/deals` | Deals summary |
| `POST /api/refresh` | Force data refresh |

## Data refresh

Cache refreshes automatically every day at 6am. Force a refresh anytime via `POST /api/refresh`.
