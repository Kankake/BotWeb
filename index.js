import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Telegraf, Markup } from 'telegraf';
import XLSX from 'xlsx';
import fetch from 'node-fetch';
import mysql from 'mysql2/promise';

dotenv.config();

console.log('🚀 Bot starting up...');
console.log('Environment:', {
  PORT: process.env.PORT,
  WEBHOOK_PATH: '/tg-webhook',
  WEBAPP_URL: process.env.WEBAPP_URL,
  DB_HOST: process.env.DB_HOST,
  DB_NAME: process.env.DB_NAME
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WELCOME_PHOTO = path.join(__dirname, 'public', 'assets', 'welcome.jpg');
const NEXT_PHOTO = path.join(__dirname, 'public', 'assets', 'next.jpg');

// Load config from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/tg-webhook';

// MySQL connection
let pool;
try {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  console.log('✅ MySQL pool created');
} catch (err) {
  console.error('❌ MySQL pool creation error:', err);
}

let schedules = {}; // глобальная переменная

const awaitingScheduleUpload = new Set();
const awaitingCustomName = new Set();
const awaitingBroadcast = new Set();
const pendingReminders = new Map();
const pendingBookings = new Map();

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Создание таблиц при запуске
async function initDatabase() {
  if (!pool) {
    console.log('⚠️ Database pool not available, skipping initialization');
    return;
  }
  
  try {
    console.log('🔄 Initializing database tables...');
    
    // Таблица для расписаний
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        address VARCHAR(255) NOT NULL,
        schedule_data JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица для пользователей бота
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS bot_users (
        user_id BIGINT PRIMARY KEY,
        first_name VARCHAR(255),
        username VARCHAR(255),
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблица для пользовательских имен
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_names (
        chat_id BIGINT PRIMARY KEY,
        custom_name VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database tables initialized');
    
    // Загружаем расписания
    schedules = await loadSchedules();
    
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

// Функции для работы с пользователями
async function addUser(userId, firstName, username) {
  if (!pool) return;
  
  try {
    await pool.execute(
      'INSERT INTO bot_users (user_id, first_name, username) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE first_name = VALUES(first_name), username = VALUES(username)',
      [userId, firstName || '', username || '']
    );
    console.log(`👤 User added/updated: ${userId}`);
  } catch (err) {
    console.error('❌ Failed to add user:', err);
  }
}

async function getUsersCount() {
  if (!pool) return 0;
  
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) as count FROM bot_users');
    return parseInt(rows[0].count);
  } catch (err) {
    console.error('❌ Failed to get users count:', err);
    return 0;
  }
}

async function getAllUsers() {
  if (!pool) return [];
  
  try {
    const [rows] = await pool.execute('SELECT user_id FROM bot_users');
    return rows.map(row => row.user_id);
  } catch (err) {
    console.error('❌ Failed to get all users:', err);
    return [];
  }
}

async function removeUser(userId) {
  if (!pool) return;
  
  try {
    await pool.execute('DELETE FROM bot_users WHERE user_id = ?', [userId]);
    console.log(`👤 User removed: ${userId}`);
  } catch (err) {
    console.error('❌ Failed to remove user:', err);
  }
}

// Функции для работы с именами пользователей
async function setUserName(chatId, name) {
  if (!pool) return;
  
  try {
    await pool.execute(
      'INSERT INTO user_names (chat_id, custom_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE custom_name = VALUES(custom_name), updated_at = CURRENT_TIMESTAMP',
      [chatId, name]
    );
  } catch (err) {
    console.error('❌ Failed to set user name:', err);
  }
}

async function getUserName(chatId) {
  if (!pool) return null;
  
  try {
    const [rows] = await pool.execute('SELECT custom_name FROM user_names WHERE chat_id = ?', [chatId]);
    return rows[0]?.custom_name || null;
  } catch (err) {
    console.error('❌ Failed to get user name:', err);
    return null;
  }
}

// Функции для работы с расписанием
async function saveSchedules(schedulesData) {
  if (!pool) {
    schedules = schedulesData;
    console.log('✅ Schedules saved to memory (no database)');
    return;
  }
  
  try {
    // Очищаем старые данные
    await pool.execute('DELETE FROM schedules');
    
    // Сохраняем новые данные
    for (const [address, scheduleArray] of Object.entries(schedulesData)) {
      await pool.execute(
        'INSERT INTO schedules (address, schedule_data) VALUES (?, ?)',
        [address, JSON.stringify(scheduleArray)]
      );
    }
    console.log('✅ Schedules saved to database');
  } catch (err) {
    console.error('❌ Failed to save schedules:', err);
    // Fallback to memory
    schedules = schedulesData;
    console.log('✅ Schedules saved to memory (fallback)');
  }
}

async function loadSchedules() {
  if (!pool) return {};
  
  try {
    const [rows] = await pool.execute('SELECT address, schedule_data FROM schedules');
    const loadedSchedules = {};
    
    for (const row of rows) {
      loadedSchedules[row.address] = JSON.parse(row.schedule_data);
    }
    
    console.log(`✅ Loaded schedules for ${Object.keys(loadedSchedules).length} addresses`);
    return loadedSchedules;
  } catch (err) {
    console.error('❌ Failed to load schedules:', err);
    return {};
  }
}

// Функция проверки на админа
async function isAdminUser(ctx) {
  return ctx.chat.id.toString() === ADMIN_CHAT_ID;
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Add error handler
bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err);
  console.error('Context:', ctx.update);
});

// Add debug middleware
bot.use((ctx, next) => {
  console.log('📨 Received update:', {
    type: ctx.updateType,
    from: ctx.from?.id,
    chat: ctx.chat?.id,
    text: ctx.message?.text
  });
  return next();
});

// Function to send a message to a user and handle blocked users
async function sendMessageToUser(userId, message) {
  try {
    await bot.telegram.sendMessage(userId, message);
  } catch (error) {
    if (error.code === 403) {
      console.error(`User ${userId} has blocked the bot. Removing from database.`);
      await removeUser(userId);
    } else {
      console.error(`Failed to send message to user ${userId}:`, error.message);
    }
  }
}

// НОВАЯ функция для обновления расписания из буфера
async function updateScheduleFromBuffer(buffer) {
  try {
    console.log('📊 Starting to process Excel buffer...');
    
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    console.log('📋 Workbook sheets:', workbook.SheetNames);
    
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    
    console.log('📊 Raw data from Excel:', data.length, 'rows');
    if (data.length > 0) {
      console.log('📊 First row sample:', data[0]);
    }

    const newSchedules = {};
    let processedRows = 0;
    let errorRows = 0;

    data.forEach((row, index) => {
      try {
        if (!row.date || !row.time || !row.direction || !row.address) {
          console.log(`⚠️ Row ${index + 1} missing required fields:`, row);
          errorRows++;
          return;
        }

        let dateValue = row.date;
        
        if (typeof dateValue === 'number') {
          dateValue = new Date((dateValue - 25569) * 86400 * 1000);
        } else {
          dateValue = new Date(dateValue);
        }
        
        if (isNaN(dateValue.getTime())) {
          console.log(`⚠️ Row ${index + 1} invalid date:`, row.date);
          errorRows++;
          return;
        }
        
        const formattedDate = dateValue.toISOString().split('T')[0];
        const address = row.address.toString().trim();

        if (!newSchedules[address]) {
          newSchedules[address] = [];
        }

        const orderedEntry = {
          date: formattedDate,
          time: row.time.toString().trim(),
          direction: row.direction.toString().trim(),
          address: address
        };

        newSchedules[address].push(orderedEntry);
        processedRows++;
        
      } catch (error) {
        console.error(`❌ Error processing row ${index + 1}:`, error, row);
        errorRows++;
      }
    });

    console.log('📊 Processing complete:', {
      processedRows,
      errorRows,
      addresses: Object.keys(newSchedules).length
    });

    await saveSchedules(newSchedules);
    schedules = newSchedules;
    
    console.log('✅ Schedules updated successfully');

    return {
      newSchedules,
      processedRows,
      errorRows
    };
    
  } catch (error) {
    console.error('❌ Error in updateScheduleFromBuffer:', error);
    throw error;
  }
}

// Set up menu commands
try {
  const publicCommands = [
    { command: 'start', description: 'Начать заново' },
    { command: 'contacts', description: 'Контакты студии' }
  ];
  await bot.telegram.setMyCommands(publicCommands);

  const adminGroupCommands = [
    { command: 'update_schedule', description: 'Обновить расписание' },
    { command: 'cancel_schedule', description: 'Отменить загрузку расписания' },
    { command: 'users_count', description: 'Количество пользователей' },
    { command: 'broadcast', description: 'Рассылка сообщения' },
    { command: 'check_schedules', description: 'Проверить расписания' }
  ];
  await bot.telegram.setMyCommands(adminGroupCommands, {
    scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) }
  });

} catch (err) {
  console.log('Command menu setup:', err);
}

