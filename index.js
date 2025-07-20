import fs from 'fs'
import express from 'express'
import path, { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Telegraf, Markup } from 'telegraf'
import XLSX from 'xlsx'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import pg from 'pg';
const { Pool } = pg;

dotenv.config();

console.log('🚀 Bot starting up...');
console.log('Environment check:', {
  PORT: process.env.PORT,
  WEBAPP_URL: process.env.WEBAPP_URL,
  DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_DB: process.env.POSTGRES_DB,
  BOT_TOKEN: process.env.BOT_TOKEN ? 'SET' : 'NOT SET',
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ? 'SET' : 'NOT SET'
});

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Initialize Express app - ADD THIS SECTION
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Добавьте middleware для логирования запросов
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.path} from ${req.ip}`);
  next();
});

const WELCOME_PHOTO = path.join(__dirname, 'public', 'assets', 'welcome.jpg');
const NEXT_PHOTO = path.join(__dirname, 'public', 'assets', 'next.jpg');

// Load config from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const WEBHOOK_PATH = '/tg-webhook';

const HOST = process.env.HOST || '0.0.0.0';  // Добавьте в начало файла
// объявляем pool заранее
let pool


let schedules = {}; // глобальная переменная

const awaitingScheduleUpload = new Set();
const awaitingCustomName = new Set();
const awaitingBroadcast = new Set();
const pendingReminders = new Map();
const pendingBookings = new Map();

// In-memory storage as fallback
const users = new Map();
const userNames = new Map();

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('❌ Missing BOT_TOKEN, ADMIN_CHAT_ID or WEBAPP_URL');
  process.exit(1);
}

// Database functions with fallback to memory
async function initDatabase() {
  try {
    // Конфигурация для Amvera PostgreSQL
    const config = process.env.DATABASE_URL ? {
      connectionString: process.env.DATABASE_URL,
      ssl: false // Amvera не требует SSL для внутренних подключений
    } : {
      host: process.env.POSTGRES_HOST || 'amvera-framezilla-cnpg-bd-bota-rw',
      port: process.env.POSTGRES_PORT || 5432,
      database: process.env.POSTGRES_DB || 'postgres',
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: false,
      // Дополнительные настройки для стабильности
      max: 20, // максимум подключений в пуле
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };

    console.log('🔄 Подключение к PostgreSQL...', {
      host: config.host || 'from DATABASE_URL',
      database: config.database || 'from DATABASE_URL',
      user: config.user || 'from DATABASE_URL'
    });

    pool = new Pool(config);
    
    // Тест подключения с таймаутом
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    console.log('✅ PostgreSQL подключен успешно, время сервера:', result.rows[0].current_time);
    
    // Проверяем права доступа
    try {
      await client.query('SELECT current_user, current_database(), current_schema()');
      console.log('✅ Проверка прав доступа прошла успешно');
    } catch (permError) {
      console.log('⚠️ Ограниченные права доступа:', permError.message);
    }
    
    // Создание таблиц с обработкой ошибок
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_users (
          id SERIAL PRIMARY KEY,
          user_id BIGINT UNIQUE NOT NULL,
          first_name VARCHAR(255),
          username VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS user_names (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT UNIQUE NOT NULL,
          custom_name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS schedules (
          id SERIAL PRIMARY KEY,
          address VARCHAR(500) NOT NULL,
          schedule_data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Создание индексов
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_bot_users_user_id ON bot_users(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_names_chat_id ON user_names(chat_id);
        CREATE INDEX IF NOT EXISTS idx_schedules_address ON schedules(address);
      `);

      console.log('✅ Таблицы PostgreSQL созданы/проверены');
      
      // Загружаем существующие расписания
      const loadedSchedules = await loadSchedules();
      if (Object.keys(loadedSchedules).length > 0) {
        schedules = loadedSchedules;
        console.log(`✅ Загружено расписаний из БД: ${Object.keys(loadedSchedules).length} студий`);
      }
      
    } catch (tableError) {
      console.error('❌ Ошибка создания таблиц:', tableError.message);
      console.log('⚠️ Переключаемся на память из-за проблем с таблицами');
      client.release();
      pool = null;
      return;
    }

    client.release();
    
  } catch (err) {
    console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
    console.log('⚠️ Переключаемся на память');
    pool = null;
  }
}



