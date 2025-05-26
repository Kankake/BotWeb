import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import { Telegraf, Markup, Scenes, session } from 'telegraf';
import XLSX from 'xlsx';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WELCOME_PHOTO = path.join(__dirname, 'public', 'assets', 'welcome.jpg');
const NEXT_PHOTO = path.join(__dirname, 'public', 'assets', 'next.jpg');

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/tg-webhook';

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

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

let schedules = {};
try {
  const dataPath = path.join(__dirname, 'public', 'data', 'schedules.json');
  const data = await fs.readFile(dataPath, 'utf8');
  schedules = JSON.parse(data);
  console.log('✅ Loaded schedules from data/schedules.json');
} catch (err) {
  console.error('❌ Failed to load schedules.json:', err);
}

<<<<<<< HEAD
=======
// Create name scene
>>>>>>> parent of c844438 ('')
const nameScene = new Scenes.BaseScene('name-scene');
const stage = new Scenes.Stage([nameScene]);

<<<<<<< HEAD
const bot = new Telegraf(BOT_TOKEN);
bot.use(session({ 
  defaultSession: () => ({}) 
}));
bot.use(stage.middleware());

nameScene.enter((ctx) => {
  console.log('Name scene entered');
  return ctx.reply('Пожалуйста, введите, как к вам обращаться:');
});

nameScene.on('text', (ctx) => {
  console.log('Processing name:', ctx.message.text);
  const customName = ctx.message.text;
  
  return Promise.all([
    ctx.replyWithPhoto({ source: NEXT_PHOTO }),
    ctx.reply(
      `Приятно познакомиться, ${customName}!`,
      Markup.keyboard([
        ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
        ['Контакты']
      ])
      .resize()
    ),
    ctx.scene.leave()
  ]);
});

bot.hears(' Нет, ввести другое имя', (ctx) => {
  console.log('Initiating name entry');
  return ctx.scene.enter('name-scene');
});
bot.command('check_data', async (ctx) => {  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) return;
=======
nameScene.enter(async (ctx) => {
  await ctx.reply('Пожалуйста, введите, как к вам обращаться:');
});

nameScene.on('text', async (ctx) => {
  const customName = ctx.message.text;
  await ctx.replyWithPhoto({ source: NEXT_PHOTO });
  await ctx.reply(
    `Приятно познакомиться, ${customName}!`,
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ])
    .resize()
  );
  await ctx.scene.leave();
});

// Initialize bot with scenes
const stage = new Scenes.Stage([nameScene]);
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());
bot.use(stage.middleware());

const pendingReminders = new Map();
const pendingBookings = new Map();

bot.command('check_data', async (ctx) => {
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) return;
>>>>>>> parent of c844438 ('')
  const data = JSON.stringify(schedules, null, 2);
  const chunkSize = 4000;
  
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    await ctx.reply(chunk);
  }
});

try {
  const publicCommands = [
    { command: 'start', description: 'Начать заново' },
    { command: 'contacts', description: 'Контакты студии' }
  ];
  await bot.telegram.setMyCommands(publicCommands);
  const adminCommands = [
    ...publicCommands,
    { command: 'check_data', description: 'Проверить данные' },
    { command: 'update_schedule', description: 'Обновить расписание (админ)' }
  ];
  await bot.telegram.setMyCommands(adminCommands, {
    scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) }
  });
  await bot.telegram.setChatMenuButton('default', { type: 'commands' });
} catch (err) {
  console.error('Не удалось установить команды меню:', err);
}

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
    path.join(__dirname,'public', 'data', 'schedules.json'),
    JSON.stringify(schedules, null, 2)
  );
  
  return schedules;
}

bot.start(async ctx => {
  const firstName = ctx.from.first_name || '';
  await ctx.replyWithPhoto({ source: WELCOME_PHOTO });
  await ctx.reply(
    `Приветствую, наш будущий клиент!\n` +
    `Я Лея — умный помощник студии балета и растяжки LEVITA!\n\n` +
    `Могу обращаться к вам по имени "${firstName}", которое указано у вас в профиле?`,
    Markup.keyboard([['Да', ' Нет, ввести другое имя']])
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

bot.hears(' Нет, ввести другое имя', async (ctx) => {
  await ctx.scene.enter('name-scene');
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
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) return;
  ctx.reply('Отправьте Excel файл с расписанием');
});

bot.on('document', async (ctx) => {
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) return;

  try {
    const file = await ctx.telegram.getFile(ctx.message.document.file_id);
    const filePath = path.join(__dirname, 'temp.xlsx');
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = await response.buffer();
    await fs.writeFile(filePath, buffer);
    
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
  const chatId = ctx.chat.id;
  
  if (pendingReminders.has(chatId)) {
    const { t15, t24 } = pendingReminders.get(chatId);
    clearTimeout(t15);
    clearTimeout(t24);
    pendingReminders.delete(chatId);
  }

  const { first_name, phone_number } = ctx.message.contact;
  const telegram_id = ctx.from.id;
  
  const bookingData = pendingBookings.get(telegram_id);
  
  if (bookingData) {
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
    const msg = `Новая заявка на обратный звонок:
      Имя: ${first_name}
      Телефон: ${phone_number}
      ID: ${telegram_id}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
  }
  
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.use(bot.webhookCallback(WEBHOOK_PATH));

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

process.once('SIGINT', () => {
  if (bot.isRunning) {
    bot.stop('SIGINT')
  }
});

process.once('SIGTERM', () => {
  if (bot.isRunning) {
    bot.stop('SIGTERM')
  }
});
