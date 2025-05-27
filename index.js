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
const awaitingCustomName = new Set();
// Добавляем хранилище для пользовательских имен
const userNames = new Map();
// Добавляем хранилище для всех пользователей бота
const botUsers = new Set();

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
  
  // Инициализация файла для пользователей
  const usersPath = path.join(dataDir, 'users.json');
  try {
    await fs.access(usersPath);
  } catch {
    await fs.writeFile(usersPath, '[]');
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

// Загружаем пользователей из файла
try {
  const usersPath = path.join(__dirname, 'public', 'data', 'users.json');
  const usersData = await fs.readFile(usersPath, 'utf8');
  const loadedUsers = JSON.parse(usersData);
  loadedUsers.forEach(user => botUsers.add(user));
  console.log(`✅ Loaded ${botUsers.size} users from data/users.json`);
} catch (err) {
  console.error('❌ Failed to load users.json:', err);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);
const pendingReminders = new Map();

// Функция для сохранения пользователей в файл
async function saveUsersToFile() {
  try {
    const usersPath = path.join(__dirname, 'public', 'data', 'users.json');
    const usersArray = Array.from(botUsers);
    await fs.writeFile(usersPath, JSON.stringify(usersArray, null, 2));
    console.log(`💾 Saved ${usersArray.length} users to file`);
  } catch (err) {
    console.error('❌ Failed to save users to file:', err);
  }
}

// Функция для добавления пользователя
async function addUser(userId) {
  if (!botUsers.has(userId)) {
    botUsers.add(userId);
    await saveUsersToFile();
    console.log(`👤 New user added: ${userId}`);
  }
}

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
    { command: 'update_schedule', description: 'Обновить расписание' },
    { command: 'cancel_schedule', description: 'Отменить загрузку расписания' },
    { command: 'users_count', description: 'Количество пользователей' },
    { command: 'broadcast', description: 'Рассылка сообщения' }
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
  const userId = ctx.from.id;
  
  // Добавляем пользователя в базу
  await addUser(userId);
  
  // Сохраняем имя из Telegram как дефолтное
  userNames.set(chatId, firstName);
  
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

bot.on('text', async (ctx) => {
  // Добавляем пользователя при любом текстовом сообщении
  await addUser(ctx.from.id);
  
  // Проверяем команды с упоминанием бота в группе
  const text = ctx.message.text;
  const botUsername = ctx.botInfo.username;
  
  if (text.startsWith(`/update_schedule@${botUsername}`)) {
    console.log('📝 Команда update_schedule с упоминанием получена от:', ctx.chat.id);
    
    if (!(await isAdminUser(ctx))) {
      console.log('❌ Пользователь не админ');
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    console.log('✅ Админ подтвержден, добавляем в ожидание');
    awaitingScheduleUpload.add(ctx.chat.id);
    return ctx.reply('📤 Отправьте файл Excel с расписанием для обновления');
  }
  
  if (text.startsWith(`/cancel_schedule@${botUsername}`)) {
    console.log('📝 Команда cancel_schedule с упоминанием получена от:', ctx.chat.id);
    
    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    if (awaitingScheduleUpload.has(ctx.chat.id)) {
      awaitingScheduleUpload.delete(ctx.chat.id);
      ctx.reply('❌ Загрузка расписания отменена');
    } else {
      ctx.reply('ℹ️ Загрузка расписания не была активна');
    }
    return;
  }
  
  if (text.startsWith(`/broadcast@${botUsername}`)) {
    console.log('📝 Команда broadcast с упоминанием получена от:', ctx.chat.id);

    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }

    // Выделяем префикс команды
    const commandPrefix = `/broadcast@${botUsername}`;
    // Обрезаем команду, оставляем только сам текст рассылки
    const broadcastMessage = text.startsWith(commandPrefix)
      ? text.slice(commandPrefix.length).trim()
      : text;

    // Если после обрезки нет текста — попросим ввести сообщение
    if (!broadcastMessage) {
      return ctx.reply('❌ Пожалуйста, укажите текст сообщения после команды.');
    }

    if (awaitingBroadcast.has(ctx.chat.id)) {
      // Если уже ожидали — отменяем ожидание
      awaitingBroadcast.delete(ctx.chat.id);
    } else {
      // Начинаем рассылку
      awaitingBroadcast.add(ctx.chat.id);
      
      await ctx.reply('📤 Начинаю рассылку...');

      let successCount = 0;
      let errorCount = 0;

      for (const userId of botUsers) {
        try {
          await bot.telegram.sendMessage(userId, broadcastMessage);
          successCount++;
          // Не спамим API
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
          errorCount++;
          console.error(`Failed to send message to user ${userId}:`, error.message);

          if (error.message.includes('blocked') ||
              error.message.includes('user not found') ||
              error.message.includes('chat not found')) {
            botUsers.delete(userId);
          }
        }
      }

      await ctx.reply(`✅ Рассылка завершена\nУспешно: ${successCount}\nОшибок: ${errorCount}`);
    return;
  }}

  // Обработка пользовательского имени
  if (awaitingCustomName.has(ctx.chat.id)) {
    const customName = ctx.message.text;
    // Сохраняем пользовательское имя
    userNames.set(ctx.chat.id, customName);
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
    return;
  }
  
  // Обработка рассылки
  if (awaitingBroadcast.has(ctx.chat.id)) {
    if (!(await isAdminUser(ctx))) {
      awaitingBroadcast.delete(ctx.chat.id);
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    const broadcastMessage = text;
    awaitingBroadcast.delete(ctx.chat.id);
    
    await ctx.reply('📤 Начинаю рассылку...');
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const userId of botUsers) {
      try {
        await bot.telegram.sendMessage(userId, broadcastMessage);
        successCount++;
        // Небольшая задержка, чтобы не превысить лимиты API
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        errorCount++;
        console.error(`Failed to send message to user ${userId}:`, error.message);
        
        // Если пользователь заблокировал бота, удаляем его из списка
        if (error.message.includes('blocked') || error.message.includes('user not found') || error.message.includes('chat not found')) {
          botUsers.delete(userId);
        }
      }
    }
    
    // Сохраняем обновленный список пользователей
    await saveUsersToFile();
    
    await ctx.reply(`✅ Рассылка завершена!\n📊 Успешно отправлено: ${successCount}\n❌ Ошибок: ${errorCount}\n👥 Активных пользователей: ${botUsers.size}`);
    return;
  }
});

bot.command('contacts', ctx => {
  ctx.reply(
    `Связь с ресепшн студии:
  Свободы 6 — 8-928-00-00-000
  Видова 210Д — 8-928-00-00-000
  Дзержинского 211/2 — 8-928-00-00-000`
  );
});

// Исправленная команда update_schedule
bot.command('update_schedule', async (ctx) => {
  console.log('📝 Команда update_schedule получена от:', ctx.chat.id, 'ADMIN_CHAT_ID:', ADMIN_CHAT_ID);
  
  // Исправляем проверку на админа - делаем её асинхронной
  if (!(await isAdminUser(ctx))) {
    console.log('❌ Пользователь не админ');
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  console.log('✅ Админ подтвержден, добавляем в ожидание');
  awaitingScheduleUpload.add(ctx.chat.id);
  ctx.reply('📤 Отправьте файл Excel с расписанием для обновления');
});

// Команда для отмены загрузки расписания
bot.command('cancel_schedule', async (ctx) => {
  console.log('📝 Команда cancel_schedule получена от:', ctx.chat.id);
  
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  if (awaitingScheduleUpload.has(ctx.chat.id)) {
    awaitingScheduleUpload.delete(ctx.chat.id);
    ctx.reply('❌ Загрузка расписания отменена');
  } else {
    ctx.reply('ℹ️ Загрузка расписания не была активна');
  }
});

// Команда для просмотра количества пользователей
bot.command('users_count', async (ctx) => {
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  ctx.reply(`👥 Всего пользователей бота: ${botUsers.size}`);
});

// Хранилище для ожидания сообщений рассылки
const awaitingBroadcast = new Set();

// Команда для рассылки
bot.command('broadcast', async (ctx) => {
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  awaitingBroadcast.add(ctx.chat.id);
  ctx.reply('📢 Введите сообщение для рассылки всем пользователям:');
});

// Исправленный обработчик документов
bot.on('document', async (ctx) => {
  try {
    // Проверяем, ожидается ли загрузка расписания от этого пользователя
    if (!awaitingScheduleUpload.has(ctx.chat.id)) {
      return; // Просто игнорируем документ, если не ожидаем загрузку
    }
    
    // Дополнительная проверка на админа
    if (!(await isAdminUser(ctx))) {
      awaitingScheduleUpload.delete(ctx.chat.id);
      return ctx.reply('❌ У вас нет прав для обновления расписания');
    }

    // Удаляем пользователя из списка ожидающих
    awaitingScheduleUpload.delete(ctx.chat.id);

    await ctx.reply('⏳ Обрабатываю файл расписания...');

    const fileId = ctx.message.document.file_id;
    const fileName = ctx.message.document.file_name;
    
    // Проверяем расширение файла
    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
      return ctx.reply('❌ Пожалуйста, отправьте файл Excel (.xlsx или .xls)');
    }

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = await response.buffer();

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return ctx.reply('❌ Файл пустой или не содержит данных');
    }

    // Используем существующую функцию updateScheduleFromExcel
    // Сначала сохраним файл временно
    const tempFilePath = path.join(__dirname, 'temp_schedule.xlsx');
    await fs.writeFile(tempFilePath, buffer);
    
    try {
      const newSchedules = await updateScheduleFromExcel(tempFilePath);
      
      // Обновляем глобальную переменную schedules
      Object.assign(schedules, newSchedules);
      
      // Удаляем временный файл
      await fs.unlink(tempFilePath);
      
      const totalEntries = Object.values(newSchedules).reduce((sum, arr) => sum + arr.length, 0);
      
      ctx.reply(`✅ Расписание успешно обновлено!\n📊 Загружено записей: ${totalEntries}\n🏢 Студий: ${Object.keys(newSchedules).length}`);
      
    } catch (updateError) {
      // Удаляем временный файл в случае ошибки
      try {
        await fs.unlink(tempFilePath);
      } catch {}
      
      throw updateError;
    }

  } catch (error) {
    console.error('Ошибка при обработке файла расписания:', error);
    
    // Удаляем пользователя из списка ожидающих в случае ошибки
    awaitingScheduleUpload.delete(ctx.chat.id);
    
    ctx.reply(`❌ Ошибка при обработке файла расписания: ${error.message}`);
  }
});

