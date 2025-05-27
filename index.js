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

// Загружаем переменные окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/tg-webhook';

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Проверка, является ли пользователь админом
async function isAdminUser(ctx) {
  return ctx.chat.id.toString() === ADMIN_CHAT_ID;
}

// Инициализация папки и файла для расписания
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

// Загружаем расписание из файла
let schedules = {};
try {
  const dataPath = path.join(__dirname, 'public', 'data', 'schedules.json');
  const data = await fs.readFile(dataPath, 'utf8');
  schedules = JSON.parse(data);
  console.log('✅ Loaded schedules from data/schedules.json');
} catch (err) {
  console.error('❌ Failed to load schedules.json:', err);
}

// Создаем экземпляр бота
const bot = new Telegraf(BOT_TOKEN);
const pendingReminders = new Map();
const awaitingScheduleUpload = new Set();
const awaitingCustomName = new Set();
const pendingBookings = new Map();

// Настройка меню команд
try {
  // Команды для пользователей
  const publicCommands = [
    { command: 'start', description: 'Начать заново' },
    { command: 'contacts', description: 'Контакты студии' }
  ];
  await bot.telegram.setMyCommands(publicCommands);

  // Команды для админа (только в его чате)
  const adminCommands = [
    { command: 'update_schedule', description: 'Обновить расписание' }
  ];
  await bot.telegram.setMyCommands(adminCommands, {
    scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) }
  });
} catch (err) {
  console.error('Ошибка при установке команд:', err);
}

// Функция обновления расписания из Excel (с сохранением в JSON)
async function updateScheduleFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  const newSchedules = {};

  data.forEach(row => {
    let dateValue = row.date;
    if (typeof dateValue === 'number') {
      dateValue = new Date((dateValue - 25569) * 86400 * 1000);
    } else {
      dateValue = new Date(dateValue);
    }
    const formattedDate = dateValue.toISOString().split('T')[0];

    if (!newSchedules[row.address]) {
      newSchedules[row.address] = [];
    }

    newSchedules[row.address].push({
      date: formattedDate,
      time: row.time,
      direction: row.direction.trim(),
      address: row.address.trim()
    });
  });

  // Сохраняем
  const filePathSave = path.join(__dirname, 'public', 'data', 'schedules.json');
  await fs.writeFile(filePathSave, JSON.stringify(newSchedules, null, 2));
  schedules = newSchedules;

  console.log('Расписание обновлено из Excel');
  return newSchedules;
}

// Команда /check_data для админа — показать текущее расписание
bot.command('check_data', async (ctx) => {
  if (ctx.chat.id.toString() !== ADMIN_CHAT_ID) return;

  const dataStr = JSON.stringify(schedules, null, 2);
  const chunkSize = 4000;
  for (let i = 0; i < dataStr.length; i += chunkSize) {
    await ctx.reply(dataStr.slice(i, i + chunkSize));
  }
});

// Команда /update_schedule для админа — ожидание загрузки файла
bot.command('update_schedule', (ctx) => {
  if (!isAdminUser(ctx)) return;
  awaitingScheduleUpload.add(ctx.chat.id);
  ctx.reply('Отправьте файл Excel с расписанием');
});

// Обработка загруженного файла Excel с расписанием (только для админа)
bot.on('document', async (ctx) => {
  try {
    if (!awaitingScheduleUpload.has(ctx.chat.id)) {
      return ctx.reply('Пожалуйста, сначала выполните команду /update_schedule');
    }
    awaitingScheduleUpload.delete(ctx.chat.id);

    const fileId = ctx.message.document.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = await response.buffer();

    // Обрабатываем Excel
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    // Конвертируем в нужный формат (если нужно — подстроить под свой формат)
    const schedule = {};
    data.forEach(row => {
      const day = row.Day || row.date || row.Date; // подстроить под реальный столбец
      const time = row.Time || row.time || '';
      const name = row.Name || row.name || '';
      if (!schedule[day]) schedule[day] = [];
      schedule[day].push({ time, name });
    });

    // Записываем в файл
    const filePath = path.join(__dirname, 'public', 'data', 'schedules.json');
    await fs.writeFile(filePath, JSON.stringify(schedule, null, 2));
    schedules = schedule;

    ctx.reply('Расписание успешно обновлено');
  } catch (error) {
    console.error(error);
    ctx.reply('Ошибка при обработке файла расписания');
  }
});

