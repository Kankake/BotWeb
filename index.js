import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import { Telegraf, Markup } from 'telegraf';
import XLSX from 'xlsx';
import fetch from 'node-fetch';
import pkg from 'pg';
const { Pool } = pkg;

console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('NODE_ENV:', process.env.NODE_ENV);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let schedules = {}; // глобальная переменная

pool.connect()
  .then(async () => {
    console.log('✅ DB connected!');
    schedules = await loadSchedules(); // ← загружаем расписания
  })
  .catch(err => console.error('❌ DB connection error:', err));



// Создание таблиц при запуске
async function initDatabase() {
  try {
    // Таблица для расписаний
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        address VARCHAR(255) NOT NULL,
        schedule_data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица для пользователей бота
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_users (
        user_id BIGINT PRIMARY KEY,
        first_name VARCHAR(255),
        username VARCHAR(255),
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица для пользовательских имен
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_names (
        chat_id BIGINT PRIMARY KEY,
        custom_name VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

// Функции для работы с пользователями
async function addUser(userId, firstName, username) {
  try {
    await pool.query(
      'INSERT INTO bot_users (user_id, first_name, username) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
      [userId, firstName || '', username || '']
    );
    console.log(`👤 User added/updated: ${userId}`);
  } catch (err) {
    console.error('❌ Failed to add user:', err);
  }
}

async function getUsersCount() {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM bot_users');
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('❌ Failed to get users count:', err);
    return 0;
  }
}

async function getAllUsers() {
  try {
    const result = await pool.query('SELECT user_id FROM bot_users');
    return result.rows.map(row => row.user_id);
  } catch (err) {
    console.error('❌ Failed to get all users:', err);
    return [];
  }
}

async function removeUser(userId) {
  try {
    await pool.query('DELETE FROM bot_users WHERE user_id = $1', [userId]);
    console.log(`👤 User removed: ${userId}`);
  } catch (err) {
    console.error('❌ Failed to remove user:', err);
  }
}

// Функции для работы с именами пользователей
async function setUserName(chatId, name) {
  try {
    await pool.query(
      'INSERT INTO user_names (chat_id, custom_name) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET custom_name = $2, updated_at = CURRENT_TIMESTAMP',
      [chatId, name]
    );
  } catch (err) {
    console.error('❌ Failed to set user name:', err);
  }
}

async function getUserName(chatId) {
  try {
    const result = await pool.query('SELECT custom_name FROM user_names WHERE chat_id = $1', [chatId]);
    return result.rows[0]?.custom_name || null;
  } catch (err) {
    console.error('❌ Failed to get user name:', err);
    return null;
  }
}

// Функции для работы с расписанием
async function saveSchedules(schedulesData) {
  try {
    // Очищаем старые данные
    await pool.query('DELETE FROM schedules');
    
    // Сохраняем новые данные
    for (const [address, scheduleArray] of Object.entries(schedulesData)) {
      await pool.query(
        'INSERT INTO schedules (address, schedule_data) VALUES ($1, $2)',
        [address, JSON.stringify(scheduleArray)]
      );
    }
    console.log('✅ Schedules saved to database');
  } catch (err) {
    console.error('❌ Failed to save schedules:', err);
  }
}

async function loadSchedules() {
  try {
    const result = await pool.query('SELECT address, schedule_data FROM schedules');
    const schedules = {};
    
    for (const row of result.rows) {
      schedules[row.address] = JSON.parse(row.schedule_data);
    }
    
    console.log(`✅ Loaded schedules for ${Object.keys(schedules).length} addresses`);
    return schedules;
  } catch (err) {
    console.error('❌ Failed to load schedules:', err);
    return {};
  }
}

// Инициализируем базу данных при запуске
await initDatabase();

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
const awaitingBroadcast = new Set();
const pendingReminders = new Map();
const pendingBookings = new Map();


if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Функция проверки на админа
async function isAdminUser(ctx) {
  if (ctx.chat.id.toString() === ADMIN_CHAT_ID) {
    return true;
  }
  return false;
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);


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

// Function to send a message to a user and handle blocked users
async function sendMessageToUser(userId, message) {
  try {
    await bot.telegram.sendMessage(userId, message);
  } catch (error) {
    if (error.code === 403) {
      console.error(`User ${userId} has blocked the bot. Removing from database.`);
      await removeUser(userId); // Remove the user from the database
    } else {
      console.error(`Failed to send message to user ${userId}:`, error.message);
    }
  }
}

// Update schedule function
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

    const orderedEntry = {
      date: formattedDate,
      time: row.time,
      direction: row.direction.trim(),
      address: row.address.trim()
    };

    newSchedules[row.address].push(orderedEntry);
  });

  console.log('Generated schedules:', newSchedules);

  // Сохраняем в базу данных вместо файла
  await saveSchedules(newSchedules);
  
  // Обновляем глобальную переменную
  schedules = newSchedules;

  return newSchedules;
}

