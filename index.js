import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import { Telegraf, Markup } from 'telegraf';
import XLSX from 'xlsx';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WELCOME_PHOTO = path.join(__dirname, 'public', 'assets', 'welcome.jpg');
const NEXT_PHOTO = path.join(__dirname, 'public', 'assets', 'next.jpg');

dotenv.config();

// Load config from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/tg-webhook';

const awaitingScheduleUpload = new Set();
const userCustomNames = new Map(); // Хранилище для кастомных имен пользователей

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Функция проверки на админа
async function isAdminUser(ctx) {
  // Проверяем, отправлено ли сообщение из админской группы
  if (ctx.chat.id.toString() === ADMIN_CHAT_ID) {
    return true;
  }
  return false;
}

// Add after imports
const initDataDir = async () => {
  const dataDir = path.join(__dirname, 'public', 'data');
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
  
  const schedulesPath = path.join(dataDir, 'schedules.json');
  try {
    await fs.access(schedulesPath);
  } catch {
    await fs.writeFile(schedulesPath, '{}');
  }
};

await initDataDir();

// Load monthly-updatable schedule from JSON file
let schedules = {};
try {
  const dataPath = path.join(__dirname, 'public', 'data', 'schedules.json');
  const data = await fs.readFile(dataPath, 'utf8');
  schedules = JSON.parse(data);
  console.log('✅ Loaded schedules from data/schedules.json');
} catch (err) {
  console.error('❌ Failed to load schedules.json:', err);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);
const pendingReminders = new Map();

bot.command('check_data', async (ctx) => {
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) return;
  
  // Split data into smaller chunks
  const data = JSON.stringify(schedules, null, 2);
  const chunkSize = 4000; // Leave some buffer
  
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    await ctx.reply(chunk);
  }
});

// Set up menu commands
try {
  // Команды для обычных пользователей (только команду start)
  const publicCommands = [
    { command: 'start', description: 'Начать заново' },
    { command: 'contacts', description: 'Контакты студии' }
  ];
  await bot.telegram.setMyCommands(publicCommands);

  // Команды для администраторов (только команду update_schedule)
  const adminGroupCommands = [
    { command: 'update_schedule', description: 'Обновить расписание' }
  ];
  await bot.telegram.setMyCommands(adminGroupCommands, {
    scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) }  // Ограничение команд только для админа
  });

} catch (err) {
  console.log('Command menu setup:', err);
}

// Update schedule function
async function updateScheduleFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  const schedules = {};

  data.forEach(row => {
    // Convert Excel date to YYYY-MM-DD format
    let dateValue = row.date;
    if (typeof dateValue === 'number') {
      // If Excel date is stored as number
      dateValue = new Date((dateValue - 25569) * 86400 * 1000);
    } else {
      // If date is string, parse it
      dateValue = new Date(dateValue);
    }
    const formattedDate = dateValue.toISOString().split('T')[0];

    if (!schedules[row.address]) {
      schedules[row.address] = [];
    }

    const orderedEntry = {
      date: formattedDate,
      time: row.time,
      direction: row.direction.trim(), // Add trim() to normalize strings
      address: row.address.trim()
    };

    schedules[row.address].push(orderedEntry);
  });

  // Add console.log to verify data structure
  console.log('Generated schedules:', schedules);

  await fs.writeFile(
    path.join(__dirname, 'public', 'data', 'schedules.json'),
    JSON.stringify(schedules, null, 2)
  );

  return schedules;
}