bot.start(async ctx => {
  const firstName = ctx.from.first_name || 'клиент';
  const username = ctx.from.username || '';
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  
  await addUser(userId, firstName, username);
  await setUserName(chatId, firstName);
  
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
  }, 15 * 60 * 1000);

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
  console.log('🔍 Тип чата:', ctx.chat.type);
  
  if (!(await isAdminUser(ctx))) {
    console.log('❌ Пользователь не админ');
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  console.log('✅ Админ подтвержден, добавляем в ожидание');
  awaitingScheduleUpload.add(ctx.chat.id);
  console.log('📋 Текущий список ожидающих:', Array.from(awaitingScheduleUpload));
  
  await ctx.reply('📤 Отправьте файл Excel с расписанием для обновления\n\n⚠️ Убедитесь, что файл содержит колонки: date, time, direction, address');
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

// Упрощенный обработчик с использованием функции
bot.on('document', async (ctx) => {
  console.log('📄 Document received from:', ctx.chat.id);
  console.log('📋 Awaiting upload list:', Array.from(awaitingScheduleUpload));
  
  if (!awaitingScheduleUpload.has(ctx.chat.id)) {
    console.log('❌ User not in awaiting list');
    return;
  }
  
  if (!(await isAdminUser(ctx))) {
    console.log('❌ User is not admin');
    return;
  }

  awaitingScheduleUpload.delete(ctx.chat.id);
  
  try {
    const fileName = ctx.message.document.file_name;
    console.log('📄 Processing file:', fileName);
    
    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
      return ctx.reply('❌ Пожалуйста, отправьте файл Excel (.xlsx или .xls)');
    }

    await ctx.reply('⏳ Обрабатываю файл расписания...');

    const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
    console.log('🔗 File link obtained:', fileLink.href);
    
    const response = await fetch(fileLink.href);
    const buffer = await response.buffer();
    console.log('📦 Buffer size:', buffer.length, 'bytes');

    const result = await updateScheduleFromBuffer(buffer);
    
    await ctx.reply(`✅ Расписание успешно обновлено!\n📊 Загружено записей: ${result.processedRows}\n🏢 Студий: ${Object.keys(result.newSchedules).length}\n⚠️ Ошибок в строках: ${result.errorRows}`);
    
  } catch (error) {
    console.error('❌ Ошибка при обработке файла:', error);
    ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('check_schedules', async (ctx) => {
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  const addressCount = Object.keys(schedules).length;
  const totalSlots = Object.values(schedules).reduce((sum, arr) => sum + arr.length, 0);
  
  let message = `📊 Текущее состояние расписаний:\n`;
  message += `🏢 Студий: ${addressCount}\n`;
  message += `📅 Всего слотов: ${totalSlots}\n\n`;
  
  if (addressCount > 0) {
    message += `Студии:\n`;
    Object.keys(schedules).forEach(address => {
      message += `• ${address}: ${schedules[address].length} слотов\n`;
    });
  } else {
    message += `❌ Расписания не загружены`;
  }
  
  await ctx.reply(message);
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
  const { direction, address, days = 3 } = req.body;
  const now = new Date();
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + days);

  const arr = schedules[address] || [];

  const slots = arr
    .filter(slot => {
      const slotDateTime = new Date(`${slot.date}T${slot.time}`);
      const match = slot.direction.trim() === direction.trim();
      
      return match && !isNaN(slotDateTime.getTime()) && slotDateTime >= now && slotDateTime <= targetDate;
    })
    .map(slot => ({ date: slot.date, time: slot.time }))
    .sort((a, b) => {
      const dateA = new Date(`${a.date}T${a.time}`);
      const dateB = new Date(`${b.date}T${b.time}`);
      return dateA - dateB;
    });

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

const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  // PRODUCTION: webhook по настоящему HTTPS URL
  await bot.telegram.deleteWebhook();
  await bot.telegram.setWebhook(`${WEBAPP_URL}${WEBHOOK_PATH}`);
  app.use(bot.webhookCallback(WEBHOOK_PATH));
  app.listen(PORT, () =>
    console.log(`✅ Webhook установлен на ${WEBAPP_URL}${WEBHOOK_PATH}, порт ${PORT}`)
  );
} else {
  // DEVELOPMENT: long polling, проще всего для локального теста
  await bot.launch();
  app.listen(PORT, () => console.log(`🤖 Бот запущен в режиме polling, порт ${PORT}`));
}

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
