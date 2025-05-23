require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');

// Load config from .env
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL    = process.env.WEBAPP_URL;  // e.g. https://your-domain.com
const PORT          = process.env.PORT || 3000;
const WEBHOOK_PATH  = '/tg-webhook';

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Load monthly-updatable schedule from JSON file
let schedules = {};
try {
  const dataPath = path.join(__dirname, 'data', 'schedules.json');
  schedules = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  console.log('✅ Loaded schedules from data/schedules.json');
} catch (err) {
  console.error('❌ Failed to load schedules.json:', err);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// === Bot Handlers ===
bot.start(ctx => {
  ctx.reply(
    'Выберите способ записи:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора']
    ]).resize()
  );
});

bot.hears('📞 Запись по звонку администратора', ctx => {
  ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([[ Markup.button.contactRequest('📲 Отправить контакт') ]])
      .resize().oneTime()
  );
});

bot.on('contact', async ctx => {
  const { first_name, phone_number } = ctx.message.contact;
  await bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `Новая заявка по звонку:\nИмя: ${first_name}\nТелефон: ${phone_number}`
  );
  await ctx.reply('Спасибо! Мы перезвоним вам в ближайшее время.', Markup.removeKeyboard());
});

bot.hears('🖥️ Запись онлайн', ctx => {
  ctx.reply(
    'Заполните онлайн-форму:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Перейти к форме', WEBAPP_URL)
    ])
  );
});

// === Express App ===
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint to retrieve slots
app.post('/slots', (req, res) => {
  const { direction, address } = req.body;
  const today = new Date();
  console.log('REQUEST direction:', direction, '| address:', address);
  const arr = schedules[address] || [];
  console.log('SLOTS directions:', arr.map(s => '[' + s.direction + ']'));
  const slots = arr.filter(slot => {
    const d = new Date(slot.date);
    const diff = (d - today) / (1000 * 60 * 60 * 24);
    // Логируем результат сравнения
    const match = slot.direction.trim() === direction.trim();
    if (match && diff >= 0 && diff < 3) {
      console.log('MATCH:', slot.direction, '|', direction, '|', slot.date, slot.time);
    }
    return match && diff >= 0 && diff < 3;
  })
  .map(slot => ({ date: slot.date, time: slot.time }));
  res.json({ ok: true, slots });
});

const fs = require('fs');
const path = require('path');

app.get('/json', (_req, res) => {
  const filePath = path.join(__dirname, 'public', 'data', 'schedules.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      res.status(500).send('Ошибка чтения файла');
      return;
    }
    try {
      const jsonData = JSON.parse(data);
      res.json(jsonData);
    } catch (parseErr) {
      res.status(500).send('Ошибка парсинга JSON');
    }
  });
});

// WebApp form submission endpoint
app.post('/submit', async (req, res) => {
  try {
    const { telegram_id, goal, direction, address, name, phone, slot } = req.body;
    const msg = `Новая онлайн-заявка:\nЦель: ${goal}\nНаправление: ${direction}\nСтудия: ${address}\nСлот: ${slot || 'не указан'}\nИмя: ${name}\nТелефон: ${phone}\nID: ${telegram_id}`;
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
    await bot.telegram.sendMessage(
      telegram_id,
      'Спасибо! Для подтверждения, пожалуйста, поделитесь контактом.',
      Markup.keyboard([[ Markup.button.contactRequest('📲 Отправить контакт') ]])
        .resize().oneTime()
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /submit:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Telegram webhook callback
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Start server and set webhook
app.listen(PORT, async () => {
  console.log(`🌐 Server listening on port ${PORT}`);
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Old webhook deleted');
    await bot.telegram.setWebhook(`${WEBAPP_URL}${WEBHOOK_PATH}`);
    console.log(`✅ Webhook set to ${WEBAPP_URL}${WEBHOOK_PATH}`);
  } catch (e) {
    console.error('❌ Failed to set webhook:', e);
    process.exit(1);
  }
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