async function addUser(userId, firstName, username) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO bot_users (user_id, first_name, username, updated_at) 
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
         ON CONFLICT (user_id) 
         DO UPDATE SET 
           first_name = EXCLUDED.first_name, 
           username = EXCLUDED.username, 
           updated_at = CURRENT_TIMESTAMP`,
        [userId, firstName || '', username || '']
      );
      console.log(`👤 User added/updated in DB: ${userId}`);
      return;
    } catch (err) {
      console.error('❌ Failed to add user to DB:', err);
    }
  }
  
  // Fallback to memory
  users.set(userId, { firstName, username, addedAt: new Date() });
  console.log(`👤 User added/updated in memory: ${userId}`);
}

async function getUsersCount() {
  if (pool) {
    try {
      const result = await pool.query('SELECT COUNT(*) as count FROM bot_users');
      return parseInt(result.rows[0].count);
    } catch (err) {
      console.error('❌ Failed to get users count from DB:', err);
    }
  }
  
  return users.size;
}

async function getAllUsers() {
  if (pool) {
    try {
      const result = await pool.query('SELECT user_id FROM bot_users');
      return result.rows.map(row => row.user_id);
    } catch (err) {
      console.error('❌ Failed to get all users from DB:', err);
    }
  }
  
  return Array.from(users.keys());
}

async function removeUser(userId) {
  if (pool) {
    try {
      await pool.query('DELETE FROM bot_users WHERE user_id = $1', [userId]);
      console.log(`👤 User removed from DB: ${userId}`);
      return;
    } catch (err) {
      console.error('❌ Failed to remove user from DB:', err);
    }
  }
  
  users.delete(userId);
  userNames.delete(userId);
  console.log(`👤 User removed from memory: ${userId}`);
}

async function setUserName(chatId, name) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO user_names (chat_id, custom_name, updated_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP) 
         ON CONFLICT (chat_id) 
         DO UPDATE SET 
           custom_name = EXCLUDED.custom_name, 
           updated_at = CURRENT_TIMESTAMP`,
        [chatId, name]
      );
      return;
    } catch (err) {
      console.error('❌ Failed to set user name in DB:', err);
    }
  }
  
  userNames.set(chatId, name);
}

async function getUserName(chatId) {
  if (pool) {
    try {
      const result = await pool.query('SELECT custom_name FROM user_names WHERE chat_id = $1', [chatId]);
      return result.rows[0]?.custom_name || null;
    } catch (err) {
      console.error('❌ Failed to get user name from DB:', err);
    }
  }
  
  return userNames.get(chatId) || null;
}

async function saveSchedules(schedulesData) {
  if (pool) {
    try {
      // Начинаем транзакцию
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM schedules');
        
        for (const [address, scheduleArray] of Object.entries(schedulesData)) {
          await client.query(
            'INSERT INTO schedules (address, schedule_data, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
            [address, JSON.stringify(scheduleArray)]
          );
        }
        
        await client.query('COMMIT');
        console.log('✅ Schedules saved to PostgreSQL database');
        return;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('❌ Failed to save schedules to DB:', err);
    }
  }
  
  schedules = schedulesData;
  console.log('✅ Schedules saved to memory');
}

async function loadSchedules() {
  if (pool) {
    try {
      const result = await pool.query('SELECT address, schedule_data FROM schedules');
      const loadedSchedules = {};
      
      for (const row of result.rows) {
        loadedSchedules[row.address] = JSON.parse(row.schedule_data);
      }
      
      console.log(`✅ Loaded schedules for ${Object.keys(loadedSchedules).length} addresses from DB`);
      return loadedSchedules;
    } catch (err) {
      console.error('❌ Failed to load schedules from DB:', err);
    }
  }
  
  return {};
}

// Initialize database
await initDatabase();

// Функция проверки на админа
async function isAdminUser(ctx) {
  return ctx.chat.id.toString() === ADMIN_CHAT_ID;
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Add error handler
bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err);
});

