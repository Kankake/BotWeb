<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Запись на пробное занятие | LEVITA</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <!-- Шрифт, близкий к тому, что на сайте -->
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-light: #FDF5F9;       /* светло-розовый фон */
      --card-bg: #FFFFFF;        /* белые карточки */
      --text-dark: #272727;      /* графитовый текст */
      --text-muted: #555555;     /* второстепенный текст */
      --accent-gold: #D4AF37;    /* золотой акцент */
      --btn-hover: #b5942c;      /* тёмно-золотой при ховере */
    }

    * { box-sizing: border-box; margin:0; padding:0; }
    html, body { height:100%; }

    body {
      background: var(--bg-light);
      font-family: 'Roboto', sans-serif;
      color: var(--text-dark);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 400px;
    }

    .card {
      background: var(--card-bg);
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      padding: 24px;
      margin-bottom: 20px;
    }

    h1 {
      font-size: 1.5rem;
      text-align: center;
      margin-bottom: 16px;
      color: var(--accent-gold);
    }
    p {
      font-size: 0.95rem;
      margin-bottom: 16px;
      line-height: 1.4;
    }

    .step { display: none; }
    .step.active { display: block; }

    .options {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .option {
      padding: 12px;
      border: 2px solid var(--accent-gold);
      border-radius: 8px;
      text-align: center;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
      background: var(--card-bg);
      color: var(--text-dark);
      font-weight: 500;
    }
    .option.selected {
      background: var(--accent-gold);
      color: var(--card-bg);
    }

    input[type="text"],
    input[type="tel"] {
      width: 100%;
      padding: 12px;
      margin: 8px 0 16px;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 1rem;
    }
    input:focus {
      outline: 2px solid var(--accent-gold);
    }

    .buttons {
      display: flex;
      gap: 12px;
    }
    button {
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      font-weight: 500;
    }
    button.primary {
      background: var(--accent-gold);
      color: var(--card-bg);
      transition: background 0.2s;
    }
    button.primary:hover {
      background: var(--btn-hover);
    }
    button.secondary {
      background: var(--text-muted);
      color: var(--card-bg);
    }
    button.secondary:hover {
      background: #444;
    }

    ul { list-style: none; margin-bottom: 16px; }
    ul li { margin-bottom: 8px; }
    ul b { color: var(--accent-gold); }
  </style>
</head>
<body>
  <div class="container">
    <!-- Шаг 1: Приветствие -->
    <div id="step-1" class="card step active">
      <h1>Добро пожаловать!</h1>
      <p>Мы сеть студий <strong>LEVITA</strong> и с радостью поможем вам достичь вашей цели! Запишитесь сегодня — и получите бесплатное пробное занятие <strong>бесплатно</strong>.</p>
      <div class="buttons">
        <button class="primary" id="startBtn">Далее</button>
      </div>
    </div>

    <!-- Шаг 2: Цель -->
    <div id="step-2" class="card step">
      <h1>Ваша цель</h1>
      <div class="options" id="options-goal">
        <div class="option" data-val="Укрепить тело">Укрепить тело</div>
        <div class="option" data-val="Улучшить мобильность суставов">Улучшить мобильность суставов</div>
        <div class="option" data-val="Поправить осанку">Поправить осанку</div>
        <div class="option" data-val="Убрать лишний вес">Убрать лишний вес</div>
        <div class="option" data-val="Хочу танцевать">Хочу танцевать</div>
      </div>
      <div class="buttons">
        <button class="secondary" id="back2">Назад</button>
        <button class="primary" id="next2">Далее</button>
      </div>
    </div>

    <!-- Шаг 3: Направление -->
    <div id="step-3" class="card step">
      <h1>Выберите направление</h1>
      <div class="options" id="options-dir"></div>
      <div class="buttons">
        <button class="secondary" id="back3">Назад</button>
        <button class="primary" id="next3">Далее</button>
      </div>
    </div>

    <!-- Шаг 4: Контакты -->
    <div id="step-4" class="card step">
      <h1>Ваши контакты</h1>
      <input type="text" id="name" placeholder="Имя" required>
      <input type="tel" id="phone" placeholder="+7 (___) ___-__-__" required>
      <div class="buttons">
        <button class="secondary" id="back4">Назад</button>
        <button class="primary" id="next4">Далее</button>
      </div>
    </div>

    <!-- Шаг 5: Подтверждение -->
    <div id="step-5" class="card step">
      <h1>Проверьте данные</h1>
      <ul>
        <li><b>Цель:</b> <span id="sum-goal"></span></li>
        <li><b>Направление:</b> <span id="sum-dir"></span></li>
        <li><b>Имя:</b> <span id="sum-name"></span></li>
        <li><b>Телефон:</b> <span id="sum-phone"></span></li>
      </ul>
      <div class="buttons">
        <button class="secondary" id="back5">Назад</button>
        <button class="primary" id="submit">Отправить</button>
      </div>
    </div>
  </div>

  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();

    const steps = ['step-1','step-2','step-3','step-4','step-5'];
    let data = {};

    const show = id => {
      steps.forEach(s => document.getElementById(s).classList.remove('active'));
      document.getElementById(id).classList.add('active');
    };

    // Шаг 1 → 2
    document.getElementById('startBtn').onclick = () => show('step-2');

    // Шаг 2 (цель)
    document.querySelectorAll('#options-goal .option').forEach(el => {
      el.onclick = () => {
        document.querySelectorAll('#options-goal .option').forEach(o => o.classList.remove('selected'));
        el.classList.add('selected');
        data.goal = el.dataset.val;
      };
    });
    document.getElementById('next2').onclick = () => data.goal && (populateDirs(), show('step-3'));
    document.getElementById('back2').onclick  = () => show('step-1');

    // Заполнить направления по цели
    const map = {
      'Укрепить тело': ['Барре','Боди-Балет'],
      'Улучшить мобильность суставов': ['Растяжка'],
      'Поправить осанку': ['Классическая хореография','Пилатес'],
      'Убрать лишний вес': ['Барре','Боди-Балет'],
      'Хочу танцевать': ['Классическая хореография']
    };
    function populateDirs() {
      const cont = document.getElementById('options-dir');
      cont.innerHTML = '';
      const list = map[data.goal] || Object.values(map).flat();
      list.forEach(val => {
        const d = document.createElement('div');
        d.className = 'option';
        d.textContent = val;
        d.dataset.val = val;
        d.onclick = () => {
          document.querySelectorAll('#options-dir .option').forEach(o=>o.classList.remove('selected'));
          d.classList.add('selected');
          data.direction = val;
        };
        cont.appendChild(d);
      });
    }
    document.getElementById('next3').onclick = () => data.direction && show('step-4');
    document.getElementById('back3').onclick = () => show('step-2');

    // Шаг 4 (контакты)
    document.getElementById('next4').onclick = () => {
      const name  = document.getElementById('name').value.trim();
      const phone = document.getElementById('phone').value.trim();
      if (!name || !phone) return alert('Пожалуйста, заполните оба поля');
      data.name = name;
      data.phone = phone;
      document.getElementById('sum-goal').textContent = data.goal;
      document.getElementById('sum-dir').textContent = data.direction;
      document.getElementById('sum-name').textContent = name;
      document.getElementById('sum-phone').textContent = phone;
      show('step-5');
    };
    document.getElementById('back4').onclick = () => show('step-3');

    // Шаг 5 (отправка)
    document.getElementById('submit').onclick = async () => {
      const resp = await fetch('/submit', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ telegram_id: tg.initDataUnsafe.user.id, ...data })
      });
      const json = await resp.json();
      if (json.ok) tg.close();
      else alert('Ошибка отправки');
    };
    document.getElementById('back5').onclick = () => show('step-4');
  </script>
</body>
</html>
