# Telegram Mini-App (Render)

This repo contains a Telegram Bot with an integrated WebApp for trial booking.

## Structure
- `index.js` — Express server and Telegram Bot logic.
- `public/index.html` — WebApp form.
- `package.json` — dependencies and start script.
- `.env.example` — environment variables template.

## Setup
1. Clone repo and `cd tg-miniapp`.
2. Copy `.env.example` to `.env` and fill in:
   ```dotenv
   BOT_TOKEN=...
   ADMIN_CHAT_ID=...
   WEBAPP_URL=https://<your-service>.onrender.com
   PORT=3000
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Deploy on Render:
   - New → Web Service → connect repo.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Add env vars in Render dashboard.
5. Once live, set `WEBAPP_URL` in BotFather or code.

## Usage
- Send `/start` in Telegram.
- Click the WebApp button.
- Fill form and submit.
- Admin receives booking notification.