bot.on('contact', async ctx => {
  const chatId = ctx.chat.id;
  
  // Добавляем пользователя при отправке контакта
  await addUser(ctx.from.id);
  
  // Clear reminders if exist
  if (pendingReminders.has(chatId)) {
    const {t3, t15, t24 } = pendingReminders.get(chatId);
    clearTimeout(t3);
    clearTimeout(t15);
    clearTimeout(t24);
    pendingReminders.delete(chatId);
  }

  const { first_name, phone_number } = ctx.message.contact;
  const telegram_id = ctx.from.id;
  
  // Получаем сохраненное имя пользователя или используем имя из контакта
  const userName = userNames.get(chatId) || first_name;
  
  // Добавляем + к номеру телефона, если его нет
  const formattedPhone = phone_number.startsWith('+') ? phone_number : `+${phone_number}`;
  
  // Get stored booking data
  const bookingData = pendingBookings.get(telegram_id);
  
  if (bookingData) {
    // This is a form submission - send complete booking data
    const msg = `Новая подтвержденная заявка:
      Цель: ${bookingData.goal}
      Направление: ${bookingData.direction}
      Студия: ${bookingData.address}
      Слот: ${bookingData.slot || 'не указан'}
      Имя: ${userName}
      Телефон: ${formattedPhone}
      ID: ${telegram_id}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
    pendingBookings.delete(telegram_id);
  } else {
    // This is a callback request
    const msg = `Новая заявка на обратный звонок:
      Имя: ${userName}
      Телефон: ${formattedPhone}
      ID: ${telegram_id}`;
      
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg);
  }
  
  await ctx.reply('Спасибо! Мы перезвоним вам в ближайшее время.', Markup.removeKeyboard());
});

// Add temporary storage for bookings
const pendingBookings = new Map();

// Добавляем обработчики для всех остальных действий пользователей
bot.hears(/.*/, async (ctx) => {
  // Добавляем пользователя при любом сообщении
  await addUser(ctx.from.id);
});

bot.on('callback_query', async (ctx) => {
  // Добавляем пользователя при нажатии на кнопки
  await addUser(ctx.from.id);
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

// Добавляем новый endpoint для получения имени пользователя
app.get('/user-name/:telegram_id', (req, res) => {
  const telegramId = parseInt(req.params.telegram_id);
  const userName = Array.from(userNames.entries())
    .find(([chatId, name]) => chatId === telegramId)?.[1];
  
  res.json({ 
    ok: true, 
    name: userName || null 
  });
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