// Add debug middleware
bot.use((ctx, next) => {
  console.log('📨 Received:', ctx.updateType, 'from:', ctx.from?.id);
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

// Function to update schedule from buffer
async function updateScheduleFromBuffer(buffer) {
  try {
    console.log('📊 Starting to process Excel buffer...');
    
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    
    console.log('📊 Raw data from Excel:', data.length, 'rows');

    const newSchedules = {};
    let processedRows = 0;
    let errorRows = 0;

    data.forEach((row, index) => {
      try {
        if (!row.date || !row.time || !row.direction || !row.address) {
          console.log(`⚠️ Row ${index + 1} missing required fields`);
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
        console.error(`❌ Error processing row ${index + 1}:`, error);
        errorRows++;
      }
    });

    await saveSchedules(newSchedules);
    schedules = newSchedules;
    
    console.log('✅ Schedules updated successfully');

    return { newSchedules, processedRows, errorRows };
    
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
    { command: 'check_schedules', description: 'Проверить расписания' },
    { command: 'db_status', description: 'Статус базы данных' },
    { command: 'dump_db', description: 'Вывести БД в логи' },
    { command: 'dump_schedules', description: 'Вывести расписания в логи' }
  ];
  await bot.telegram.setMyCommands(adminGroupCommands, {
    scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) }
  });

} catch (err) {
  console.log('Command menu setup error:', err);
}

bot.start(async ctx => {
  const firstName = ctx.from.first_name || 'клиент';
  const username = ctx.from.username || '';
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  
  await addUser(userId, firstName, username);
  await setUserName(chatId, firstName);
  
  // Clear existing reminders
  if (pendingReminders.has(chatId)) {
    const {t3, t15, t24 } = pendingReminders.get(chatId);
    clearTimeout(t3);
    clearTimeout(t15);
    clearTimeout(t24);
  }
  
  // Set new reminders
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
    
   if (text.startsWith(`/dump_db@${botUsername}`)) {
    console.log('📝 Команда dump_db с упоминанием получена от:', ctx.chat.id);
    
    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    if (!pool) {
      console.log('❌ База данных не подключена (используется память)');
      return ctx.reply('❌ База данных не подключена (используется память)');
    }
    
    try {
      console.log('🔍 ===== DUMP DATABASE START =====');
      
      // 1. Информация о подключении
      const client = await pool.connect();
      const dbInfo = await client.query('SELECT current_database(), current_user, current_schema(), version()');
      console.log('📊 Database Info:', dbInfo.rows[0]);
      
      // 2. Список всех таблиц
      const tables = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      console.log('📋 Tables:', tables.rows.map(r => r.table_name));
      
      // 3. Пользователи бота
      try {
        const users = await client.query('SELECT * FROM bot_users ORDER BY created_at DESC LIMIT 10');
        console.log('👥 Bot Users (last 10):');
        users.rows.forEach((user, index) => {
          console.log(`  ${index + 1}. ID: ${user.user_id}, Name: ${user.first_name}, Username: @${user.username || 'none'}, Created: ${user.created_at}`);
        });
        
        const userCount = await client.query('SELECT COUNT(*) as count FROM bot_users');
        console.log(`👥 Total Users: ${userCount.rows[0].count}`);
      } catch (err) {
        console.log('❌ Error reading bot_users:', err.message);
      }
      
      // 4. Пользовательские имена
      try {
        const userNames = await client.query('SELECT * FROM user_names ORDER BY updated_at DESC LIMIT 10');
        console.log('📝 User Names (last 10):');
        userNames.rows.forEach((name, index) => {
          console.log(`  ${index + 1}. Chat ID: ${name.chat_id}, Name: ${name.custom_name}, Updated: ${name.updated_at}`);
        });
        
        const nameCount = await client.query('SELECT COUNT(*) as count FROM user_names');
        console.log(`📝 Total Custom Names: ${nameCount.rows[0].count}`);
      } catch (err) {
        console.log('❌ Error reading user_names:', err.message);
      }
      
      // 5. Расписания
      try {
        const schedules_db = await client.query('SELECT * FROM schedules ORDER BY updated_at DESC');
        console.log('📅 Schedules from DB:');
        schedules_db.rows.forEach((schedule, index) => {
          const data = JSON.parse(schedule.schedule_data);
          console.log(`  ${index + 1}. Address: ${schedule.address}`);
          console.log(`     Slots: ${data.length}`);
          console.log(`     Updated: ${schedule.updated_at}`);
          
          // Показываем первые 3 слота для примера
          if (data.length > 0) {
            console.log('     Sample slots:');
            data.slice(0, 3).forEach((slot, slotIndex) => {
              console.log(`       ${slotIndex + 1}. ${slot.date} ${slot.time} - ${slot.direction}`);
            });
            if (data.length > 3) {
              console.log(`       ... и еще ${data.length - 3} слотов`);
            }
          }
          console.log('');
        });
        
        const scheduleCount = await client.query('SELECT COUNT(*) as count FROM schedules');
        console.log(`📅 Total Schedule Addresses: ${scheduleCount.rows[0].count}`);
      } catch (err) {
        console.log('❌ Error reading schedules:', err.message);
      }
      
      client.release();
      
      console.log('🔍 ===== DUMP DATABASE END =====');
      
      await ctx.reply('✅ База данных выведена в логи сервера. Проверьте консоль.');
      
    } catch (err) {
      console.error('❌ Error dumping database:', err);
      await ctx.reply(`❌ Ошибка при выводе БД: ${err.message}`);
    }
    return;
  }
  
  if (text.startsWith(`/dump_schedules@${botUsername}`)) {
    console.log('📝 Команда dump_schedules с упоминанием получена от:', ctx.chat.id);
    
    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    console.log('📅 ===== SCHEDULES DUMP START =====');
    console.log('📊 Global schedules variable:');
    console.log(`Addresses count: ${Object.keys(schedules).length}`);
    
    Object.entries(schedules).forEach(([address, slots], index) => {
      console.log(`\n${index + 1}. 🏢 ${address}:`);
      console.log(`   Slots: ${slots.length}`);
      
      if (slots.length > 0) {
        // Группируем по датам
        const byDate = {};
        slots.forEach(slot => {
          if (!byDate[slot.date]) byDate[slot.date] = [];
          byDate[slot.date].push(slot);
        });
        
        Object.entries(byDate).forEach(([date, dateSlots]) => {
          console.log(`   📅 ${date}: ${dateSlots.length} slots`);
          dateSlots.slice(0, 5).forEach(slot => {
            console.log(`      ${slot.time} - ${slot.direction}`);
          });
          if (dateSlots.length > 5) {
            console.log(`      ... и еще ${dateSlots.length - 5} слотов`);
          }
        });
      }
    });
    
    console.log('📅 ===== SCHEDULES DUMP END =====');
    
    await ctx.reply('✅ Расписания выведены в логи сервера. Проверьте консоль.');
    return;
  }
  
  if (text.startsWith(`/db_status@${botUsername}`)) {
    console.log('📝 Команда db_status с упоминанием получена от:', ctx.chat.id);
    
    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }
    
    if (!pool) {
      return ctx.reply('❌ База данных не подключена (используется память)');
    }
    
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT NOW() as time');
      const usersCount = await getUsersCount();
      const schedulesCount = Object.keys(schedules).length;
      
      client.release();
      
      await ctx.reply(`✅ База данных работает
🕐 Время сервера: ${result.rows[0].time}
👥 Пользователей: ${usersCount}
📅 Студий в расписании: ${schedulesCount}
🔗 Подключение: PostgreSQL`);
      
    } catch (err) {
      console.error('DB status error:', err);
      await ctx.reply(`❌ Ошибка БД: ${err.message}`);
    }
    return;
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

    if (!(await isAdminUser(ctx))) {
      return ctx.reply('❌ У вас нет прав для выполнения этой команды');
    }

    try {
      const count = await getUsersCount();
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
  Свободы 6 — +7-928-40-85-968
  Видова 210Д — +7-993-32-12-000
  Дзержинского 211/2 — +7-993-30-10-137`
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
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  try {
    const count = await getUsersCount();
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
const PORT = process.env.PORT || process.env.SERVER_PORT || process.env.AMVERA_PORT || 80;

console.log(`🔧 Режим запуска: ${isProd ? 'PRODUCTION (webhook)' : 'DEVELOPMENT (polling)'}`);
console.log(`🔌 Порт: ${PORT}`);
console.log(`🔍 Переменные портов:`, {
  PORT: process.env.PORT,
  SERVER_PORT: process.env.SERVER_PORT,
  AMVERA_PORT: process.env.AMVERA_PORT,
  используется: PORT
});

// Добавьте маршруты для проверки
app.get('/', (req, res) => {
  res.send('<h1>Server Works!</h1><p>Bot is running</p>');
});

app.get('/test', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date(),
    port: PORT,
    env: process.env.NODE_ENV 
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

let botRunning = false;

// СНАЧАЛА запускаем сервер
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🌐 Доступен по адресу: http://0.0.0.0:${PORT}`);
  
  // Ждем немного, чтобы сервер полностью запустился
  setTimeout(async () => {
    console.log('🤖 Настраиваем бота...');
    
    try {
      if (isProd) {
        // PRODUCTION: webhook
        console.log('🔄 Настройка webhook...');
        console.log('🔗 Полный URL webhook:', `${WEBAPP_URL}${WEBHOOK_PATH}`);
        
        // Удаляем старый webhook и pending updates
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🗑️ Старый webhook удален, pending updates очищены');
        
        // Ждем немного
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Устанавливаем новый webhook
        const webhookResult = await bot.telegram.setWebhook(`${WEBAPP_URL}${WEBHOOK_PATH}`);
        console.log('✅ Webhook установлен:', webhookResult);
        
        // Настраиваем обработчик webhook
        app.post(WEBHOOK_PATH, express.json(), (req, res) => {
          console.log('📨 Webhook получен:', {
            timestamp: new Date().toISOString(),
            updateId: req.body.update_id,
            hasMessage: !!req.body.message,
            messageText: req.body.message?.text?.substring(0, 50)
          });
          
          try {
            bot.handleUpdate(req.body);
            res.status(200).send('OK');
          } catch (error) {
            console.error('❌ Ошибка обработки webhook:', error);
            res.status(500).send('Error');
          }
        });
        
        console.log(`✅ Webhook callback настроен на ${WEBHOOK_PATH}`);
        botRunning = false;
        
      } else {
        // DEVELOPMENT: polling
        console.log('🔄 Запуск polling...');
        await bot.launch();
        botRunning = true;
        console.log('✅ Бот запущен в режиме polling');
      }
      
      // Проверяем статус webhook
      const webhookInfo = await bot.telegram.getWebhookInfo();
      console.log('📊 Webhook статус:', {
        url: webhookInfo.url,
        pending_updates: webhookInfo.pending_update_count,
        last_error: webhookInfo.last_error_message || 'none'
      });
      
    } catch (err) {
      console.error('❌ Ошибка настройки бота:', err.message);
      console.error('Stack:', err.stack);
    }
  }, 3000);
});

