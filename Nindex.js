require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID= process.env.ADMIN_CHAT_ID;
const WEBAPP_URL   = process.env.WEBAPP_URL;
const PORT         = process.env.PORT || 3000;

if (!BOT_TOKEN||!ADMIN_CHAT_ID||!WEBAPP_URL) {
  console.error("Не заданы BOT_TOKEN, ADMIN_CHAT_ID или WEBAPP_URL");
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

// 2) Запись по звонку — запрос контактa
bot.hears('📞 Запись по звонку администратора', ctx => {
  ctx.reply(
    'Пожалуйста, нажмите кнопку, чтобы поделиться контактом, и мы вам перезвоним.',
    Markup.keyboard([
      [ Markup.button.contactRequest('📲 Отправить контакт') ]
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
// 3.5 обработка кнопки выбрать сама
document.getElementById('chooseSelf').onclick = () => {
  data.goal = 'Самостоятельный выбор';
  populateDirs(true); // Передаем флаг для отображения всех направлений
  show('step-3');
};
// 4) Обработка отправки из WebApp
app.post('/submit', async (req, res) => {
  try {
    const { telegram_id, goal, direction, name, phone } = req.body;
    // уведомляем администратора
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `Новая онлайн-заявка:\nЦель: ${goal}\nНаправление: ${direction}\nИмя: ${name}\nТелефон: ${phone}\nПользователь ID: ${telegram_id}`
    );
    // после закрытия формы просим контакт
    await bot.telegram.sendMessage(
      telegram_id,
      'Спасибо! Для подтверждения, пожалуйста, поделитесь контактом.',
      Markup.keyboard([
        [ Markup.button.contactRequest('📲 Отправить контакт') ]
      ]).resize().oneTime()
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});
//добавил хуйню
document.getElementById('chooseSelf').onclick = () => {
  data.goal = 'Самостоятельный выбор';
  populateDirs(true);
  show('step-3');
};

const directionDescriptions = {
  'Классическая хореография': 'Почувствуйте себя настоящей балериной, занимаясь под классическую музыку...',
  'Партерная хореография': 'Эта тренировка начинается на полу, где прорабатывается выворотность...',
  'Барре': 'Энергичная тренировка у станка под современную музыку...',
  'Боди-Балет': 'Кардио с элементами силовых упражнений...',
  'Балетная подкачка': 'Самая интенсивная тренировка в формате круговой программы...',
  'Растяжка': 'Занятие для полноценной проработки тела...',
  'Пилатес': 'Это дыхательная практика с фокусом на глубокие мышцы...',
  'Попа-пресс': 'Интенсивная тренировка для проработки ягодиц и пресса...'
};

function populateDirs(showAll = false) {
  const cont = document.getElementById('options-dir');
  cont.innerHTML = '';
  const list = showAll ? Object.keys(directionDescriptions) : (map[data.goal] || Object.values(map).flat());
  list.forEach(val => {
    const wrapper = document.createElement('div');
    wrapper.className = 'option-wrapper';

    const d = document.createElement('div');
    d.className = 'option';
    d.textContent = val;
    d.dataset.val = val;
    d.onclick = () => {
      document.querySelectorAll('#options-dir .option').forEach(o => o.classList.remove('selected'));
      d.classList.add('selected');
      data.direction = val;
    };

    const infoBtn = document.createElement('button');
    infoBtn.className = 'info-btn';
    infoBtn.textContent = 'ℹ️';
    infoBtn.onclick = (e) => {
      e.stopPropagation();
      alert(directionDescriptions[val]);
    };

    wrapper.appendChild(d);
    wrapper.appendChild(infoBtn);
    cont.appendChild(wrapper);
  });
}

// Запуск
bot.launch().then(() => console.log('Bot started'));
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
