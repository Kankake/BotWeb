import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import { Telegraf, Markup } from 'telegraf';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// Load config from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/tg-webhook';

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Load monthly-updatable schedule from JSON file
let schedules = {};
try {
  const dataPath = path.join(__dirname, 'data', 'schedules.json');
  const data = await fs.readFile(dataPath, 'utf8');
  schedules = JSON.parse(data);
  console.log('✅ Loaded schedules from data/schedules.json');
} catch (err) {
  console.error('❌ Failed to load schedules.json:', err);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Set up menu commands
try {
  const publicCommands = [
    { command: 'start', description: 'Начать заново' },
    { command: 'contacts', description: 'Контакты студии' }
  ];
  await bot.telegram.setMyCommands(publicCommands);
  const adminCommands = [
    ...publicCommands,
    { command: 'update_schedule', description: 'Обновить расписание (админ)' }
  ];
  await bot.telegram.setMyCommands(adminCommands, {
    scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) }
  });
  await bot.telegram.setChatMenuButton('default', { type: 'commands' });
} catch (err) {
  console.error('Не удалось установить команды меню:', err);
}

// Update schedule function
async function updateScheduleFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);
  
  const schedules = {};
  
  data.forEach(row => {
    if (!schedules[row.address]) {
      schedules[row.address] = [];
    }
    
    schedules[row.address].push({
      direction: row.direction,
      date: row.date,
      time: row.time,
      address: row.address
    });
  });

  await fs.writeFile(
    path.join(__dirname, 'data', 'schedules.json'),
    JSON.stringify(schedules, null, 2)
  );
  
  return schedules;
}

// Bot Handlers
bot.start(ctx => {
  ctx.reply(
    'Выберите действие:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ]).resize()
  );
});

bot.command('contacts', ctx => {
  ctx.reply(
    `Связь с ресепшн студии:
  Свободы 6 — 8-928-00-00-000
  Видова 210Д — 8-928-00-00-000
  Дзержинского 211/2 — 8-928-00-00-000`
  );
});

bot.command('update_schedule', async (ctx) => {
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) {
    return;
  }
  ctx.reply('Отправьте Excel файл с расписанием');
});

bot.on('document', async (ctx) => {
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) {
    return;
  }

  try {
    const file = await ctx.telegram.getFile(ctx.message.document.file_id);
    const filePath = path.join(__dirname, 'temp.xlsx');
    
    await ctx.telegram.downloadFile(file.file_id, filePath);
    schedules = await updateScheduleFromExcel(filePath);
    
    await fs.unlink(filePath);
    
    ctx.reply('✅ Расписание успешно обновлено!');
  } catch (error) {
    ctx.reply('❌ Ошибка при обновлении расписания: ' + error.message);
  }
});

bot.hears('Контакты', ctx => {
  ctx.reply(
    `Связь с ресепшн студии:
    Свободы 6 — 8-928-00-00-000
    Видова 210Д — 8-928-00-00-000
    Дзержинского 211/2 — 8-928-00-00-000`
  );
});

bot.hears('📞 Запись по звонку администратора', ctx => {
  ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([
      [Markup.button.contactRequest('📲 Отправить контакт')]
    ]).resize()
  );
});

bot.on('contact', async ctx => {
  const { first_name, phone_number } = ctx.message.contact;
  const telegram_id = ctx.from.id;
  
  // Get stored booking data
  const bookingData = pendingBookings.get(telegram_id);
  
  if (bookingData) {
    // This is a form submission - send complete booking data
    const msg = `Новая подтвержденная заявка:
      Цель: ${bookingData.goal}
      Направление: ${bookingData.direction}
      Студия: ${bookingData.address}
      Слот: ${bookingData.slot || 'не указан'}
      Имя: ${first_name}
      Телефон: ${phone_number}
      ID: ${telegram_id}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
    pendingBookings.delete(telegram_id);
  } else {
    // This is a callback request
    const msg = `Новая заявка на обратный звонок:
      Имя: ${first_name}
      Телефон: ${phone_number}
      ID: ${telegram_id}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
  }
  
  await ctx.reply('Спасибо! Мы перезвоним вам в ближайшее время.', Markup.removeKeyboard());
});

// Add temporary storage for bookings
const pendingBookings = new Map();

bot.hears('🖥️ Запись онлайн', ctx => {
  ctx.reply(
    'Заполните онлайн-форму:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Перейти к форме', WEBAPP_URL)
    ])
  );
});

// Express App
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoints
app.post('/slots', (req, res) => {
  const { direction, address } = req.body;
  const today = new Date();
  console.log('REQUEST direction:', direction, '| address:', address);
  const arr = schedules[address] || [];
  console.log('SLOTS directions:', arr.map(s => '[' + s.direction + ']'));
  const slots = arr
    .filter(slot => {
      const d = new Date(slot.date);
      const diff = (d - today) / (1000 * 60 * 60 * 24);
      const match = slot.direction.trim() === direction.trim();
      if (match && diff >= 0 && diff < 3) {
        console.log('MATCH:', slot.direction, '|', direction, '|', slot.date, slot.time);
      }
      return match && diff >= 0 && diff < 3;
    })
    .map(slot => ({ date: slot.date, time: slot.time }));
  res.json({ ok: true, slots });
});

app.get('/json', async (_req, res) => {
  try {
    const filePath = path.join(__dirname, 'public', 'data', 'schedules.json');
    const data = await fs.readFile(filePath, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).send('Ошибка чтения или парсинга файла');
  }
});

app.post('/submit', async (req, res) => {
  try {
    const bookingData = req.body;
    // Store booking data
    pendingBookings.set(bookingData.telegram_id, bookingData);
    
    await bot.telegram.sendMessage(
      bookingData.telegram_id,
      'Спасибо! Для подтверждения, пожалуйста, поделитесь контактом.',
      {
        reply_markup: {
          keyboard: [[{ text: '📲 Подтвердить запись', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /submit:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function sendBookingToAdmin(bookingData) {
  const { goal, direction, address, name, phone, slot, telegram_id } = bookingData;
  
  const msg = `Новая онлайн-заявка:
    Цель: ${goal}
    Направление: ${direction}
    Студия: ${address}
    Слот: ${slot || 'не указан'}
    Имя: ${name}
    Телефон: ${phone}
    ID: ${telegram_id}`;
    
  return await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
}

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