server.on('error', (err) => {
  console.error('❌ Ошибка сервера:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Порт ${PORT} уже используется`);
  }
});

// graceful shutdown
const shutdown = (signal) => {
  console.log(`🛑 Получен сигнал ${signal}, завершаем работу...`);
  server.close(async () => {
    if (botRunning) {
      try {
        await bot.stop(signal);
      } catch (err) {
        console.error('Ошибка остановки бота:', err);
      }
    }
    
    // Закрываем подключение к БД
    if (pool) {
      try {
        await pool.end();
        console.log('✅ PostgreSQL подключение закрыто');
      } catch (err) {
        console.error('❌ Ошибка закрытия PostgreSQL:', err);
      }
    }
    
    process.exit(0);
  });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// Добавьте новую админскую команду:
bot.command('db_status', async (ctx) => {
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  if (!pool) {
    return ctx.reply('❌ База данных не подключена (используется память)');
  }
  
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as time');
    const usersCount = await getUsersCount();
    const schedulesCount = Object.keys(schedules).length;
    
    client.release();
    
    await ctx.reply(`✅ База данных работает
🕐 Время сервера: ${result.rows[0].time}
👥 Пользователей: ${usersCount}
📅 Студий в расписании: ${schedulesCount}
🔗 Подключение: PostgreSQL`);
    
  } catch (err) {
    console.error('DB status error:', err);
    await ctx.reply(`❌ Ошибка БД: ${err.message}`);
  }
});

