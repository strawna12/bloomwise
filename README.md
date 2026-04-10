# BloomWise — Deployment Guide

## How it works

Everything runs from one Railway deployment:

```
Railway
 ├── server.js      → serves index.html to users
 ├── index.html     → the full BloomWise app
 └── API routes     → /recommendations, /lookup, /claude
```

Users visit your Railway URL and get the full app.
The API key lives safely on the server — users never see it.

---

## Project folder structure

Make sure your folder looks like this before deploying:

```
bloomwise/
 ├── server.js            ← the server (serves frontend + API)
 ├── index.html           ← the BloomWise frontend
 ├── package.json         ← tells Railway how to start the app
 ├── supabase-setup.sql   ← run once in Supabase dashboard
 └── README.md
```

---

## Step 1 — Set up Supabase (free, for garden saving)

1. Go to https://supabase.com → New project → name it `bloomwise`
2. Once created, go to **SQL Editor** → paste the contents of `supabase-setup.sql` → click **Run**
3. Go to **Settings → API** and copy:
   - **Project URL** — looks like `https://abcxyz.supabase.co`
   - **anon / public key** — long JWT string
4. Open `index.html` and find these two lines and replace with your values:
   ```js
   const SUPABASE_URL  = 'https://your-project.supabase.co';
   const SUPABASE_ANON = 'your-anon-public-key-here';
   ```

---

## Step 2 — Deploy to Railway

### a) Get your Anthropic API key
1. Go to https://console.anthropic.com
2. **API Keys** → **Create Key** → copy it
3. Add credits ($5–10 is plenty to start)

### b) Push to GitHub
```bash
# From your bloomwise/ folder
git init
git add .
git commit -m "BloomWise initial deploy"
git branch -M main
git remote add origin https://github.com/yourusername/bloomwise.git
git push -u origin main
```

### c) Deploy on Railway
1. Go to https://railway.app → sign up free
2. **New Project** → **Deploy from GitHub repo** → select your repo
3. Railway detects Node.js automatically and runs `npm start`
4. Go to your project → **Variables** → add:
   ```
   ANTHROPIC_API_KEY = sk-ant-your-key-here
   ```
5. Optionally set the model (defaults to Haiku):
   ```
   MODEL = claude-haiku-4-5-20251001
   ```
6. Go to **Settings → Networking → Generate Domain**
   — you get a free URL like `bloomwise.up.railway.app`

### d) Test it
Open your Railway URL in a browser — BloomWise should load immediately.
Check `/health` to confirm the API is running:
```
https://your-app.up.railway.app/health
→ {"status":"ok","model":"claude-haiku-4-5-20251001"}
```

---

## Running locally

```bash
# Install nothing — pure Node.js, no dependencies
ANTHROPIC_API_KEY=sk-ant-your-key-here node server.js

# Open your browser to:
http://localhost:3000
```

The server startup message tells you if the API key is configured correctly.

---

## Custom domain (optional)

1. Buy a domain at Namecheap or Google Domains (~$12/year)
   — `bloomwise.app` or `getbloomwise.com` would be perfect
2. In Railway: **Settings → Networking → Custom Domain**
3. Add your domain and follow the DNS instructions
4. Takes about 10 minutes to go live

---

## Choosing a model

Set the `MODEL` environment variable in Railway:

| Model                      | Quality | Cost per 1,000 users |
|----------------------------|---------|----------------------|
| claude-haiku-4-5-20251001  | Good    | ~$0.80               |
| claude-sonnet-4-6          | Great   | ~$8.00               |
| claude-opus-4-6            | Best    | ~$24.00              |

Start with Haiku. Switch to Sonnet when you launch publicly.

---

## Rate limiting

Default: 20 requests per IP per minute.
To change, edit `server.js`:
```js
const MAX_REQUESTS = 20;       // requests allowed
const WINDOW_MS    = 60_000;   // per minute
```

---

## Before launch checklist

- [ ] Supabase table created (run supabase-setup.sql)
- [ ] SUPABASE_URL and SUPABASE_ANON set in index.html
- [ ] Deployed to Railway and /health returns OK
- [ ] Custom domain connected (optional but recommended)
- [ ] Tested on iPhone Safari and Android Chrome
- [ ] Tested garden save/load across browser sessions
- [ ] Privacy policy page created (required for future app store submission)
- [ ] Terms of service page created