bot.start(async ctx => {
  const firstName = ctx.from.first_name || 'клиент';
  const chatId = ctx.chat.id;
  // Send welcome photo first
  if (pendingReminders.has(chatId)) {
      const {t3, t15, t24 } = pendingReminders.get(chatId);
      clearTimeout(t3);
      clearTimeout(t15);
      clearTimeout(t24);
    }
  
    const t15 = setTimeout(() => {
    bot.telegram.sendMessage(
      chatId,
      `${firstName}, успейте воспользоваться бесплатным первым занятием в нашей студии 💛.\nВыберите пробное занятие, пока их не разобрали 🙈`,
  Markup.inlineKeyboard([
    Markup.button.webApp('Записаться онлайн', WEBAPP_URL)
  ])
    );
  },15 * 60 * 1000);

  const t3 = setTimeout(() => {
    bot.telegram.sendMessage(
      chatId,
      `👋 Привет, ${firstName}! 🏃‍♀️ Места на бесплатное пробное занятие заканчиваются — успей забронировать своё!`,
      Markup.inlineKeyboard([
    Markup.button.webApp('Записаться онлайн', WEBAPP_URL)
  ])
    );
  }, 3 * 60 * 60 * 1000);

  const t24 = setTimeout(() => {
      bot.telegram.sendMessage(
        chatId, 
        `${firstName}, успейте воспользоваться бесплатным первым занятием в нашей студии 💛.\nВыберите пробное занятие, пока их не разобрали 🙈`,
        Markup.inlineKeyboard([
    Markup.button.webApp('Записаться онлайн', WEBAPP_URL)
  ])
      );
    }, 24 * 60 * 60 * 1000);

  pendingReminders.set(chatId, {t3, t15, t24 });

  await ctx.replyWithPhoto({ source: WELCOME_PHOTO });
  
  
  await ctx.reply(
    `Приветствую, наш будущий клиент!\n` +
    `Я Лея — умный помощник студии балета и растяжки LEVITA!\n\n` +
    `Могу обращаться к вам по имени "${firstName}", которое указано у вас в профиле?`,
    Markup.keyboard([['Да', 'Нет, ввести другое имя']])
      .resize()
      .oneTime()
  );
});

bot.hears('Да', async ctx => {
  await ctx.replyWithPhoto({ source: NEXT_PHOTO });
  
  return ctx.reply(
    'Отлично! Выберите действие:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ])
    .resize()
  );
});

const awaitingCustomName = new Set();

bot.hears('🖥️ Запись онлайн', ctx => {
  ctx.reply(
    'Заполните онлайн-форму:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Перейти к форме', WEBAPP_URL)
    ])
  );
});

bot.hears('📞 Запись по звонку администратора', ctx => {
  return ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([
      ['⬅️ Назад', {text: '📲 Отправить контакт', request_contact: true}]
    ])
    .resize()
  );
});

bot.hears('⬅️ Назад', ctx => {
  return ctx.reply(
    'Выберите действие:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ])
    .resize()
  );
});

bot.hears('Контакты', ctx => {
  ctx.reply(
    `Связь с ресепшн студии:
    Свободы 6 — 8-928-00-00-000
    Видова 210Д — 8-928-00-00-000
    Дзержинского 211/2 — 8-928-00-00-000`
  );
});

bot.hears('Нет, ввести другое имя', async ctx => {
  awaitingCustomName.add(ctx.chat.id);
  await ctx.reply('Пожалуйста, введите, как к вам обращаться:');
});

