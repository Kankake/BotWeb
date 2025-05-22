require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL || '';

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("Missing BOT_TOKEN or ADMIN_CHAT_ID in environment");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Bot: /start with WebApp button
bot.start((ctx) => {
  ctx.reply(
    'Добро пожаловать! Чтобы записаться на пробное занятие, нажмите кнопку.',
    Markup.inlineKeyboard([
      Markup.button.webApp('🖥 Записаться на пробное', WEBAPP_URL)
    ])
  );
});

// Endpoint to receive data from WebApp
app.post('/submit', async (req, res) => {
  const { telegram_id, name, phone, goal, direction } = req.body;
  if (!telegram_id || !name || !phone) {
    return res.status(400).json({ ok: false, error: 'Missing fields' });
  }
  const text = `Новая заявка:
Имя: ${name}
Телефон: ${phone}
Цель: ${goal}
Направление: ${direction}
ID пользователя: ${telegram_id}`;
  await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);
  res.json({ ok: true });
});

// Launch bot
bot.launch().then(() => console.log('Bot started'));

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});