bot.start(async ctx => {
  const firstName = ctx.from.first_name || 'клиент';
  const username = ctx.from.username || '';
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Добавляем пользователя в базу
  await addUser(userId, firstName, username);
  
  // Сохраняем имя из Telegram как дефолтное
  await setUserName(chatId, firstName);
  
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
    Свободы 6 — +7-928-40-85-968
    Видова 210Д — +7-993-32-12-000
    Дзержинского 211/2 — +7-993-30-10-137`
  );
});

bot.hears('Нет, ввести другое имя', async ctx => {
  awaitingCustomName.add(ctx.chat.id);
  await ctx.reply('Пожалуйста, введите, как к вам обращаться:');
});

bot.on('text', async (ctx) => {
  await addUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  
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
  
  // Добавляем обработку команды users_count с упоминанием
  if (text.startsWith(`/users_count@${botUsername}`)) {
  console.log('📝 Команда users_count с упоминанием получена от:', ctx.chat.id);
  console.log('Using DB URL:', process.env.DATABASE_URL);

  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }

  try {
    const result = await pool.query('SELECT COUNT(*) FROM bot_users');
    const count = result.rows[0].count;
    return ctx.reply(`👥 Всего пользователей бота: ${count}`);
  } catch (err) {
    console.error('❌ Failed to get user count:', err);
    return ctx.reply('⚠️ Ошибка при получении количества пользователей');
  }
}

  
  // Добавляем обработку команды broadcast с упоминанием
  if (text.startsWith(`/broadcast@${botUsername}`)) {
    console.log('📝 Команда broadcast с упоминанием получена от:', ctx.chat.id);
    
    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    awaitingBroadcast.add(ctx.chat.id);
    return ctx.reply('📢 Введите сообщение для рассылки всем пользователям:');
  }
  
  // Обработка пользовательского имени
  if (awaitingCustomName.has(ctx.chat.id)) {
    const customName = ctx.message.text;
    await setUserName(ctx.chat.id, customName);
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
     
     const allUsers = await getAllUsers();
    
     for (const userId of allUsers) {
       try {
         await sendMessageToUser(userId, broadcastMessage);
         successCount++;
         await new Promise(resolve => setTimeout(resolve, 50));
       } catch (error) {
         errorCount++;
         console.error(`Failed to send message to user ${userId}:`, error.message);
        
         if (error.message.includes('blocked') || error.message.includes('user not found') || error.message.includes('chat not found')) {
           await removeUser(userId);
         }
       }
     }
    
     const finalCount = await getUsersCount();
     await ctx.reply(`✅ Рассылка завершена!\n📊 Успешно отправлено: ${successCount}\n❌ Ошибок: ${errorCount}\n👥 Активных пользователей: ${finalCount}`);
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
  try {
    const res = await pool.query('SELECT COUNT(*) FROM bot_users');
    const count = parseInt(res.rows[0].count, 10);
    return ctx.reply(`👥 Всего пользователей бота: ${count}`);
  } catch (err) {
    console.error('❌ Failed to get users count:', err);
    return ctx.reply('Ошибка при получении количества пользователей.');
  }
});



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
  
  await addUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  
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
  const userName = await getUserName(chatId) || first_name;
  
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


// Добавляем обработчики для всех остальных действий пользователей
bot.hears(/.*/, async (ctx) => {
  // Добавляем пользователя при любом сообщении
  await addUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
});

bot.on('callback_query', async (ctx) => {
  // Добавляем пользователя при нажатии на кнопки
  await addUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
});

// Express App
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoints
app.post('/slots', (req, res) => {
  const { direction, address } = req.body;
  const now = new Date();
  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

  console.log('REQUEST direction:', direction, '| address:', address);
  console.log('Current time:', now.toISOString());
  console.log('Three days from now:', threeDaysFromNow.toISOString());
  
  const arr = schedules[address] || [];
  console.log('SLOTS directions:', arr.map(s => '[' + s.direction + ']'));
  console.log('Total slots for address:', arr.length);

  const slots = arr
    .filter(slot => {
      const slotDateTime = new Date(`${slot.date}T${slot.time}`);
      const match = slot.direction.trim() === direction.trim();
      
      // Добавляем отладочную информацию
      console.log('Checking slot:', {
        date: slot.date,
        time: slot.time,
        direction: slot.direction,
        slotDateTime: slotDateTime.toISOString(),
        isValidDate: !isNaN(slotDateTime.getTime()),
        isAfterNow: slotDateTime >= now,
        isWithinThreeDays: slotDateTime <= threeDaysFromNow,
        directionMatch: match
      });
      
      if (match && slotDateTime >= now && slotDateTime <= threeDaysFromNow) {
        console.log('MATCH FOUND:', slot.direction, '|', direction, '|', slot.date, slot.time);
      }
      
      return match && !isNaN(slotDateTime.getTime()) && slotDateTime >= now && slotDateTime <= threeDaysFromNow;
    })
    .map(slot => ({ date: slot.date, time: slot.time }));

  console.log('Filtered slots count:', slots.length);
  res.json({ ok: true, slots });
});



// Добавляем новый endpoint для получения имени пользователя
app.get('/user-name/:telegram_id', async (req, res) => {
  const telegramId = parseInt(req.params.telegram_id);
  const userName = await getUserName(telegramId);
  
  res.json({ 
    ok: true, 
    name: userName 
  });
});

app.get('/json', async (_req, res) => {
  try {
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения расписания' });
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

app.get('/debug-schedules/:address', (req, res) => {
  const address = req.params.address;
  const arr = schedules[address] || [];
  
  const debugInfo = arr.map(slot => ({
    ...slot,
    parsedDateTime: new Date(`${slot.date}T${slot.time}`).toISOString(),
    isValidDate: !isNaN(new Date(`${slot.date}T${slot.time}`).getTime())
  }));
  
  res.json({
    address,
    totalSlots: arr.length,
    currentTime: new Date().toISOString(),
    slots: debugInfo
  });
});
