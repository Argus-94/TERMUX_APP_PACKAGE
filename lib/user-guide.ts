/**
 * Полная справка для новичка: как пользоваться AI Builder и всеми основными функциями.
 */

export type UserGuideLang = "uk" | "ru" | "en";

export type UserGuideSection = {
  id: string;
  title: Record<UserGuideLang, string>;
  body: Record<UserGuideLang, string>;
  tags: string[];
};

export const USER_GUIDE: UserGuideSection[] = [
  {
    id: "what-is",
    title: {
      uk: "Що це за додаток",
      ru: "Что это за приложение",
      en: "What this app is",
    },
    body: {
      uk: "AI Builder — помічник на телефоні Android: чат з ШІ та виконання команд у вбудованому приватному Termux-сумісному runtime.\n\nВін може:\n• відповідати на питання й писати код;\n• створювати файли в AIBuilderTermux;\n• виконувати команди у приватній середовищі, коли відповідний runtime готовий;\n• установка пакетів і збірка APK поки недоступні до готовності підписаної приватної поставки та перевірки на пристрої;\n• працювати з GitHub (якщо увімкнено токен).\n\nЦе не «магічна кнопка». Потрібні встановлений AI Builder, доступні функції runtime і зрозуміле завдання в чаті. Окремий Termux не потрібен.",
      ru: "AI Builder — помощник на телефоне Android: чат с ИИ и выполнение команд во встроенной приватной Termux-совместимой среде.\n\nОн умеет:\n• отвечать на вопросы и писать код;\n• создавать файлы в AIBuilderTermux;\n• выполнять команды во встроенной среде, когда соответствующий runtime готов;\n• установка пакетов и сборка APK пока недоступны до готовности подписанной приватной поставки и проверки на устройстве;\n• работать с GitHub (если включён токен).\n\nЭто не «волшебная кнопка». Нужны установленный AI Builder, доступные функции runtime и понятная задача в чате. Отдельный Termux не требуется.",
      en: "AI Builder is an on-device Android helper: AI chat and shell commands in its built-in private Termux-compatible runtime.\n\nIt can:\n• answer questions and write code;\n• create files under /storage/emulated/0/AIBuilderTermux;\n• run commands when the embedded runtime is ready;\n• package installation and APK builds are not yet available pending a signed private feed and on-device qualification;\n• work with GitHub (if a token is enabled).\n\nIt is not a magic button. You need AI Builder, available runtime features, and a clear task in chat. A separate Termux app is not required.",
    },
    tags: ["intro", "что", "overview", "новичок"],
  },
  {
    id: "first-steps",
    title: {
      uk: "Перший запуск — покроково",
      ru: "Первый запуск — пошагово",
      en: "First launch — step by step",
    },
    body: {
      uk: "1) Встановіть APK AI Builder і відкрийте його.\n2) Меню ☰ → Runtime — перевірте вбудоване приватне середовище; окремий Termux не потрібен.\n3) ☰ → Налаштування → оберіть мову (uk/ru/en).\n4) Оберіть модель:\n   • онлайн (OpenRouter / свій API) — потрібен інтернет і ключ;\n   • або офлайн GGUF — завантажте модель і зробіть активною.\n5) ☰ → Runtime — перевірте фактичний стан вбудованого середовища; готовність не передбачається наперед.\n6) Поверніться на головний екран і напишіть просте завдання (див. приклади нижче).\n\nНемає відповіді в чаті → ☰ → Лог.",
      ru: "1) Установите APK AI Builder и откройте его.\n2) Меню ☰ → Runtime — проверьте встроенную приватную среду; отдельный Termux не нужен.\n3) ☰ → Настройки → выберите язык (uk/ru/en).\n4) Выберите модель:\n   • онлайн (OpenRouter / свой API) — нужен интернет и ключ;\n   • или офлайн GGUF — скачайте модель и сделайте активной.\n5) ☰ → Runtime — проверьте фактический статус встроенной среды; готовность не предполагается заранее.\n6) Вернитесь на главный экран и напишите простую задачу (см. примеры ниже).\n\nНет ответа в чате → ☰ → Лог.",
      en: "1) Install the AI Builder APK and open it.\n2) Menu ☰ → Runtime — check the built-in private runtime; no separate Termux app is needed.\n3) ☰ → Settings → pick language (uk/ru/en).\n4) Choose a model:\n   • online (OpenRouter / custom API) — needs internet and a key;\n   • or offline GGUF — download a model and mark it active.\n5) ☰ → Runtime — check the actual embedded runtime status; readiness is not assumed.\n6) Go back to the home screen and type a simple task (see examples below).\n\nNo reply in chat → ☰ → Log.",
    },
    tags: ["start", "setup", "termux", "первый", "запуск"],
  },
  {
    id: "main-chat",
    title: {
      uk: "Головний екран: чат з агентом",
      ru: "Главный экран: чат с агентом",
      en: "Home screen: chat with the agent",
    },
    body: {
      uk: "Це основне місце роботи.\n\n• Поле внизу — ваше завдання звичайною мовою.\n• Надішліть повідомлення → агент планує кроки і виконує команди в Termux.\n• Можна прикріпити файл/фото (меню вкладень).\n• Під час роботи видно індикатори прогресу (збірка, думки агента тощо).\n\nЯк писати завдання:\n• Конкретно: що зробити + де (шлях) + який результат.\n• Краще: «Створи файл /storage/emulated/0/AIBuilderTermux/hello.txt з текстом Hello».\n• Гірше: «зроби щось з файлом» (агент не вгадає шлях).\n\nПісля завершення часто з’являється рядок «Підсумок сесії» (кроки, час, host/proot) — це нормально.",
      ru: "Это основное место работы.\n\n• Поле внизу — ваша задача обычным языком.\n• Отправьте сообщение → агент планирует шаги и выполняет команды во встроенной среде.\n• Можно прикрепить файл/фото (меню вложений).\n• Во время работы видны индикаторы прогресса (сборка, «мысли» агента и т.д.).\n\nКак писать задачу:\n• Конкретно: что сделать + где (путь) + какой результат.\n• Лучше: «Создай файл /storage/emulated/0/AIBuilderTermux/hello.txt с текстом Hello».\n• Хуже: «сделай что-то с файлом» (агент не угадает путь).\n\nПосле завершения часто появляется строка «Итог сессии» (шаги, время, host/proot) — это нормально.",
      en: "This is the main workspace.\n\n• The bottom field is your task in plain language.\n• Send a message → the agent plans steps and runs commands in the private runtime.\n• You can attach a file/photo (attachment menu).\n• Progress indicators appear while it works (build, thinking, etc.).\n\nHow to write a task:\n• Be concrete: what + where (path) + expected result.\n• Better: “Create file /storage/emulated/0/AIBuilderTermux/hello.txt with text Hello”.\n• Worse: “do something with a file” (the agent cannot guess the path).\n\nAfter finishing you often see a “Session summary” line (steps, time, host/proot) — that is expected.",
    },
    tags: ["chat", "чат", "агент", "сообщение", "задача"],
  },
  {
    id: "examples",
    title: {
      uk: "Приклади готових завдань",
      ru: "Примеры готовых задач",
      en: "Ready-made task examples",
    },
    body: {
      uk: "Файли:\n• «Створи в /storage/emulated/0/AIBuilderTermux файл notes.txt з текстом: список покупок»\n• «Покажи вміст /storage/emulated/0/AIBuilderTermux»\n• «Скопіюй /storage/emulated/0/AIBuilderTermux/a.txt у /storage/emulated/0/AIBuilderTermux/backup/a.txt»\n\nКод / скрипти:\n• «Напиши Python-скрипт, який друкує числа 1..10, збережи в /storage/emulated/0/AIBuilderTermux/count.py і запусти»\n• «Створи простий Node-скрипт hello.js у Download і виконай node hello.js»\n\nЗбірка APK:\n• «Збери debug APK з проєкту /storage/emulated/0/AIBuilderTermux/MyApp»\n• «Перевір, чи є gradlew у цій папці, і зроби assembleDebug»\n\nДіагностика:\n• «Перевір, чи встановлені git і python; якщо ні — постав»\n• «Покажи вільне місце на /storage/emulated/0»\n\nАгент сам може підтягнути пакети (auto pkg), якщо в тексті є python/node/gradle тощо.",
      ru: "Файлы:\n• «Создай в /storage/emulated/0/AIBuilderTermux файл notes.txt с текстом: список покупок»\n• «Покажи содержимое /storage/emulated/0/AIBuilderTermux»\n• «Скопируй /storage/emulated/0/AIBuilderTermux/a.txt в /storage/emulated/0/AIBuilderTermux/backup/a.txt»\n\nКод / скрипты:\n• «Напиши Python-скрипт, который печатает числа 1..10, сохрани в /storage/emulated/0/AIBuilderTermux/count.py и запусти»\n• «Создай простой Node-скрипт hello.js в Download и выполни node hello.js»\n\nСборка APK:\n• «Собери debug APK из проекта /storage/emulated/0/AIBuilderTermux/MyApp»\n• «Проверь, есть ли gradlew в этой папке, и сделай assembleDebug»\n\nДиагностика:\n• «Проверь, установлены ли git и python; если нет — поставь»\n• «Покажи свободное место на /storage/emulated/0»\n\nАгент сам может подтянуть пакеты (auto pkg), если в тексте есть python/node/gradle и т.п.",
      en: "Files:\n• “Create notes.txt in Download with text: shopping list”\n• “List /storage/emulated/0/AIBuilderTermux”\n• “Copy /storage/emulated/0/AIBuilderTermux/a.txt to /storage/emulated/0/AIBuilderTermux/backup/a.txt”\n\nCode / scripts:\n• “Write a Python script that prints 1..10, save as /storage/emulated/0/AIBuilderTermux/count.py and run it”\n• “Create a simple Node hello.js in Download and run node hello.js”\n\nAPK build:\n• “Build a debug APK from /storage/emulated/0/AIBuilderTermux/MyApp”\n• “Check for gradlew in that folder and run assembleDebug”\n\nDiagnostics:\n• “Check whether git and python are installed; install if missing”\n• “Show free space on /storage/emulated/0”\n\nThe agent may auto-install packages when the task mentions python/node/gradle, etc.",
    },
    tags: ["examples", "примеры", "задачи", "apk", "python"],
  },
  {
    id: "native-priority",
    title: {
      uk: "Native Priority (швидкий шлях)",
      ru: "Native Priority (быстрый путь)",
      en: "Native Priority (fast path)",
    },
    body: {
      uk: "Де: ☰ → Налаштування → Native Priority.\n\nРежими:\n• auto — прості команди (git, python, ls…) на Termux; «повний Linux» (apt…) — у Ubuntu proot.\n• prefer-termux — якомога більше на Termux (зазвичай швидше).\n• force-proot — майже все в Ubuntu (повільніше, але ближче до класичного Linux).\n\nНавіщо: proot важчий. Fast Path економить час на простих задачах.\n\nДе подивитись ефект: ☰ → Runtime → картка Fast Path (host / proot / hits). Кнопка «Скинути лічильники» обнуляє статистику.",
      ru: "Где: ☰ → Настройки → Native Priority.\n\nРежимы:\n• auto — простые команды (git, python, ls…) в Termux; «полный Linux» (apt…) — в Ubuntu proot.\n• prefer-termux — как можно больше в Termux (обычно быстрее).\n• force-proot — почти всё в Ubuntu (медленнее, но ближе к обычному Linux).\n\nЗачем: proot тяжелее. Fast Path экономит время на простых задачах.\n\nГде увидеть эффект: ☰ → Runtime → карточка Fast Path (host / proot / hits). Кнопка «Сбросить счётчики» обнуляет статистику.",
      en: "Where: ☰ → Settings → Native Priority.\n\nModes:\n• auto — simple commands (git, python, ls…) on Termux; full Linux (apt…) in Ubuntu proot.\n• prefer-termux — prefer Termux whenever safe (usually faster).\n• force-proot — almost everything in Ubuntu (slower, closer to classic Linux).\n\nWhy: proot is heavier. Fast Path saves time on simple tasks.\n\nWhere to see impact: ☰ → Runtime → Fast Path card (host / proot / hits). “Reset counters” clears the stats.",
    },
    tags: ["native", "priority", "fast path", "proot", "termux", "скорость"],
  },
  {
    id: "desktop-mode",
    title: {
      uk: "Desktop Mode",
      ru: "Desktop Mode",
      en: "Desktop Mode",
    },
    body: {
      uk: "Де: ☰ → Налаштування → Desktop Mode.\n\nУвімкніть на планшеті, з клавіатурою або Samsung DeX: контент стає ширшим і центрується, зручніше читати Runtime і налаштування.\nНа звичайному телефоні можна лишити вимкненим (Mobile).",
      ru: "Где: ☰ → Настройки → Desktop Mode.\n\nВключите на планшете, с клавиатурой или Samsung DeX: контент шире и по центру, удобнее Runtime и настройки.\nНа обычном телефоне можно оставить выключенным (Mobile).",
      en: "Where: ☰ → Settings → Desktop Mode.\n\nEnable on a tablet, with a keyboard, or Samsung DeX: wider centered content, easier Runtime and settings.\nOn a normal phone you can leave it off (Mobile).",
    },
    tags: ["desktop", "dex", "tablet", "планшет"],
  },
  {
    id: "runtime",
    title: {
      uk: "Середовище виконання (Runtime)",
      ru: "Среда выполнения (Runtime)",
      en: "Runtime environment",
    },
    body: {
      uk: "☰ → Середовище виконання.\n\nТут видно стан Termux / Ubuntu, сесії, контейнери, Health.\n\nКорисні кнопки:\n• Fast Path — лічильники host/proot;\n• Privilege / Shizuku — перевірка прав (звичайний user / Shizuku / root);\n• Перевірити keystore — чи є ключ підпису APK (~/.aibuilder/keys);\n• Зупинити всі aib-сесії — аварійний стоп фонових задач.\n\nЯкщо агент «завис» — спочатку Stop session у історії чату, потім Stop all aib sessions тут.",
      ru: "☰ → Среда выполнения.\n\nЗдесь виден статус Termux / Ubuntu, сессии, контейнеры, Health.\n\nПолезные кнопки:\n• Fast Path — счётчики host/proot;\n• Privilege / Shizuku — проверка прав (обычный user / Shizuku / root);\n• Проверить keystore — есть ли ключ подписи APK (~/.aibuilder/keys);\n• Остановить все aib-сессии — аварийный стоп фоновых задач.\n\nЕсли агент «завис» — сначала Stop session в истории чата, затем Stop all aib sessions здесь.",
      en: "☰ → Runtime.\n\nShows Termux / Ubuntu status, sessions, containers, Health.\n\nUseful actions:\n• Fast Path — host/proot counters;\n• Privilege / Shizuku — privilege probe (user / Shizuku / root);\n• Check keystore — signing key presence (~/.aibuilder/keys);\n• Stop all aib sessions — emergency stop for background work.\n\nIf the agent is stuck — first Stop session in chat history, then Stop all aib sessions here.",
    },
    tags: ["runtime", "среда", "сессии", "keystore", "shizuku"],
  },
  {
    id: "sessions",
    title: {
      uk: "Чати, історія та ізоляція сесій",
      ru: "Чаты, история и изоляция сессий",
      en: "Chats, history, and session isolation",
    },
    body: {
      uk: "☰ → Історія чатів.\n\n• Кожен чат — окрема розмова.\n• Перемикання чату ізолює runtime-сесію (tmux aib-…).\n• Видалення чату намагається зупинити його сесію.\n• Кнопка ⏹ Stop Session — зупинити поточну роботу агента в цьому чаті.\n\nПорада: для нової великої задачі створюйте новий чат, щоб не змішувати контекст.",
      ru: "☰ → История чатов.\n\n• Каждый чат — отдельный разговор.\n• Переключение чата изолирует runtime-сессию (tmux aib-…).\n• Удаление чата пытается остановить его сессию.\n• Кнопка ⏹ Stop Session — остановить текущую работу агента в этом чате.\n\nСовет: для новой большой задачи создавайте новый чат, чтобы не смешивать контекст.",
      en: "☰ → Chat history.\n\n• Each chat is a separate conversation.\n• Switching chats isolates the runtime session (tmux aib-…).\n• Deleting a chat tries to stop its session.\n• ⏹ Stop Session stops the agent work for that chat.\n\nTip: start a new chat for a new large task so context stays clean.",
    },
    tags: ["history", "session", "чат", "история", "stop"],
  },
  {
    id: "session-replay",
    title: {
      uk: "Session Replay — розбір збоїв",
      ru: "Session Replay — разбор сбоев",
      en: "Session Replay — failure review",
    },
    body: {
      uk: "☰ → Session Replay (якщо пункт є в меню).\n\n• Saved Run Trajectories — збережені прогони: pass/fail, кроки, host/proot.\n• Agent Traces — детальніші сліди.\n• Promoted fixtures → «Повторити»: задача підставляється в поле вводу на головному екрані.\n\nТиповий цикл: помилка → Replay → Повторити → відправити знову з уточненням.",
      ru: "☰ → Session Replay (если пункт есть в меню).\n\n• Saved Run Trajectories — сохранённые прогоны: pass/fail, шаги, host/proot.\n• Agent Traces — более детальные следы.\n• Promoted fixtures → «Повторить»: задача подставляется в поле ввода на главном экране.\n\nТипичный цикл: ошибка → Replay → Повторить → отправить снова с уточнением.",
      en: "☰ → Session Replay (if listed in the menu).\n\n• Saved Run Trajectories — stored runs: pass/fail, steps, host/proot.\n• Agent Traces — richer traces.\n• Promoted fixtures → Retry: the task is filled into the home chat input.\n\nTypical loop: failure → Replay → Retry → send again with a clarification.",
    },
    tags: ["replay", "fixture", "ошибка", "повтор", "trajectory"],
  },
  {
    id: "script-runner",
    title: {
      uk: "Script Runner",
      ru: "Script Runner",
      en: "Script Runner",
    },
    body: {
      uk: "☰ → Script Runner.\n\nЕкран для збережених скриптів збірки/обслуговування:\n• оберіть скрипт або створіть свій;\n• можна ганяти з агентом або напряму;\n• історія запусків і шлях до APK, якщо збірка вдала.\n\nЗручно, коли одна й та сама команда потрібна багато разів.",
      ru: "☰ → Script Runner.\n\nЭкран сохранённых скриптов сборки/обслуживания:\n• выберите скрипт или создайте свой;\n• можно гонять с агентом или напрямую;\n• история запусков и путь к APK при успехе.\n\nУдобно, когда одна и та же команда нужна много раз.",
      en: "☰ → Script Runner.\n\nSaved build/maintenance scripts:\n• pick a script or create your own;\n• run with the agent or directly;\n• run history and APK path on success.\n\nHandy when you repeat the same command often.",
    },
    tags: ["script", "runner", "сборка", "скрипт"],
  },
  {
    id: "settings-models",
    title: {
      uk: "Налаштування: моделі й API",
      ru: "Настройки: модели и API",
      en: "Settings: models and API",
    },
    body: {
      uk: "☰ → Налаштування.\n\n• Мова інтерфейсу.\n• OpenRouter / онлайн-модель — ключ, вибір моделі, «активна».\n• Кастомний API — свій base URL + ключ + model id.\n• Офлайн GGUF — імпорт/завантаження, «завантажити в пам’ять», активна галочка.\n• Параметри генерації (temperature тощо) — за бажанням.\n\nВажливо: у чаті використовується та модель, яку позначено активною.\nДокладніше по кожному пункту — ☰ → Довідка з налаштувань.",
      ru: "☰ → Настройки.\n\n• Язык интерфейса.\n• OpenRouter / онлайн-модель — ключ, выбор модели, «активная».\n• Кастомный API — свой base URL + ключ + model id.\n• Офлайн GGUF — импорт/скачивание, «загрузить в память», активная галочка.\n• Параметры генерации (temperature и т.д.) — по желанию.\n\nВажно: в чате используется модель, отмеченная как активная.\nПодробнее по каждому пункту — ☰ → Справка по настройкам.",
      en: "☰ → Settings.\n\n• UI language.\n• OpenRouter / online model — key, model pick, “active”.\n• Custom API — base URL + key + model id.\n• Offline GGUF — import/download, load into memory, active tick.\n• Generation params (temperature, etc.) — optional.\n\nImportant: chat uses the model marked active.\nPer-setting detail — ☰ → Settings guide.",
    },
    tags: ["settings", "model", "api", "gguf", "openrouter"],
  },
  {
    id: "termux-github",
    title: {
      uk: "Termux, пакети, GitHub",
      ru: "Termux, пакеты, GitHub",
      en: "Termux, packages, GitHub",
    },
    body: {
      uk: "Termux:\n• ☰ → Налаштування Termux — установка APK, Shizuku, Boot за потреби.\n• У шапці «куб» — каталог інструментів.\n\nПакети й збірка:\n• В embedded-private встановлення пакетів і toolchain.ensure недоступні. build.run підтримує лише assembleDebug для перевіреного проєкту AIBuilderTermux, якщо MANAGE_EXTERNAL_STORAGE, SDK/JDK у приватному PREFIX і дистрибутив Gradle вже закешовані; збірка виконується offline. Інакше повертається TOOLCHAIN_UNAVAILABLE із причиною. Нічого не завантажується й немає переходу до зовнішнього backend.\n\nGitHub:\n• ☰ → GitHub — один раз токен у захищене сховище.\n• Далі в чаті: «клонуй репозиторій…», «створи issue…» (якщо інструменти увімкнені в intelligence).",
      ru: "Termux:\n• ☰ → Настройки Termux — установка APK, Shizuku, Boot при необходимости.\n• В шапке «куб» — каталог инструментов.\n\nПакеты и сборка:\n• В embedded-private установка пакетов и toolchain.ensure недоступны. build.run поддерживает только assembleDebug для проверенного проекта AIBuilderTermux, если MANAGE_EXTERNAL_STORAGE, SDK/JDK в приватном PREFIX и дистрибутив Gradle уже закэшированы; сборка идёт offline. Иначе возвращается TOOLCHAIN_UNAVAILABLE с причиной. Ничего не скачивается и нет перехода на внешний backend.\n\nGitHub:\n• ☰ → GitHub — один раз токен в защищённое хранилище.\n• Дальше в чате: «клонируй репозиторий…», «создай issue…» (если tools включены в intelligence).",
      en: "Termux:\n• ☰ → Termux Settings — install APK, Shizuku, Boot if needed.\n• Header: cube = tools catalog.\n\nPackages and builds:\n• In embedded-private, package installation and toolchain.ensure remain unavailable. build.run supports only assembleDebug for a validated AIBuilderTermux project when MANAGE_EXTERNAL_STORAGE, an SDK/JDK inside the private PREFIX, and a cached Gradle distribution are already available; it runs offline. Otherwise it returns TOOLCHAIN_UNAVAILABLE with a reason. Nothing is downloaded and there is no external-backend fallback.\n\nGitHub:\n• ☰ → GitHub — store a token once in the secure vault.\n• Then in chat: “clone repo…”, “create issue…” (if GitHub tools are enabled).",
    },
    tags: ["termux", "pkg", "github", "пакеты", "токен"],
  },
  {
    id: "signing",
    title: {
      uk: "Підпис APK і оновлення",
      ru: "Подпись APK и обновления",
      en: "APK signing and updates",
    },
    body: {
      uk: "Ключ підпису debug/внутрішніх збірок очікується тут:\n$HOME/.aibuilder/keys/aib-debug.keystore\n\n• Один і той самий ключ потрібен, щоб оновлення APK «поверх» зберігали дані (чати, налаштування).\n• Перевірка: Runtime → «Перевірити keystore».\n• ☰ → Ключі підпису — екран керування ключами.\n\nНе створюйте другий випадковий debug-keystore для тієї ж установки — отримаєте конфлікт оновлення.",
      ru: "Ключ подписи debug/внутренних сборок ожидается здесь:\n$HOME/.aibuilder/keys/aib-debug.keystore\n\n• Один и тот же ключ нужен, чтобы обновление APK «поверх» сохраняло данные (чаты, настройки).\n• Проверка: Runtime → «Проверить keystore».\n• ☰ → Ключи подписи — экран управления ключами.\n\nНе создавайте второй случайный debug-keystore для той же установки — будет конфликт обновления.",
      en: "The debug/internal signing key is expected at:\n$HOME/.aibuilder/keys/aib-debug.keystore\n\n• The same key is required so in-place APK upgrades keep data (chats, settings).\n• Check: Runtime → Check keystore.\n• ☰ → Signing keys — key management screen.\n\nDo not generate a second random debug keystore for the same install — upgrades will conflict.",
    },
    tags: ["keystore", "apk", "подпись", "update", "signing"],
  },
  {
    id: "tools-commands",
    title: {
      uk: "Інструменти агента (AIB_TOOL)",
      ru: "Инструменты агента (AIB_TOOL)",
      en: "Agent tools (AIB_TOOL)",
    },
    body: {
      uk: "Агент викликає структуровані інструменти, наприклад:\n• fs.* — файли;\n• pkg.ensure — пакети за профілем (лише підтримуваний selected-backend; embedded-private заблоковано);\n• hardware.probe — діагностика пристрою;\n• runtime.killSession — зупинка aib-сесії;\n• build.run підтримує лише assembleDebug для перевіреного проєкту AIBuilderTermux — offline і лише з уже кешованими приватними SDK/JDK/Gradle; якщо інструментів немає, повертається TOOLCHAIN_UNAVAILABLE;\n• toolchain.ensure та встановлення пакетів недоступні в embedded-private;\n• github.* — GitHub.\n\nВам рідко потрібно писати їх вручну. Довідка з синтаксису: ☰ → Довідка команд.",
      ru: "Агент вызывает структурированные инструменты, например:\n• fs.* — файлы;\n• pkg.ensure — пакеты по профилю (только поддерживаемый selected-backend; embedded-private заблокирован);\n• hardware.probe — диагностика устройства;\n• runtime.killSession — остановка aib-сессии;\n• build.run поддерживает только assembleDebug для проверенного проекта AIBuilderTermux — offline и только с уже кэшированными приватными SDK/JDK/Gradle; если инструментов нет, возвращается TOOLCHAIN_UNAVAILABLE;\n• toolchain.ensure и установка пакетов недоступны в embedded-private;\n• github.* — GitHub.\n\nВам редко нужно писать их вручную. Справка по синтаксису: ☰ → Справка по командам.",
      en: "The agent calls structured tools, for example:\n• fs.* — files;\n• pkg.ensure — package profiles (supported selected-backend only; embedded-private is blocked);\n• hardware.probe — device diagnostics;\n• runtime.killSession — stop an aib session;\n• build.run supports only assembleDebug for a validated AIBuilderTermux project, offline and using only already-cached private SDK/JDK/Gradle; missing tools return TOOLCHAIN_UNAVAILABLE;\n• toolchain.ensure and package installation are unavailable in embedded-private;\n• github.* — GitHub.\n\nYou rarely type these by hand. Syntax help: ☰ → Commands guide.",
    },
    tags: ["tools", "aib_tool", "команды", "pkg.ensure"],
  },
  {
    id: "troubleshooting",
    title: {
      uk: "Якщо щось не працює",
      ru: "Если что-то не работает",
      en: "If something does not work",
    },
    body: {
      uk: "1) Немає відповіді в чаті → ☰ → Лог; перевірте активну модель і інтернет (для онлайн).\n2) Команди блокуються → вбудована середа не готова → Runtime → Health; перевірте діагностику.\n3) «Завис» агент → Історія → Stop Session → Runtime → Stop all aib sessions.\n4) Повільно → Native Priority = auto або prefer-termux; не тримайте force-proot без потреби.\n5) Збірка APK падає → у задачі вкажіть повний шлях проєкту; Runtime → Health; Session Replay.\n6) Після оновлення зникли дані → інший підпис APK (keystore); див. розділ про підпис.\n7) Повтор збою → Session Replay → Повторити → уточніть задачу.\n\nПеревірка на пристрої: файл DEVICE_SMOKE.md у вихідниках релізу (для розробки/тесту).",
      ru: "1) Нет ответа в чате → ☰ → Лог; проверьте активную модель и интернет (для онлайн).\n2) Команды блокируются → встроенная среда не готова → Runtime → Health; проверьте диагностику.\n3) «Завис» агент → История → Stop Session → Runtime → Stop all aib sessions.\n4) Медленно → Native Priority = auto или prefer-termux; не держите force-proot без нужды.\n5) Сборка APK падает → укажите полный путь проекта; Runtime → Health; Session Replay.\n6) После обновления пропали данные → другая подпись APK (keystore); см. раздел про подпись.\n7) Повтор сбоя → Session Replay → Повторить → уточните задачу.\n\nПроверка на устройстве: файл DEVICE_SMOKE.md в исходниках релиза (для разработки/теста).",
      en: "1) No chat reply → ☰ → Log; check active model and internet (online).\n2) Commands blocked → embedded private runtime unavailable → Runtime → Health; review the diagnostic details.\n3) Agent stuck → History → Stop Session → Runtime → Stop all aib sessions.\n4) Slow → Native Priority = auto or prefer-termux; avoid force-proot unless needed.\n5) APK build fails → give full project path; Runtime → Health; Session Replay.\n6) Data lost after upgrade → different APK signature (keystore); see signing section.\n7) Retry a failure → Session Replay → Retry → clarify the task.\n\nOn-device checklist: DEVICE_SMOKE.md in the release sources (for dev/test).",
    },
    tags: ["help", "ошибка", "fix", "troubleshoot", "лог"],
  },
  {
    id: "interceptor",
    title: {
      uk: "Перехоплення трафіку (Interceptor)",
      ru: "Перехват трафика (Interceptor)",
      en: "Traffic interceptor",
    },
    body: {
      uk: "Де: ☰ → Перехоплення трафіку.\n\nДля чого:\nЛокальний proxy/listener усередині AI Builder, щоб бачити HTTP(S)-запити ВАШОГО додатка на ВАШОМУ пристрої, підміняти відповіді для QA і блокувати зайві виклики. Це не «зламати чужий магазин» і не обхід чужих платежів — лише ваші збірки й тестові стенди.\n\nШвидкий старт:\n1) Відкрийте ☰ → Перехоплення трафіку.\n2) Натисніть «Увімкнути перехват» (Start). Дочекайтесь статусу, що listener живий.\n3) Якщо нативний listener недоступний у збірці — порт не слухає; потрібна повна Android-збірка додатка, не «голий» Expo Go.\n4) Вкладка «Трафік» — стрічка запитів (URL, метод, змінені/заблоковані). Пошук по URL/тілу.\n5) Вкладка «Правила» — умови (наприклад urlContains) і дії:\n   • block — заблокувати запит;\n   • mock — підмінити відповідь (status + body JSON);\n   • delay — штучна затримка;\n   • modify — змінити JSON (наприклад $.premium → true).\n6) Готові пресети: premium, success, error500, slowApi, blockAnalytics.\n7) Після тесту вимкніть правило або весь перехват.\n\nHTTPS / MITM (просунуто):\n• Режим «Розшифровувати HTTPS» — окремий opt-in.\n• Потрібно експортувати публічний CA з додатка і ВРУЧНУ встановити сертифікат у систему/профіль користувача.\n• Pinning і жорсткі TLS-перевірки додаток не обходить автоматично.\n• При зміні MITM listener зупиняється — увімкніть його знову.\n\nProxy-налаштування:\n• У налаштуваннях intercept є loopback endpoint і тимчасові credentials.\n• Токен дійсний, поки listener запущений.\n• «Копіювати налаштування proxy» — щоб вказати proxy клієнту/емулятору вручну.\n\nПриклад QA (підміна «успішної покупки» вашого API):\n1) Увімкніть перехват.\n2) Правило: urlContains = billing або /api/purchase (ваш бекенд).\n3) Дія mock: status 200, body {\"orderId\":\"test-1\",\"purchaseState\":0,\"acknowledged\":true}.\n4) Повторіть сценарій у своєму додатку; у стрічці має з’явитись спрацювання правила.\n5) Вимкніть правило.\n\nАгент у чаті:\nМожна попросити скласти правило текстом («зроби правило interceptor: …»). Інструменти interceptor.* допомагають агенту, але вмикати/вимикати live зручніше з екрана Interceptor.\n\nБезпека:\n• Лише ваш пристрій і ваші тести.\n• Не зберігайте реальні паролі/токени в mock-тілах.\n• Після експериментів вимикайте listener.\n\nДокладний приклад також є в ☰ → Довідка по налаштуваннях → розділ про interceptor.",
      ru: "Где: ☰ → Перехват трафика.\n\nДля чего:\nЛокальный proxy/listener внутри AI Builder, чтобы видеть HTTP(S)-запросы ВАШЕГО приложения на ВАШЕМ устройстве, подменять ответы для QA и блокировать лишние вызовы. Это не «взлом чужого магазина» и не обход чужих платежей — только ваши сборки и тестовые стенды.\n\nБыстрый старт:\n1) Откройте ☰ → Перехват трафика.\n2) Нажмите «Включить перехват» (Start). Дождитесь статуса, что listener живой.\n3) Если нативный listener недоступен в сборке — порт не слушает; нужна полная Android-сборка приложения, не «голый» Expo Go.\n4) Вкладка «Трафик» — лента запросов (URL, метод, изменённые/заблокированные). Поиск по URL/телу.\n5) Вкладка «Правила» — условия (например urlContains) и действия:\n   • block — заблокировать запрос;\n   • mock — подменить ответ (status + body JSON);\n   • delay — искусственная задержка;\n   • modify — изменить JSON (например $.premium → true).\n6) Готовые пресеты: premium, success, error500, slowApi, blockAnalytics.\n7) После теста выключите правило или весь перехват.\n\nHTTPS / MITM (продвинуто):\n• Режим «Расшифровывать HTTPS» — отдельный opt-in.\n• Нужно экспортировать публичный CA из приложения и ВРУЧНУЮ установить сертификат в систему/профиль пользователя.\n• Pinning и жёсткие TLS-проверки приложение не обходит автоматически.\n• При смене MITM listener останавливается — включите его снова.\n\nProxy-настройки:\n• В настройках intercept есть loopback endpoint и временные credentials.\n• Токен действует, пока listener запущен.\n• «Копировать настройки proxy» — чтобы указать proxy клиенту/эмулятору вручную.\n\nПример QA (подмена «успешной покупки» вашего API):\n1) Включите перехват.\n2) Правило: urlContains = billing или /api/purchase (ваш бэкенд).\n3) Действие mock: status 200, body {\"orderId\":\"test-1\",\"purchaseState\":0,\"acknowledged\":true}.\n4) Повторите сценарий в своём приложении; в ленте должно появиться срабатывание правила.\n5) Выключите правило.\n\nАгент в чате:\nМожно попросить составить правило текстом («сделай правило interceptor: …»). Инструменты interceptor.* помогают агенту, но включать/выключать live удобнее с экрана Interceptor.\n\nБезопасность:\n• Только ваше устройство и ваши тесты.\n• Не кладите реальные пароли/токены в mock-тела.\n• После экспериментов выключайте listener.\n\nПодробный пример также есть в ☰ → Справка по настройкам → раздел про interceptor.",
      en: "Where: ☰ → Traffic interceptor.\n\nWhat it is:\nA local proxy/listener inside AI Builder so you can see HTTP(S) traffic from YOUR app on YOUR device, mock responses for QA, and block noisy calls. It is not for bypassing third-party stores or payments — only your builds and staging.\n\nQuick start:\n1) Open ☰ → Traffic interceptor.\n2) Tap Start / enable intercept. Wait until the listener is live.\n3) If the native listener is unavailable in the build, nothing listens on the port — you need a full Android build of AI Builder, not plain Expo Go.\n4) Traffic tab — request feed (URL, method, modified/blocked). Search URL/body.\n5) Rules tab — conditions (e.g. urlContains) and actions:\n   • block — block the request;\n   • mock — replace the response (status + JSON body);\n   • delay — artificial latency;\n   • modify — change JSON (e.g. $.premium → true).\n6) Presets: premium, success, error500, slowApi, blockAnalytics.\n7) After testing, disable the rule or the whole interceptor.\n\nHTTPS / MITM (advanced):\n• “Decrypt HTTPS” is a separate opt-in.\n• Export the public CA from the app and MANUALLY install the certificate on the device/user profile.\n• Certificate pinning / strict TLS is not auto-bypassed.\n• Changing MITM stops the listener — start it again.\n\nProxy settings:\n• Interceptor settings show a loopback endpoint and temporary credentials.\n• The token is valid while the listener is running.\n• “Copy proxy settings” helps point a client/emulator at the proxy manually.\n\nQA example (mock a successful purchase on YOUR API):\n1) Enable intercept.\n2) Rule: urlContains = billing or /api/purchase (your backend).\n3) mock action: status 200, body {\"orderId\":\"test-1\",\"purchaseState\":0,\"acknowledged\":true}.\n4) Retry the flow in your app; the feed should show the rule hit.\n5) Disable the rule.\n\nChat agent:\nYou can ask the agent to draft a rule in plain language. interceptor.* tools help, but starting/stopping live mode is easiest on the Interceptor screen.\n\nSafety:\n• Your device and your tests only.\n• Do not put real passwords/tokens into mock bodies.\n• Turn the listener off after experiments.\n\nA full worked example is also in ☰ → Settings guide → interceptor section.",
    },
    tags: ["interceptor", "proxy", "mitm", "перехват", "трафик", "mock", "qa", "правила"],
  },
  {
    id: "menu-map",
    title: {
      uk: "Карта меню ☰",
      ru: "Карта меню ☰",
      en: "Menu ☰ map",
    },
    body: {
      uk: "Типові пункти бічного меню:\n• Головний чат — робота з агентом\n• Історія чатів — сесії й Stop\n• Script Runner — збережені скрипти\n• Runtime — середовище, Fast Path, privilege, keystore\n• Interceptor — перехоплення трафіку (окремий режим)\n• Налаштування — моделі, Native Priority, Desktop Mode\n• Налаштування Termux — дополнительные инструменты устройства\n• GitHub — токен і репозиторії\n• Лог — технічні повідомлення\n• Довідка команд / Довідка налаштувань / Ця повна довідка\n• Про додаток — версія\n\nІконки в шапці: ☰ меню · куб — інструменти.",
      ru: "Типичные пункты бокового меню:\n• Главный чат — работа с агентом\n• История чатов — сессии и Stop\n• Script Runner — сохранённые скрипты\n• Runtime — среда, Fast Path, privilege, keystore\n• Interceptor — перехват трафика (отдельный режим)\n• Настройки — модели, Native Priority, Desktop Mode\n• Настройки Termux — дополнительные инструменты устройства\n• GitHub — токен и репозитории\n• Лог — технические сообщения\n• Справка по командам / Справка по настройкам / Эта полная справка\n• О приложении — версия\n\nИконки в шапке: ☰ меню · куб — инструменты.",
      en: "Typical drawer items:\n• Home chat — agent work\n• Chat history — sessions and Stop\n• Script Runner — saved scripts\n• Runtime — environment, Fast Path, privilege, keystore\n• Interceptor — traffic capture (separate mode)\n• Settings — models, Native Priority, Desktop Mode\n• Termux Settings — optional device tools\n• GitHub — token and repos\n• Log — technical messages\n• Commands guide / Settings guide / This full user guide\n• About — version\n\nHeader icons: ☰ menu · cube — tools.",
    },
    tags: ["menu", "меню", "навигация", "drawer"],
  },
];

export function filterUserGuide(query: string, lang: UserGuideLang): UserGuideSection[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return USER_GUIDE;
  return USER_GUIDE.filter((section) => {
    const title = section.title[lang] || "";
    const body = section.body[lang] || "";
    const tags = section.tags.join(" ");
    return (
      title.toLowerCase().includes(q) ||
      body.toLowerCase().includes(q) ||
      tags.toLowerCase().includes(q) ||
      section.id.toLowerCase().includes(q)
    );
  });
}