bot.on('text', async ctx => {
  if (!awaitingCustomName.has(ctx.chat.id)) return;
  
  const customName = ctx.message.text;
  const userId = ctx.from.id;
  
  // Сохраняем кастомное имя пользователя
  userCustomNames.set(userId, customName);
  
  awaitingCustomName.delete(ctx.chat.id);
  
  await ctx.replyWithPhoto({ source: NEXT_PHOTO });
  await ctx.reply(
    `Приятно познакомиться, ${customName}! Выберите действие:`,
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ])
    .resize()
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

bot.command('update_schedule', ctx => {
  if (!isAdminUser(ctx)) return;
  awaitingScheduleUpload.add(ctx.chat.id);
  ctx.reply('Отправьте файл Excel с расписанием');
});

bot.on('document', async ctx => {
  try {
    if (!awaitingScheduleUpload.has(ctx.chat.id)) {
      return ctx.reply('Пожалуйста, сначала выполните команду /update_schedule');
    }
    awaitingScheduleUpload.delete(ctx.chat.id);

    const fileId = ctx.message.document.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = await response.buffer();

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    // Преобразование данных в нужный формат, пример
    const schedule = {};
    data.forEach(row => {
      const day = row.Day;
      const time = row.Time;
      const name = row.Name;
      if (!schedule[day]) schedule[day] = [];
      schedule[day].push({ time, name });
    });

    // Записываем расписание в файл
    const filePath = path.join(__dirname, 'public', 'data', 'schedules.json');
    await fs.writeFile(filePath, JSON.stringify(schedule, null, 2));

    ctx.reply('Расписание успешно обновлено');
  } catch (error) {
    console.error(error);
    ctx.reply('Ошибка при обработке файла расписания');
  }
});

// Add temporary storage for bookings
const pendingBookings = new Map();

bot.on('contact', async ctx => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Clear reminders if exist
  if (pendingReminders.has(chatId)) {
    const {t3, t15, t24 } = pendingReminders.get(chatId);
    clearTimeout(t3);
    clearTimeout(t15);
    clearTimeout(t24);
    pendingReminders.delete(chatId);
  }

  const { first_name, phone_number } = ctx.message.contact;
  
  // Получаем имя: сначала проверяем кастомное, если нет - берем из TG
  const userName = userCustomNames.get(userId) || first_name;
  
  // Форматируем номер телефона с плюсом
  const formattedPhone = phone_number.startsWith('+') ? phone_number : `+${phone_number}`;
  
  // Get stored booking data
  const bookingData = pendingBookings.get(userId);
  
  if (bookingData) {
    // This is a form submission - send complete booking data
    const msg = `Новая подтвержденная заявка:
      Цель: ${bookingData.goal}
      Направление: ${bookingData.direction}
      Студия: ${bookingData.address}
      Слот: ${bookingData.slot || 'не указан'}
      Имя: ${userName}
      Телефон: ${formattedPhone}
      ID: ${userId}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
    pendingBookings.delete(userId);
  } else {
    // This is a callback request
    const msg = `Новая заявка на обратный звонок:
      Имя: ${userName}
      Телефон: ${formattedPhone}
      ID: ${userId}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
  }
  
  await ctx.reply('Спасибо! Мы перезвоним вам в ближайшее время.', Markup.removeKeyboard());
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
  
  // Получаем кастомное имя если есть
  const userName = userCustomNames.get(telegram_id) || name;
  
  // Форматируем телефон с плюсом
  const formattedPhone = phone && !phone.startsWith('+') ? `+${phone}` : phone;
  
  const msg = `Новая онлайн-заявка:
    Цель: ${goal}
    Направление: ${direction}
    Студия: ${address}
    Слот: ${slot || 'не указан'}
    Имя: ${userName}
    Телефон: ${formattedPhone}
    ID: ${telegram_id}`;
    
  return await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
}

// Telegram webhook callback
app.use(bot.webhookCallback(WEBHOOK_PATH));

// At app startup
console.log('🚀 Bot starting up...');
console.log('Environment:', {
  PORT,
  WEBHOOK_PATH,
  WEBAPP_URL
});

// For webhook setup
app.listen(PORT, async () => {
  console.log(`🌐 Server starting on port ${PORT}`);
  try {
    await bot.telegram.deleteWebhook();
    console.log('🔄 Old webhook deleted');
    await bot.telegram.setWebhook(`${WEBAPP_URL}${WEBHOOK_PATH}`);
    console.log('✅ New webhook set successfully');
  } catch (e) {
    console.log('❌ Webhook error:', e);
  }
});

// Graceful shutdown
process.once('SIGINT', () => {
  if (bot.isRunning) {
    bot.stop('SIGINT')
  }
});

process.once('SIGTERM', () => {
  if (bot.isRunning) {
    bot.stop('SIGTERM')
  }
})