// Добавьте эту команду после других админских команд
bot.command('dump_db', async (ctx) => {
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  if (!pool) {
    console.log('❌ База данных не подключена (используется память)');
    return ctx.reply('❌ База данных не подключена (используется память)');
  }
  
  try {
    console.log('🔍 ===== DUMP DATABASE START =====');
    
    // 1. Информация о подключении
    const client = await pool.connect();
    const dbInfo = await client.query('SELECT current_database(), current_user, current_schema(), version()');
    console.log('📊 Database Info:', dbInfo.rows[0]);
    
    // 2. Список всех таблиц
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    console.log('📋 Tables:', tables.rows.map(r => r.table_name));
    
    // 3. Пользователи бота
    try {
      const users = await client.query('SELECT * FROM bot_users ORDER BY created_at DESC LIMIT 10');
      console.log('👥 Bot Users (last 10):');
      users.rows.forEach((user, index) => {
        console.log(`  ${index + 1}. ID: ${user.user_id}, Name: ${user.first_name}, Username: @${user.username || 'none'}, Created: ${user.created_at}`);
      });
      
      const userCount = await client.query('SELECT COUNT(*) as count FROM bot_users');
      console.log(`👥 Total Users: ${userCount.rows[0].count}`);
    } catch (err) {
      console.log('❌ Error reading bot_users:', err.message);
    }
    
    // 4. Пользовательские имена
    try {
      const userNames = await client.query('SELECT * FROM user_names ORDER BY updated_at DESC LIMIT 10');
      console.log('📝 User Names (last 10):');
      userNames.rows.forEach((name, index) => {
        console.log(`  ${index + 1}. Chat ID: ${name.chat_id}, Name: ${name.custom_name}, Updated: ${name.updated_at}`);
      });
      
      const nameCount = await client.query('SELECT COUNT(*) as count FROM user_names');
      console.log(`📝 Total Custom Names: ${nameCount.rows[0].count}`);
    } catch (err) {
      console.log('❌ Error reading user_names:', err.message);
    }
    
    // 5. Расписания
    try {
      const schedules = await client.query('SELECT * FROM schedules ORDER BY updated_at DESC');
      console.log('📅 Schedules:');
      schedules.rows.forEach((schedule, index) => {
        const data = JSON.parse(schedule.schedule_data);
        console.log(`  ${index + 1}. Address: ${schedule.address}`);
        console.log(`     Slots: ${data.length}`);
        console.log(`     Updated: ${schedule.updated_at}`);
        
        // Показываем первые 3 слота для примера
        if (data.length > 0) {
          console.log('     Sample slots:');
          data.slice(0, 3).forEach((slot, slotIndex) => {
            console.log(`       ${slotIndex + 1}. ${slot.date} ${slot.time} - ${slot.direction}`);
          });
          if (data.length > 3) {
            console.log(`       ... и еще ${data.length - 3} слотов`);
          }
        }
        console.log('');
      });
      
      const scheduleCount = await client.query('SELECT COUNT(*) as count FROM schedules');
      console.log(`📅 Total Schedule Addresses: ${scheduleCount.rows[0].count}`);
    } catch (err) {
      console.log('❌ Error reading schedules:', err.message);
    }
    
    // 6. Размеры таблиц
    try {
      const tableSizes = await client.query(`
        SELECT 
          schemaname,
          tablename,
          attname,
          n_distinct,
          correlation
        FROM pg_stats 
        WHERE schemaname = 'public'
        ORDER BY tablename, attname
      `);
      
      console.log('📊 Table Statistics:');
      let currentTable = '';
      tableSizes.rows.forEach(stat => {
        if (stat.tablename !== currentTable) {
          currentTable = stat.tablename;
          console.log(`  📋 ${stat.tablename}:`);
        }
        console.log(`    - ${stat.attname}: distinct=${stat.n_distinct}, correlation=${stat.correlation}`);
      });
    } catch (err) {
      console.log('❌ Error reading table stats:', err.message);
    }
    
    client.release();
    
    console.log('🔍 ===== DUMP DATABASE END =====');
    
    await ctx.reply('✅ База данных выведена в логи сервера. Проверьте консоль.');
    
  } catch (err) {
    console.error('❌ Error dumping database:', err);
    await ctx.reply(`❌ Ошибка при выводе БД: ${err.message}`);
  }
});

