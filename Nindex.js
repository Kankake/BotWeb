require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL    = process.env.WEBAPP_URL;
const PORT          = process.env.PORT || 3000;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error('Не заданы BOT_TOKEN, ADMIN_CHAT_ID или WEBAPP_URL');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1) Стартовое меню
bot.start(ctx => {
  ctx.reply(
    'Выберите способ записи:',
    Markup.keyboard([
      ['🖥️ Запись онлайн', '📞 Запись по звонку администратора']
    ]).resize()
  );
});

// 2) Запись по звонку — запрос контакта
bot.hears('📞 Запись по звонку администратора', ctx => {
  ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([
      [Markup.button.contactRequest('📲 Отправить контакт')]
    ]).resize().oneTime()
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

// 3) Онлайн-запись — кнопка WebApp
bot.hears('🖥️ Запись онлайн', ctx => {
  ctx.reply(
    'Заполните онлайн-форму:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Перейти к форме', WEBAPP_URL)
    ])
  );
});

// 4) Обработка отправки из WebApp
app.post('/submit', async (req, res) => {
  try {
    const { telegram_id, goal, direction, name, phone } = req.body;
    // уведомляем администратора
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `Новая онлайн-заявка:\nЦель: ${goal}\nНаправление: ${direction}\nИмя: ${name}\nТелефон: ${phone}\nПользователь ID: ${telegram_id}`
    );
    // после формы запрашиваем контакт для подтверждения
    await bot.telegram.sendMessage(
      telegram_id,
      'Спасибо! Для подтверждения, пожалуйста, поделитесь контактом.',
      Markup.keyboard([
        [Markup.button.contactRequest('📲 Отправить контакт')]
      ]).resize().oneTime()
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка в /submit:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Запуск бота и сервера
(async () => {
  try {
    // Удаляем возможный webhook перед polling
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удалён, переключаемся на polling');
    // Запускаем polling, сбрасывая накопившиеся обновления
    await bot.launch({ dropPendingUpdates: true });
    console.log('🚀 Бот запущен в режиме polling');
  } catch (error) {
    console.error('❌ Ошибка при запуске бота:', error);
    process.exit(1);
  }

  // Запуск HTTP-сервера
  app.listen(PORT, () => console.log(`🌐 Web server listening on port ${PORT}`));
})();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