// Обработка команды /start
bot.start(async (ctx) => {
  const firstName = ctx.from.first_name || 'клиент';
  const chatId = ctx.chat.id;

  // Очищаем старые таймеры напоминаний, если есть
  if (pendingReminders.has(chatId)) {
    const { t3, t15, t24 } = pendingReminders.get(chatId);
    clearTimeout(t3);
    clearTimeout(t15);
    clearTimeout(t24);
  }

  // Таймеры напоминаний
  const t3 = setTimeout(() => {
    bot.telegram.sendMessage(
      chatId,
      `👋 Привет, ${firstName}! 🏃‍♀️ Места на бесплатное пробное занятие заканчиваются — успей забронировать своё!`,
      Markup.inlineKeyboard([
        Markup.button.webApp('Записаться онлайн', WEBAPP_URL)
      ])
    );
  }, 3 * 60 * 60 * 1000);

  const t15 = setTimeout(() => {
    bot.telegram.sendMessage(
      chatId,
      `${firstName}, успейте воспользоваться бесплатным первым занятием в нашей студии 💛.\nВыберите пробное занятие, пока их не разобрали 🙈`,
      Markup.inlineKeyboard([
        Markup.button.webApp('Записаться онлайн', WEBAPP_URL)
      ])
    );
  }, 15 * 60 * 1000);

  const t24 = setTimeout(() => {
    bot.telegram.sendMessage(
      chatId,
      `${firstName}, успейте воспользоваться бесплатным первым занятием в нашей студии 💛.\nВыберите пробное занятие, пока их не разобрали 🙈`,
      Markup.inlineKeyboard([
        Markup.button.webApp('Записаться онлайн', WEBAPP_URL)
      ])
    );
  }, 24 * 60 * 60 * 1000);

  pendingReminders.set(chatId, { t3, t15, t24 });

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

// Обработка ответа "Да" на имя
bot.hears('Да', async (ctx) => {
  await ctx.replyWithPhoto({ source: NEXT_PHOTO });
  return ctx.reply(
    'Отлично! Выберите действие:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ]).resize()
  );
});
// Обработка нажатия "🖥️ Запись онлайн"
bot.hears('🖥️ Запись онлайн', (ctx) => {
  ctx.reply(
    'Заполните онлайн-форму:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Перейти к форме', WEBAPP_URL)
    ])
  );
});

// Обработка "📞 Запись по звонку администратора"
bot.hears('📞 Запись по звонку администратора', (ctx) => {
  return ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([
      ['⬅️ Назад', { text: '📲 Отправить контакт', request_contact: true }]
    ]).resize()
  );
});

// Обработка кнопки "⬅️ Назад"
bot.hears('⬅️ Назад', (ctx) => {
  return ctx.reply(
    'Выберите действие:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ]).resize()
  );
});

// Отправка контактов студии
bot.hears('Контакты', (ctx) => {
  ctx.reply(
    `Связь с ресепшн студии:
    Свободы 6 — 8-928-00-00-000
    Видова 210Д — 8-928-00-00-000
    Дзержинского 211/2 — 8-928-00-00-000`
  );
});

// Если пользователь хочет ввести другое имя
bot.hears('Нет, ввести другое имя', async (ctx) => {
  awaitingCustomName.add(ctx.chat.id);
  await ctx.reply('Пожалуйста, введите, как к вам обращаться:');
});

// Обработка введенного имени
bot.on('text', async (ctx) => {
  if (!awaitingCustomName.has(ctx.chat.id)) return;
  awaitingCustomName.delete(ctx.chat.id);

  const firstName = ctx.message.text;

  await ctx.replyWithPhoto({ source: NEXT_PHOTO });
  await ctx.reply(
    `Приятно познакомиться, ${firstName}! Выберите действие:`,
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ]).resize()
  );
});

// Обработка нажатия "🖥️ Запись онлайн"
bot.hears('🖥️ Запись онлайн', (ctx) => {
  ctx.reply(
    'Заполните онлайн-форму:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Перейти к форме', WEBAPP_URL)
    ])
  );
});

// Обработка "📞 Запись по звонку администратора"
bot.hears('📞 Запись по звонку администратора', (ctx) => {
  return ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([
      ['⬅️ Назад', { text: '📲 Отправить контакт', request_contact: true }]
    ]).resize()
  );
});

// Обработка кнопки "⬅️ Назад"
bot.hears('⬅️ Назад', (ctx) => {
  return ctx.reply(
    'Выберите действие:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора'],
      ['Контакты']
    ]).resize()
  );
});

// Отправка контактов студии
bot.hears('Контакты', (ctx) => {
  ctx.reply(
    `Связь с ресепшн студии:
Свободы 6 — 8-928-00-00-000
Вокзальная 7 — 8-928-00-00-001
Мира 31 — 8-928-00-00-002`
  );
});

// Запуск веб-сервера и вебхука
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

  bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const telegramId = ctx.from.id;

  const bookingData = pendingBookings.get(telegramId);
  if (!bookingData) {
    return ctx.reply('Не удалось найти вашу заявку. Пожалуйста, заполните форму снова.');
  }

  // Сохраняем номер телефона из контакта
  bookingData.phone = contact.phone_number;

  try {
    await sendBookingToAdmin(bookingData);
    await ctx.reply('✅ Спасибо! Ваша заявка принята, с вами скоро свяжется администратор.');
    pendingBookings.delete(telegramId);
  } catch (err) {
    console.error('Ошибка при отправке администратору:', err);
    await ctx.reply('Произошла ошибка при отправке данных. Пожалуйста, попробуйте позже.');
  }
});


  async function sendBookingToAdmin(bookingData) {
    const { goal, direction, address, firstName, phone, slot, telegram_id } = bookingData;
    
    const msg = `Новая онлайн-заявка:
      Цель: ${goal}
      Направление: ${direction}
      Студия: ${address}
      Слот: ${slot || 'не указан'}
      Имя: ${firstName}
      Телефон: ${phone}
      ID: ${telegram_id}`;
      
    return await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
  }

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('ok');
  } catch (error) {
    console.error('Ошибка при обработке обновления:', error);
    res.status(500).send('Error');
  }
});

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);

  const webhookUrl = `${WEBAPP_URL}${WEBHOOK_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook установлен по адресу ${webhookUrl}`);
  } catch (err) {
    console.error('Ошибка установки webhook:', err);
  }
});
