/**
 * Справка по настройкам — актуальные возможности AI Builder.
 */

export type GuideLang = "uk" | "ru" | "en";

export type GuideDownload = {
  label: Record<GuideLang, string>;
  url: string;
  kind?: "model" | "mmproj" | "archive" | "other";
  hint?: Record<GuideLang, string>;
};

export type GuideSection = {
  id: string;
  title: Record<GuideLang, string>;
  body: Record<GuideLang, string>;
  tags: string[];
  downloads?: GuideDownload[];
};

export const SETTINGS_GUIDE: GuideSection[] = [
  {
    id: "start",
    title: {
      uk: "З чого почати",
      ru: "С чего начать",
      en: "Getting started",
    },
    body: {
      uk: "Перевірте вбудований bootstrap і native execution. Готовність shell не доводить готовність пакетів чи збірки. Вбудовані пакети потребують кваліфікованого підписаного private-репозиторію. Зовнішні додатки Termux не використовуються. Проєкти потребують доступу лише до /storage/emulated/0/AIBuilderTermux. Доступ до файлів не доводить готовність shell.\n\nНемає відповіді в чаті — ☰ → Лог.",
      ru: "Проверьте встроенный bootstrap и native execution. Доступность shell не подтверждает готовность пакетов или сборки. Пакеты встроенной среды требуют квалифицированного подписанного private-репозитория. Внешние дополнения Termux не используются. Для проектов требуется доступ только к /storage/emulated/0/AIBuilderTermux. Разрешение файлов не доказывает готовность shell.\n\nНет ответа в чате — ☰ → Лог.",
      en: "Check the bundled bootstrap and native execution. Shell readiness does not establish package or build readiness. Bundled packages require a qualified signed private repository. External Termux add-ons are not used. Projects require access only to /storage/emulated/0/AIBuilderTermux. File access is not shell-readiness evidence.\n\nNo chat reply? ☰ → Log.",
    },
    tags: ["start", "начало", "перший", "first", "старт"],
  },
  {
    id: "header-ui",
    title: {
      uk: "Шапка й меню",
      ru: "Шапка и меню",
      en: "Header and menus",
    },
    body: {
      uk: "На всіх екранах одна шапка AI Builder:\n• ☰ — бічне меню (чат, історія, скрипти, Середовище виконання, налаштування, GitHub, довідки…)\n• куб — праве меню пакетів і інструментів\n\nКнопки дій у додатку оформлені в DarkSlateGray (#2F4F4F).",
      ru: "На всех экранах одна шапка AI Builder:\n• ☰ — боковое меню (чат, история, скрипты, Среда выполнения, настройки, GitHub, справки…)\n• куб — правое меню пакетов и инструментов\n\nКнопки действий в приложении — DarkSlateGray (#2F4F4F).",
      en: "Every screen shares the AI Builder header:\n• ☰ — drawer (chat, history, scripts, Runtime, settings, GitHub, guides…)\n• cube — packages/tools side menu\n\nAction buttons use DarkSlateGray (#2F4F4F).",
    },
    tags: ["header", "меню", "ui", "шапка", "drawer"],
  },
  {
    id: "api-key",
    title: {
      uk: "OpenRouter (онлайн)",
      ru: "OpenRouter (онлайн)",
      en: "OpenRouter (online)",
    },
    body: {
      uk: "Налаштування → онлайн / OpenRouter.\n• Вставте API-ключ (або залиште ключ «з коробки», якщо підставлений).\n• Оберіть модель зі списку або вкажіть ID.\n• Увімкніть «Використовувати як активну», якщо чат має йти через OpenRouter.\n• Потрібен інтернет. Помилки мережі й 401 — у Логу.",
      ru: "Настройки → онлайн / OpenRouter.\n• Вставьте API-ключ (или оставьте ключ «из коробки», если подставлен).\n• Выберите модель из списка или укажите ID.\n• Включите «Использовать как активную», если чат идёт через OpenRouter.\n• Нужен интернет. Ошибки сети и 401 — в Логе.",
      en: "Settings → online / OpenRouter.\n• Paste an API key (or keep the built-in one if present).\n• Pick a model from the list or enter an ID.\n• Enable “Use as active” if chat should use OpenRouter.\n• Needs internet. Network and 401 errors appear in the Log.",
    },
    tags: ["openrouter", "api", "ключ", "online", "онлайн"],
  },
  {
    id: "custom-1",
    title: {
      uk: "Кастомний API №1",
      ru: "Кастомный API №1",
      en: "Custom API #1",
    },
    body: {
      uk: "Свій endpoint (OpenAI-сумісний або інший, який підтримує додаток): base URL, ключ, ім’я моделі. Зручно для локального сервера в мережі або альтернативного провайдера. Зробіть його «активним», щоб чат ходив сюди.",
      ru: "Свой endpoint (OpenAI-совместимый или другой, который поддерживает приложение): base URL, ключ, имя модели. Удобно для локального сервера в сети или другого провайдера. Сделайте его «активным», чтобы чат ходил сюда.",
      en: "Your own endpoint (OpenAI-compatible or another supported by the app): base URL, key, model name. Useful for a LAN server or another provider. Mark it active so chat uses it.",
    },
    tags: ["custom", "api", "кастом"],
  },
  {
    id: "custom-2",
    title: {
      uk: "Кастомний API №2",
      ru: "Кастомный API №2",
      en: "Custom API #2",
    },
    body: {
      uk: "Другий профіль кастомного API — той самий принцип, що №1. Можна тримати «робочий» і «експериментальний» провайдерів і швидко перемикати активний.",
      ru: "Второй профиль кастомного API — тот же принцип, что №1. Можно держать «рабочий» и «экспериментальный» провайдеры и быстро переключать активный.",
      en: "Second custom API profile — same idea as #1. Keep a “production” and an “experimental” provider and switch the active one quickly.",
    },
    tags: ["custom", "api", "кастом", "2"],
  },
  {
    id: "offline-model",
    title: {
      uk: "Офлайн-модель (GGUF)",
      ru: "Офлайн-модель (GGUF)",
      en: "Offline model (GGUF)",
    },
    body: {
      uk: "Налаштування → офлайн:\n1. «Скачати» готову модель або «Імпорт LLM» з файлового менеджера.\n2. Дочекайтесь файлу на диску.\n3. «Завантажити в пам’ять» — без цього чат офлайн не відповість.\n4. Галочка «активна».\nНа слабких телефонах беріть менші квантизації (Q3/Q4). Великий n_ctx потребує більше RAM.",
      ru: "Настройки → офлайн:\n1. «Скачать» готовую модель или «Импорт LLM» из файлового менеджера.\n2. Дождитесь файла на диске.\n3. «Загрузить в память» — без этого офлайн-чат не ответит.\n4. Галочка «активная».\nНа слабых телефонах берите меньшие квантизации (Q3/Q4). Большой n_ctx требует больше RAM.",
      en: "Settings → offline:\n1. Download a ready model or Import LLM from the file picker.\n2. Wait until the file is on disk.\n3. Load into memory — offline chat will not answer without this.\n4. Tick active.\nOn weak phones prefer smaller quantizations (Q3/Q4). Large n_ctx needs more RAM.",
    },
    tags: ["offline", "gguf", "офлайн", "модель", "llama"],
  },
  {
    id: "offline-params",
    title: {
      uk: "Параметри офлайн-моделі",
      ru: "Параметры офлайн-модели",
      en: "Offline model parameters",
    },
    body: {
      uk: "• n_ctx — довжина контексту (історія + відповідь). Більше = краще на довгих діалогах, але їсть RAM.\n• n_threads — ядра CPU; занадто багато може гальмувати UI.\n• n_gpu_layers — зазвичай 0 (стабільніше на різних GPU).\n• temperature / Top-P / max tokens — стиль і довжина.\n\n«Авто» підлаштовує під телефон і файл. «Ручний» — ваші значення; після змін перезавантажте модель у пам’ять.",
      ru: "• n_ctx — длина контекста (история + ответ). Больше = лучше на длинных диалогах, но ест RAM.\n• n_threads — ядра CPU; слишком много может тормозить UI.\n• n_gpu_layers — обычно 0 (стабильнее на разных GPU).\n• temperature / Top-P / max tokens — стиль и длина.\n\n«Авто» подстраивает под телефон и файл. «Ручной» — ваши значения; после изменений перезагрузите модель в память.",
      en: "• n_ctx — context length (history + answer). Higher helps long chats but uses more RAM.\n• n_threads — CPU cores; too many can slow the UI.\n• n_gpu_layers — usually 0 (more stable across GPUs).\n• temperature / Top-P / max tokens — style and length.\n\nAuto tunes for the phone and file. Manual is yours — reload the model after changes.",
    },
    tags: ["n_ctx", "threads", "gpu", "temperature", "параметры", "params"],
  },
  {
    id: "system-prompt",
    title: {
      uk: "Системний промпт",
      ru: "Системный промпт",
      en: "System prompt",
    },
    body: {
      uk: "Глобальні інструкції для моделі (онлайн і офлайн), додаються до вбудованого промпта. Тримайте коротко: довгий текст з’їдає n_ctx.",
      ru: "Глобальные инструкции для модели (онлайн и офлайн), добавляются к встроенному промпту. Держите коротко: длинный текст съедает n_ctx.",
      en: "Global instructions for online and offline models, appended to the built-in prompt. Keep it short — a long prompt burns n_ctx.",
    },
    tags: ["prompt", "промпт", "system"],
  },
  {
    id: "agent-intelligence",
    title: {
      uk: "Інтелект агента",
      ru: "Интеллект агента",
      en: "Agent intelligence",
    },
    body: {
      uk: "Тумблери поведінки: глибина планування, обережність команд, робота з файлами/GitHub тощо. У кожного пункту є підказка «навіщо». Не вмикайте все на слабкому телефоні з важкою офлайн-моделлю.\nПресеты (balanced / coder / careful / apk_build / readonly) вмикають набір опцій одним натиском.",
      ru: "Тумблеры поведения: глубина планирования, осторожность команд, работа с файлами/GitHub и т.д. У каждого пункта есть подсказка «зачем». Не включайте всё на слабом телефоне с тяжёлой офлайн-моделью.\nПресеты в Настройках: Сбалансированный, Кодер, Осторожный, Сборка APK, Только чтение — активный виден (✓), есть «Сбросить». Пресет не запускает сборку сам, только настраивает тумблеры для следующих запросов в сессии.",
      en: "Behaviour toggles: planning depth, command caution, file/GitHub tools, etc. Each row has a “why” hint. Don’t enable everything on a weak phone with a heavy offline model.\nPresets (balanced / coder / careful / apk_build / readonly) apply a profile in one tap.",
    },
    tags: ["agent", "агент", "intelligence", "preset", "пресет"],
  },
  {
    id: "termux-install",
    title: {
      uk: "Вбудоване середовище",
      ru: "Встроенная среда",
      en: "Bundled runtime",
    },
    body: {
      uk: "Перевірте вбудований bootstrap і native execution. Готовність shell не доводить готовність пакетів чи збірки. Вбудовані пакети потребують кваліфікованого підписаного private-репозиторію. Зовнішні додатки Termux не використовуються. Проєкти потребують доступу лише до /storage/emulated/0/AIBuilderTermux. Доступ до файлів не доводить готовність shell.",
      ru: "Проверьте встроенный bootstrap и native execution. Доступность shell не подтверждает готовность пакетов или сборки. Пакеты встроенной среды требуют квалифицированного подписанного private-репозитория. Внешние дополнения Termux не используются. Для проектов требуется доступ только к /storage/emulated/0/AIBuilderTermux. Разрешение файлов не доказывает готовность shell.",
      en: "Check the bundled bootstrap and native execution. Shell readiness does not establish package or build readiness. Bundled packages require a qualified signed private repository. External Termux add-ons are not used. Projects require access only to /storage/emulated/0/AIBuilderTermux. File access is not shell-readiness evidence.",
    },
    tags: ["embedded", "bootstrap", "private", "встроенная среда"],
  },
  {
    id: "termux-session",
    title: {
      uk: "Termux-сесія і консоль",
      ru: "Termux-сессия и консоль",
      en: "Termux session and console",
    },
    body: {
      uk: "Налаштування Termux → увімкнути сесію (або Termux ON на головному екрані). Агент і чат зможуть слати команди.\nКонсоль (кнопка «око»): живий вивід, вкладки Term 1…, поле команди з пріоритетом над чергою агента.\nДовгі збірки: не обмежуйте фон/батарею для AI Builder і Termux; дивіться sticky-сповіщення.",
      ru: "Настройки Termux → включить сессию (или Termux ON на главном экране). Агент и чат смогут слать команды.\nКонсоль (кнопка «глаз»): живой вывод, вкладки Term 1…, поле команды с приоритетом над очередью агента.\nДолгие сборки: не ограничивайте фон/батарею для AI Builder и Termux; смотрите sticky-уведомление.",
      en: "Termux settings → enable the session (or Termux ON on the home screen) so the agent and chat can send commands.\nConsole (eye button): live output, Term 1… tabs, and a command field that jumps the agent queue.\nLong builds: don’t restrict background/battery for AI Builder and Termux; watch the sticky notification.",
    },
    tags: ["termux", "session", "консоль", "console"],
  },
  {
    id: "packages-menu",
    title: {
      uk: "Праве меню: пакети інструментів",
      ru: "Правое меню: пакеты инструментов",
      en: "Tools menu: packages",
    },
    body: {
      uk: "Кнопка «куб» у шапці відкриває каталог: git, curl, zip, python, node, JDK, Android SDK-утиліти тощо.\n\nЯк працює встановлення:\n1. Перевіряється сесія Termux.\n2. Використовуються дзеркало й джерела apt, налаштовані користувачем; додаток не переписує їх.\n3. Спочатку успішно виконується apt-get update, потім apt-get install. Якщо оновлення не вдалося, встановлення зупиняється.\n4. Після встановлення перевіряється, що команда є в PATH.\n\nПеревірте вбудований bootstrap і native execution. Готовність shell не доводить готовність пакетів чи збірки. Вбудовані пакети потребують кваліфікованого підписаного private-репозиторію. Зовнішні додатки Termux не використовуються. Проєкти потребують доступу лише до /storage/emulated/0/AIBuilderTermux. Доступ до файлів не доводить готовність shell.",
      ru: "Кнопка «куб» в шапке открывает каталог: git, curl, zip, python, node, JDK, утилиты Android SDK и т.д.\n\nКак работает установка:\n1. Проверяется сессия Termux.\n2. Используются зеркало и источники apt, настроенные пользователем; приложение их не переписывает.\n3. Сначала успешно выполняется apt-get update, затем apt-get install. Если обновление не удалось, установка останавливается.\n4. После установки проверяется, что команда есть в PATH.\n\nПроверьте встроенный bootstrap и native execution. Доступность shell не подтверждает готовность пакетов или сборки. Пакеты встроенной среды требуют квалифицированного подписанного private-репозитория. Внешние дополнения Termux не используются. Для проектов требуется доступ только к /storage/emulated/0/AIBuilderTermux. Разрешение файлов не доказывает готовность shell.",
      en: "The cube button opens the catalog: git, curl, zip, python, node, JDK, Android SDK tools, etc.\n\nInstall flow:\n1. Check the Termux session.\n2. Use the user's configured apt mirror and sources; the app does not rewrite them.\n3. Require a successful apt-get update before apt-get install; stop installation if the update fails.\n4. Verify the binary is on PATH.\n\nCheck the bundled bootstrap and native execution. Shell readiness does not establish package or build readiness. Bundled packages require a qualified signed private repository. External Termux add-ons are not used. Projects require access only to /storage/emulated/0/AIBuilderTermux. File access is not shell-readiness evidence.",
    },
    tags: ["packages", "пакеты", "apt", "git", "install", "зеркало", "mirror", "куб"],
  },
  {
    id: "runtime-screen",
    title: {
      uk: "Середовище виконання",
      ru: "Среда выполнения",
      en: "Runtime environment",
    },
    body: {
      uk: "☰ → «Середовище виконання» (раніше коротко «Середовище»).\n• Статус runtime і активного проєкту\n• Termux / Ubuntu proot (значки в шапці), підготовка rootfs\n• Діагностика Health, watchdog, відновлення\n• Прив’язка проєкту, сесії, агенти\n\nЯкщо пакети не ставляться через «Testing the available mirrors» — скористайтесь кнопкою виправлення дзеркал на цьому екрані.",
      ru: "☰ → «Среда выполнения» (раньше коротко «Среда»).\n• Статус runtime и активного проекта\n• Termux / Ubuntu proot (значки в шапке сессии), подготовка rootfs\n• Диагностика Health, watchdog, восстановление\n• Привязка проекта, сессии, агенты\n\nЕсли пакеты не ставятся из‑за «Testing the available mirrors» — используйте кнопку исправления зеркал на этом экране.",
      en: "☰ → “Runtime environment” (formerly just “Runtime”).\n• Runtime and active project status\n• Ubuntu via proot-distro, rootfs prep\n• Health diagnostics, watchdog, recovery\n• Project binding, sessions, agents\n\nIf installs fail with “Testing the available mirrors”, use the mirror-fix control on this screen.",
    },
    tags: ["runtime", "среда", "environment", "proot", "ubuntu", "health"],
  },
  {
    id: "github-tool",
    title: {
      uk: "GitHub у додатку",
      ru: "GitHub в приложении",
      en: "In-app GitHub",
    },
    body: {
      uk: "☰ → GitHub (спільна шапка AI Builder).\n1. Вставте personal access token (repo) один раз — зберігається на пристрої, повторно вводити не потрібно.\n2. Список репозиторіїв, дві панелі файлів, навігація назад/вперед по шляху.\n3. Редактор тексту (текст має бути видно на темному тлі), збереження = коміт.\n4. Завантаження з пристрою, скачування, «Упакувати в ZIP», копія/перенос між панелями, видалення.\n5. Якщо «Update is not a fast forward» при переносі — додаток повторить коміт; при потребі оновить гілку.\n\nСкачування: системне збереження / «Поділитися». Потрібен інтернет до api.github.com.",
      ru: "☰ → GitHub — UI-менеджер репозиториев.\n1. Personal access token (scope repo) один раз на устройстве.\n2. Список репо, две панели файлов, редактор, коммит, ZIP, upload/download.\n\nАгент ИИ в чате (Настройки → Интеллект агента → GitHub) умеет инструменты:\n• github.repo, list, tree, read, write — структура и правка файлов;\n• github.commit, commits, branch, branches, tags — история и ветки;\n• github.pr-list, pr-create, pr-files, pr-merge — pull request;\n• github.issue, issue-create, issue-comment, search-issues — issues;\n• github.releases, release, download-asset — релизы и ассеты;\n• github.search, diff, materialize, pack, copy, rename — поиск и упаковка.\n\nПримеры запросов агенту: «покажи tree owner/repo», «создай ветку fix/build», «открой PR в main с описанием». Токен не уходит в логи. Нужен интернет до api.github.com.",
      en: "☰ → GitHub (shared AI Builder header).\n1. Paste a personal access token (repo) once — stored on device, no need to re-enter.\n2. Repo list, dual file panes, back/forward path history.\n3. Text editor (readable on the dark theme); save = commit.\n4. Upload from device, download, “Pack as ZIP”, copy/move between panes, delete.\n5. On “Update is not a fast forward” during moves, the app retries the commit and may force-update the branch.\n\nDownloads use system save / Share. Needs internet to api.github.com.",
    },
    tags: ["github", "git", "token", "репозиторий", "zip", "скачать"],
  },
  {
    id: "shizuku",
    title: {
      uk: "Shizuku",
      ru: "Shizuku",
      en: "Shizuku",
    },
    body: {
      uk: "Опційний підвищений доступ для частини системних операцій. Встановіть Shizuku, запустіть службу (бездротова відладка або root) і надайте дозвіл AI Builder. Без Shizuku базовий чат і Termux-сесія все одно працюють.",
      ru: "Опциональный повышенный доступ для части системных операций. Установите Shizuku, запустите службу (беспроводная отладка или root) и выдайте разрешение AI Builder. Без Shizuku базовый чат и Termux-сессия всё равно работают.",
      en: "Optional elevated access for some system operations. Install Shizuku, start its service (wireless debugging or root), and grant AI Builder permission. Chat and Termux still work without Shizuku.",
    },
    tags: ["shizuku", "adb", "root"],
  },
  {
    id: "background",
    title: {
      uk: "Фон і батарея",
      ru: "Фон и батарея",
      en: "Background and battery",
    },
    body: {
      uk: "Довгі apt/збірки Android може вбити. У системних налаштуваннях: без обмежень батареї для AI Builder і Termux, дозвіл автозапуску/фону за потреби. Sticky-сповіщення показує, що сесія жива.",
      ru: "Долгие apt/сборки Android может убить. В системных настройках: без ограничений батареи для AI Builder и Termux, автозапуск/фон при необходимости. Sticky-уведомление показывает, что сессия жива.",
      en: "Android may kill long apt/builds. In system settings: unrestricted battery for AI Builder and Termux, allow autostart/background if needed. The sticky notification shows the session is alive.",
    },
    tags: ["battery", "background", "фон", "батарея"],
  },
  {
    id: "logs",
    title: {
      uk: "Лог",
      ru: "Лог",
      en: "Log",
    },
    body: {
      uk: "☰ → Лог: мережа, модель, Termux, пакети, GitHub-міст. Перед зверненням по допомогу збережіть або скопіюйте фрагмент з помилкою (exit code, SecurityException, apt).",
      ru: "☰ → Лог: сеть, модель, Termux, пакеты, GitHub-мост. Перед обращением за помощью сохраните или скопируйте фрагмент с ошибкой (exit code, SecurityException, apt).",
      en: "☰ → Log: network, model, Termux, packages, GitHub bridge. Before asking for help, save or copy the error snippet (exit code, SecurityException, apt).",
    },
    tags: ["log", "лог", "debug", "ошибка"],
  },
  {
    id: "permissions",
    title: {
      uk: "Дозволи Android",
      ru: "Разрешения Android",
      en: "Android permissions",
    },
    body: {
      uk: "Перевірте вбудований bootstrap і native execution. Готовність shell не доводить готовність пакетів чи збірки. Вбудовані пакети потребують кваліфікованого підписаного private-репозиторію. Зовнішні додатки Termux не використовуються. Проєкти потребують доступу лише до /storage/emulated/0/AIBuilderTermux. Доступ до файлів не доводить готовність shell.",
      ru: "Проверьте встроенный bootstrap и native execution. Доступность shell не подтверждает готовность пакетов или сборки. Пакеты встроенной среды требуют квалифицированного подписанного private-репозитория. Внешние дополнения Termux не используются. Для проектов требуется доступ только к /storage/emulated/0/AIBuilderTermux. Разрешение файлов не доказывает готовность shell.",
      en: "Check the bundled bootstrap and native execution. Shell readiness does not establish package or build readiness. Bundled packages require a qualified signed private repository. External Termux add-ons are not used. Projects require access only to /storage/emulated/0/AIBuilderTermux. File access is not shell-readiness evidence.",
    },
    tags: ["permissions", "дозволи", "разрешения"],
  },
  {
    id: "theme-ui",
    title: {
      uk: "Тема і мова",
      ru: "Тема и язык",
      en: "Theme and language",
    },
    body: {
      uk: "Темна тема за замовчуванням. Мови інтерфейсу: українська, російська, English — у бічному меню або Налаштуваннях.",
      ru: "Тёмная тема по умолчанию. Языки интерфейса: украинский, русский, English — в боковом меню или Настройках.",
      en: "Dark theme by default. UI languages: Ukrainian, Russian, English — in the drawer or Settings.",
    },
    tags: ["theme", "language", "мова", "язык"],
  },
  {
    id: "quick-checklist",
    title: {
      uk: "Чеклист «нічого не працює»",
      ru: "Чеклист «ничего не работает»",
      en: "Quick “nothing works” checklist",
    },
    body: {
      uk: "Перевірте вбудований bootstrap і native execution. Готовність shell не доводить готовність пакетів чи збірки. Вбудовані пакети потребують кваліфікованого підписаного private-репозиторію. Зовнішні додатки Termux не використовуються. Проєкти потребують доступу лише до /storage/emulated/0/AIBuilderTermux. Доступ до файлів не доводить готовність shell.",
      ru: "Проверьте встроенный bootstrap и native execution. Доступность shell не подтверждает готовность пакетов или сборки. Пакеты встроенной среды требуют квалифицированного подписанного private-репозитория. Внешние дополнения Termux не используются. Для проектов требуется доступ только к /storage/emulated/0/AIBuilderTermux. Разрешение файлов не доказывает готовность shell.",
      en: "Check the bundled bootstrap and native execution. Shell readiness does not establish package or build readiness. Bundled packages require a qualified signed private repository. External Termux add-ons are not used. Projects require access only to /storage/emulated/0/AIBuilderTermux. File access is not shell-readiness evidence.",
    },
    tags: ["troubleshoot", "ошибка", "checklist", "help"],
  },
  {
    id: "interceptor",
    title: {
      uk: "Перехоплення трафіку — повний приклад",
      ru: "Перехват трафика — полный пример",
      en: "Traffic interceptor — full example",
    },
    body: {
      uk: "Лише для тестів ВАШОГО додатка на ВАШОМУ пристрої.\n\nМета прикладу: підмінити JSON відповіді білінгу так, щоб клієнт побачив успішну «покупку» (purchaseState=0) без реального списання — типовий QA-сценарій.\n\nКроки:\n1. ☰ → Перехоплення трафіку → увімкніть proxy / live.\n2. Додайте правило (або пресет «Успішна відповідь» / «Емулювати premium»).\n3. Умова: urlContains = наприклад billing або /api/purchase або host вашого бекенду (не обов'язково Google).\n4. Дія mockResponse: status 200, body JSON на кшталт {\"orderId\":\"test-1\",\"purchaseState\":0,\"acknowledged\":true}.\n   Або modifyBody + jsonPath $.purchaseState → 0 / $.premium → true.\n5. Повторіть запит з додатка; у стрічці intercept переконайтесь, що спрацювало правило.\n6. Вимкніть правило після тесту.\n\nПресети: premium, success, error500, slowApi, blockAnalytics.\nАгент може допомогти скласти правило текстом у чаті (interceptor.*).\nНе використовуйте для обходу чужих платежів чи магазинів — лише власні збірки та стенди.",
      ru: "Только для тестов ВАШЕГО приложения на ВАШЕМ устройстве.\n\nЦель примера: подменить JSON ответа биллинга так, чтобы клиент увидел успешную «покупку» (purchaseState=0) без реального списания — типичный QA-сценарий.\n\nШаги:\n1. ☰ → Перехват трафика → включите proxy / live.\n2. Добавьте правило (или пресет «Успешный ответ» / «Эмулировать premium»).\n3. Условие: urlContains = например billing, /api/purchase или host вашего бэкенда (не обязательно Google).\n4. Действие mockResponse: status 200, body JSON вида {\"orderId\":\"test-1\",\"purchaseState\":0,\"acknowledged\":true}.\n   Или modifyBody + jsonPath $.purchaseState → 0 / $.premium → true.\n5. Повторите запрос из приложения; в ленте intercept проверьте, что правило сработало.\n6. Отключите правило после теста.\n\nПресеты: premium, success, error500, slowApi, blockAnalytics.\nАгент в чате может помочь составить правило (инструменты interceptor.*).\nНе используйте для обхода чужих платежей или магазинов — только свои сборки и стенды.",
      en: "For testing YOUR app on YOUR device only.\n\nExample goal: mock a billing JSON so the client shows a successful purchase (purchaseState=0) without a real charge — a common QA scenario.\n\nSteps:\n1. ☰ → Traffic interceptor → enable proxy / live.\n2. Add a rule (or preset Successful response / Emulate premium).\n3. Condition: urlContains = e.g. billing, /api/purchase, or your backend host.\n4. Action mockResponse: status 200, body like {\"orderId\":\"test-1\",\"purchaseState\":0,\"acknowledged\":true}.\n   Or modifyBody + jsonPath $.purchaseState → 0 / $.premium → true.\n5. Retry from the app; confirm the rule in the intercept feed.\n6. Disable the rule after the test.\n\nPresets: premium, success, error500, slowApi, blockAnalytics.\nThe chat agent can help author rules (interceptor.* tools).\nDo not use this to bypass third-party payments or stores — only your own builds and staging.",
    },
    tags: ["interceptor", "proxy", "mock", "billing", "qa", "перехват", "подмена", "трафик"],
  },
  {
    id: "env-icons",
    title: {
      uk: "Значки середовища в шапці",
      ru: "Значки среды в шапке",
      en: "Environment icons in the header",
    },
    body: {
      uk: "У панелі чату (між Termux ON/OFF і «Новий чат»): керування runtime. Команди агента виконуються лише у вбудованому приватному середовищі.",
      ru: "В панели чата (между Termux ON/OFF и «Новый чат»): управление runtime. Команды агента выполняются только во встроенной приватной среде.",
      en: "Next to the chat controls (or session bar): two icons — Termux and Ubuntu. Active is highlighted. Tap switches the agent environment.",
    },
    tags: ["termux", "ubuntu", "debian", "header", "среда", "шапка"],
  },
  {
    id: "security-policy",
    title: {
      uk: "Політика безпеки команд",
      ru: "Политика безопасности команд",
      en: "Command security policy",
    },
    body: {
      uk: "Команди на пристрої проходять allowlist (Termux / Shizuku / plugin). Небезпечні шаблони блокуються. Деталі — docs/SECURITY_POLICY.md у репозиторії проєкту.",
      ru: "Команды на устройстве проходят allowlist (Termux / Shizuku / plugin). Опасные шаблоны блокируются. Детали — docs/SECURITY_POLICY.md в репозитории проекта.",
      en: "Device commands go through an allowlist (Termux / Shizuku / plugin). Dangerous patterns are blocked. See docs/SECURITY_POLICY.md in the project repo.",
    },
    tags: ["security", "policy", "allowlist", "безпека"],
  },
];

export function filterSettingsGuide(query: string, lang: GuideLang): GuideSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_GUIDE;
  return SETTINGS_GUIDE.filter((s) => {
    const title = s.title[lang].toLowerCase();
    const body = s.body[lang].toLowerCase();
    const tags = s.tags.join(" ").toLowerCase();
    return title.includes(q) || body.includes(q) || tags.includes(q);
  });
}