// Также добавьте команду для вывода только расписаний
bot.command('dump_schedules', async (ctx) => {
  if (!(await isAdminUser(ctx))) {
    return ctx.reply('❌ У вас нет прав для выполнения этой команды');
  }
  
  console.log('📅 ===== SCHEDULES DUMP START =====');
  console.log('📊 Global schedules variable:');
  console.log(`Addresses count: ${Object.keys(schedules).length}`);
  
  Object.entries(schedules).forEach(([address, slots], index) => {
    console.log(`\n${index + 1}. 🏢 ${address}:`);
    console.log(`   Slots: ${slots.length}`);
    
    if (slots.length > 0) {
      // Группируем по датам
      const byDate = {};
      slots.forEach(slot => {
        if (!byDate[slot.date]) byDate[slot.date] = [];
        byDate[slot.date].push(slot);
      });
      
      Object.entries(byDate).forEach(([date, dateSlots]) => {
        console.log(`   📅 ${date}: ${dateSlots.length} slots`);
        dateSlots.slice(0, 5).forEach(slot => {
          console.log(`      ${slot.time} - ${slot.direction}`);
        });
        if (dateSlots.length > 5) {
          console.log(`      ... и еще ${dateSlots.length - 5} слотов`);
        }
      });
    }
  });
  
  console.log('📅 ===== SCHEDULES DUMP END =====');
  
  await ctx.reply('✅ Расписания выведены в логи сервера. Проверьте консоль.');
});
