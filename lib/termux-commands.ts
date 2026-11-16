export type CommandLang = "uk" | "ru" | "en";

export interface TermuxCommand {
  id: string;
  command: string;
  category: string;
  name: Record<CommandLang, string>;
  description: Record<CommandLang, string>;
}

const cat = {
  files: { uk: "Файли та каталоги", ru: "Файлы и каталоги", en: "Files & directories" },
  text: { uk: "Текст і пошук", ru: "Текст и поиск", en: "Text & search" },
  pkg: { uk: "Пакети Termux", ru: "Пакеты Termux", en: "Termux packages" },
  net: { uk: "Мережа", ru: "Сеть", en: "Network" },
  sys: { uk: "Система", ru: "Система", en: "System" },
  dev: { uk: "Розробка", ru: "Разработка", en: "Development" },
  android: { uk: "Android / пристрій", ru: "Android / устройство", en: "Android / device" },
  archive: { uk: "Архіви", ru: "Архивы", en: "Archives" },
  git: { uk: "Git", ru: "Git", en: "Git" },
  security: { uk: "Безпека / аналіз", ru: "Безопасность / анализ", en: "Security / analysis" },
  agent: { uk: "AI Builder tools", ru: "AI Builder tools", en: "AI Builder tools" },
};

export const TERMUX_COMMAND_CATEGORIES = cat;

export const TERMUX_COMMANDS: TermuxCommand[] = [
  {
    id: "ls",
    command: "ls -la",
    category: "files",
    name: { uk: "Список файлів", ru: "Список файлов", en: "List files" },
    description: {
      uk: "Показати файли та права доступу в поточному каталозі.",
      ru: "Показать файлы и права доступа в текущем каталоге.",
      en: "List files with permissions in the current directory.",
    },
  },
  {
    id: "pwd",
    command: "pwd",
    category: "files",
    name: { uk: "Поточний шлях", ru: "Текущий путь", en: "Current path" },
    description: {
      uk: "Вивести абсолютний шлях поточного каталогу.",
      ru: "Вывести абсолютный путь текущего каталога.",
      en: "Print the absolute path of the current directory.",
    },
  },
  {
    id: "cd",
    command: "cd /storage/emulated/0/Download",
    category: "files",
    name: { uk: "Перейти в каталог", ru: "Перейти в каталог", en: "Change directory" },
    description: {
      uk: "Змінити робочий каталог (приклад — папка Завантаження).",
      ru: "Сменить рабочий каталог (пример — папка Загрузки).",
      en: "Change working directory (example: Downloads).",
    },
  },
  {
    id: "mkdir",
    command: "mkdir -p /storage/emulated/0/AIBuilderTermux/projects/myapp",
    category: "files",
    name: { uk: "Створити каталог", ru: "Создать каталог", en: "Make directory" },
    description: {
      uk: "Створити каталог разом із батьківськими (-p).",
      ru: "Создать каталог вместе с родителями (-p).",
      en: "Create directory including parents (-p).",
    },
  },
  {
    id: "touch",
    command: "touch file.txt",
    category: "files",
    name: { uk: "Створити файл", ru: "Создать файл", en: "Create empty file" },
    description: {
      uk: "Створити порожній файл або оновити час зміни.",
      ru: "Создать пустой файл или обновить время изменения.",
      en: "Create an empty file or update its timestamp.",
    },
  },
  {
    id: "cp",
    command: "cp -r src dest",
    category: "files",
    name: { uk: "Копіювати", ru: "Копировать", en: "Copy" },
    description: {
      uk: "Скопіювати файл або каталог (-r для рекурсії).",
      ru: "Скопировать файл или каталог (-r для рекурсии).",
      en: "Copy a file or directory (-r for recursive).",
    },
  },
  {
    id: "mv",
    command: "mv old.txt new.txt",
    category: "files",
    name: { uk: "Перемістити / перейменувати", ru: "Переместить / переименовать", en: "Move / rename" },
    description: {
      uk: "Перемістити або перейменувати файл.",
      ru: "Переместить или переименовать файл.",
      en: "Move or rename a file.",
    },
  },
  {
    id: "rm",
    command: "rm -rf path",
    category: "files",
    name: { uk: "Видалити", ru: "Удалить", en: "Remove" },
    description: {
      uk: "Видалити файл або каталог. Обережно з -rf!",
      ru: "Удалить файл или каталог. Осторожно с -rf!",
      en: "Delete a file or directory. Be careful with -rf!",
    },
  },
  {
    id: "find",
    command: 'find . -name "*.kt"',
    category: "files",
    name: { uk: "Знайти файли", ru: "Найти файлы", en: "Find files" },
    description: {
      uk: "Пошук файлів за ім’ям у дереві каталогів.",
      ru: "Поиск файлов по имени в дереве каталогов.",
      en: "Search files by name in a directory tree.",
    },
  },
  {
    id: "du",
    command: "du -sh *",
    category: "files",
    name: { uk: "Розмір каталогів", ru: "Размер каталогов", en: "Disk usage" },
    description: {
      uk: "Показати розмір файлів/каталогів.",
      ru: "Показать размер файлов/каталогов.",
      en: "Show size of files/directories.",
    },
  },
  {
    id: "cat",
    command: "cat file.txt",
    category: "text",
    name: { uk: "Показати файл", ru: "Показать файл", en: "Print file" },
    description: {
      uk: "Вивести вміст текстового файлу.",
      ru: "Вывести содержимое текстового файла.",
      en: "Print the contents of a text file.",
    },
  },
  {
    id: "head",
    command: "head -n 20 file.txt",
    category: "text",
    name: { uk: "Початок файлу", ru: "Начало файла", en: "File head" },
    description: {
      uk: "Перші N рядків файлу.",
      ru: "Первые N строк файла.",
      en: "First N lines of a file.",
    },
  },
  {
    id: "tail",
    command: "tail -n 50 file.txt",
    category: "text",
    name: { uk: "Кінець файлу", ru: "Конец файла", en: "File tail" },
    description: {
      uk: "Останні N рядків файлу.",
      ru: "Последние N строк файла.",
      en: "Last N lines of a file.",
    },
  },
  {
    id: "grep",
    command: 'grep -Rni "TODO" .',
    category: "text",
    name: { uk: "Пошук у тексті", ru: "Поиск в тексте", en: "Search in text" },
    description: {
      uk: "Рекурсивний пошук рядка в файлах (ігнор регістру).",
      ru: "Рекурсивный поиск строки в файлах (игнор регистра).",
      en: "Recursive case-insensitive search in files.",
    },
  },
  {
    id: "sed",
    command: "sed -i 's/old/new/g' file.txt",
    category: "text",
    name: { uk: "Заміна в файлі", ru: "Замена в файле", en: "Replace in file" },
    description: {
      uk: "Замінити текст у файлі на місці.",
      ru: "Заменить текст в файле на месте.",
      en: "In-place text replacement in a file.",
    },
  },
  {
    id: "wc",
    command: "wc -l file.txt",
    category: "text",
    name: { uk: "Підрахунок рядків", ru: "Подсчёт строк", en: "Count lines" },
    description: {
      uk: "Кількість рядків/слів/байтів у файлі.",
      ru: "Количество строк/слов/байтов в файле.",
      en: "Count lines/words/bytes in a file.",
    },
  },
  {
    id: "pkg-update",
    command: "yes | pkg update -y && yes | pkg upgrade -y",
    category: "pkg",
    name: { uk: "Оновити пакети", ru: "Обновить пакеты", en: "Update packages" },
    description: {
      uk: "Оновити індекси й установлені пакети Termux та автоматично підтвердити запити пакетного менеджера.",
      ru: "Обновить индексы и установленные пакеты Termux и автоматически подтвердить запросы пакетного менеджера.",
      en: "Update package indexes and installed Termux packages and automatically answer package-manager prompts.",
    },
  },
  {
    id: "pkg-install",
    command: "pkg install git python nodejs -y",
    category: "pkg",
    name: { uk: "Встановити пакети", ru: "Установить пакеты", en: "Install packages" },
    description: {
      uk: "Встановити пакети з репозиторію Termux.",
      ru: "Установить пакеты из репозитория Termux.",
      en: "Install packages from the Termux repository.",
    },
  },
  {
    id: "pkg-search",
    command: "pkg search python",
    category: "pkg",
    name: { uk: "Пошук пакета", ru: "Поиск пакета", en: "Search package" },
    description: {
      uk: "Знайти пакет за назвою або описом.",
      ru: "Найти пакет по имени или описанию.",
      en: "Search packages by name or description.",
    },
  },
  {
    id: "pkg-list",
    command: "pkg list-installed",
    category: "pkg",
    name: { uk: "Встановлені пакети", ru: "Установленные пакеты", en: "Installed packages" },
    description: {
      uk: "Список уже встановлених пакетів.",
      ru: "Список уже установленных пакетов.",
      en: "List already installed packages.",
    },
  },



  {
    id: "curl",
    command: "curl -I https://example.com",
    category: "net",
    name: { uk: "HTTP-запит", ru: "HTTP-запрос", en: "HTTP request" },
    description: {
      uk: "Перевірити відповідь сервера (заголовки).",
      ru: "Проверить ответ сервера (заголовки).",
      en: "Check server response headers.",
    },
  },
  {
    id: "wget",
    command: "wget -O file.zip https://example.com/file.zip",
    category: "net",
    name: { uk: "Завантажити файл", ru: "Скачать файл", en: "Download file" },
    description: {
      uk: "Завантажити файл за URL.",
      ru: "Скачать файл по URL.",
      en: "Download a file from a URL.",
    },
  },
  {
    id: "ping",
    command: "ping -c 4 8.8.8.8",
    category: "net",
    name: { uk: "Ping", ru: "Ping", en: "Ping" },
    description: {
      uk: "Перевірити доступність хоста (4 пакети).",
      ru: "Проверить доступность хоста (4 пакета).",
      en: "Check host reachability (4 packets).",
    },
  },
  {
    id: "ss",
    command: "ss -tulpn",
    category: "net",
    name: { uk: "Відкриті порти", ru: "Открытые порты", en: "Open ports" },
    description: {
      uk: "Показати слухаючі сокети/порти.",
      ru: "Показать слушающие сокеты/порты.",
      en: "Show listening sockets/ports.",
    },
  },
  {
    id: "uname",
    command: "uname -a",
    category: "sys",
    name: { uk: "Інфо про систему", ru: "Инфо о системе", en: "System info" },
    description: {
      uk: "Ядро, архітектура, hostname.",
      ru: "Ядро, архитектура, hostname.",
      en: "Kernel, architecture, hostname.",
    },
  },
  {
    id: "df",
    command: "df -h",
    category: "sys",
    name: { uk: "Вільне місце", ru: "Свободное место", en: "Free disk space" },
    description: {
      uk: "Зайнятість файлових систем.",
      ru: "Занятость файловых систем.",
      en: "Filesystem disk space usage.",
    },
  },
  {
    id: "free",
    command: "free -h",
    category: "sys",
    name: { uk: "Пам’ять", ru: "Память", en: "Memory" },
    description: {
      uk: "Використання RAM (якщо доступно в Termux).",
      ru: "Использование RAM (если доступно в Termux).",
      en: "RAM usage (if available in Termux).",
    },
  },
  {
    id: "ps",
    command: "ps aux",
    category: "sys",
    name: { uk: "Процеси", ru: "Процессы", en: "Processes" },
    description: {
      uk: "Список запущених процесів.",
      ru: "Список запущенных процессов.",
      en: "List running processes.",
    },
  },
  {
    id: "top",
    command: "top -n 1",
    category: "sys",
    name: { uk: "Навантаження", ru: "Нагрузка", en: "Load snapshot" },
    description: {
      uk: "Знімок завантаження CPU/процесів.",
      ru: "Снимок загрузки CPU/процессов.",
      en: "One-shot CPU/process load snapshot.",
    },
  },
  {
    id: "python",
    command: "python -c 'print(1+1)'",
    category: "dev",
    name: { uk: "Python one-liner", ru: "Python one-liner", en: "Python one-liner" },
    description: {
      uk: "Виконати короткий скрипт Python.",
      ru: "Выполнить короткий скрипт Python.",
      en: "Run a short Python snippet.",
    },
  },
  {
    id: "node",
    command: "node -e 'console.log(1+1)'",
    category: "dev",
    name: { uk: "Node one-liner", ru: "Node one-liner", en: "Node one-liner" },
    description: {
      uk: "Виконати короткий JS у Node.js.",
      ru: "Выполнить короткий JS в Node.js.",
      en: "Run a short JS snippet in Node.js.",
    },
  },
  {
    id: "javac",
    command: "javac Main.java && java Main",
    category: "dev",
    name: { uk: "Java compile & run", ru: "Java compile & run", en: "Java compile & run" },
    description: {
      uk: "Скомпілювати й запустити Java-файл (потрібен пакет openjdk).",
      ru: "Скомпилировать и запустить Java-файл (нужен пакет openjdk).",
      en: "Compile and run a Java file (openjdk package required).",
    },
  },
  {
    id: "tar",
    command: "tar -czvf archive.tar.gz folder",
    category: "archive",
    name: { uk: "Створити tar.gz", ru: "Создать tar.gz", en: "Create tar.gz" },
    description: {
      uk: "Запакувати каталог у tar.gz.",
      ru: "Упаковать каталог в tar.gz.",
      en: "Pack a directory into tar.gz.",
    },
  },
  {
    id: "untar",
    command: "tar -xzvf archive.tar.gz",
    category: "archive",
    name: { uk: "Розпакувати tar.gz", ru: "Распаковать tar.gz", en: "Extract tar.gz" },
    description: {
      uk: "Розпакувати архів tar.gz.",
      ru: "Распаковать архив tar.gz.",
      en: "Extract a tar.gz archive.",
    },
  },
  {
    id: "unzip",
    command: "unzip file.zip -d out",
    category: "archive",
    name: { uk: "Розпакувати zip", ru: "Распаковать zip", en: "Unzip" },
    description: {
      uk: "Розпакувати ZIP у каталог.",
      ru: "Распаковать ZIP в каталог.",
      en: "Extract a ZIP into a directory.",
    },
  },
  {
    id: "git-clone",
    command: "git clone https://github.com/user/repo.git",
    category: "git",
    name: { uk: "git clone", ru: "git clone", en: "git clone" },
    description: {
      uk: "Клонувати репозиторій.",
      ru: "Клонировать репозиторий.",
      en: "Clone a repository.",
    },
  },
  {
    id: "git-status",
    command: "git status",
    category: "git",
    name: { uk: "git status", ru: "git status", en: "git status" },
    description: {
      uk: "Стан робочого дерева Git.",
      ru: "Состояние рабочего дерева Git.",
      en: "Show the working tree status.",
    },
  },
  {
    id: "git-log",
    command: "git log --oneline -n 10",
    category: "git",
    name: { uk: "git log", ru: "git log", en: "git log" },
    description: {
      uk: "Останні коміти (короткий формат).",
      ru: "Последние коммиты (короткий формат).",
      en: "Recent commits (short format).",
    },
  },
  {
    id: "jadx",
    command: "jadx -d out app.apk",
    category: "security",
    name: { uk: "jadx decompile", ru: "jadx decompile", en: "jadx decompile" },
    description: {
      uk: "Декомпіляція APK у Java-подібний код.",
      ru: "Декомпиляция APK в Java-подобный код.",
      en: "Decompile an APK to Java-like sources.",
    },
  },
  {
    id: "strings",
    command: "strings binary | head",
    category: "security",
    name: { uk: "strings", ru: "strings", en: "strings" },
    description: {
      uk: "Витягнути читабельні рядки з бінарника.",
      ru: "Извлечь читаемые строки из бинарника.",
      en: "Extract readable strings from a binary.",
    },
  },
  {
    id: "sha256",
    command: "sha256sum file",
    category: "security",
    name: { uk: "SHA-256", ru: "SHA-256", en: "SHA-256" },
    description: {
      uk: "Контрольна сума файлу.",
      ru: "Контрольная сумма файла.",
      en: "File checksum.",
    },
  },
  {
    id: "chmod",
    command: "chmod +x script.sh",
    category: "files",
    name: { uk: "Права виконання", ru: "Права выполнения", en: "Make executable" },
    description: {
      uk: "Зробити скрипт виконуваним.",
      ru: "Сделать скрипт исполняемым.",
      en: "Make a script executable.",
    },
  },
  {
    id: "echo-file",
    command: 'printf "%s\\n" "hello" > file.txt',
    category: "text",
    name: { uk: "Записати в файл", ru: "Записать в файл", en: "Write to file" },
    description: {
      uk: "Записати текст у файл (перезапис).",
      ru: "Записать текст в файл (перезапись).",
      en: "Write text to a file (overwrite).",
    },
  },

  {
    id: "aib-pkg-ensure",
    command: 'AIB_TOOL pkg.ensure {"profile":"base"}',
    category: "agent",
    name: { uk: "pkg.ensure (base)", ru: "pkg.ensure (base)", en: "pkg.ensure (base)" },
    description: {
      uk: "Агент-tool: встановити базовий профіль (git, curl, wget, openssh) через pkg/apt.",
      ru: "Агент-tool: установить базовый профиль (git, curl, wget, openssh) через pkg/apt.",
      en: "Agent tool: install base profile (git, curl, wget, openssh) via pkg/apt.",
    },
  },
  {
    id: "aib-pkg-node",
    command: 'AIB_TOOL pkg.ensure {"profile":"node"}',
    category: "agent",
    name: { uk: "pkg.ensure (node)", ru: "pkg.ensure (node)", en: "pkg.ensure (node)" },
    description: {
      uk: "Агент-tool: Node.js toolchain (nodejs, yarn/npm).",
      ru: "Агент-tool: Node.js toolchain (nodejs, yarn/npm).",
      en: "Agent tool: Node.js toolchain (nodejs, yarn/npm).",
    },
  },
  {
    id: "aib-hardware-probe",
    command: 'AIB_TOOL hardware.probe {"kind":"uname"}',
    category: "agent",
    name: { uk: "hardware.probe", ru: "hardware.probe", en: "hardware.probe" },
    description: {
      uk: "Агент-tool: швидка діагностика пристрою (uname / storage / cpu).",
      ru: "Агент-tool: быстрая диагностика устройства (uname / storage / cpu).",
      en: "Agent tool: quick device diagnostics (uname / storage / cpu).",
    },
  },
  {
    id: "aib-kill-session",
    command: 'AIB_TOOL runtime.killSession {"all":true}',
    category: "agent",
    name: { uk: "runtime.killSession", ru: "runtime.killSession", en: "runtime.killSession" },
    description: {
      uk: "Агент-tool: зупинити всі ізольовані aib-* tmux-сесії.",
      ru: "Агент-tool: остановить все изолированные aib-* tmux-сессии.",
      en: "Agent tool: stop all isolated aib-* tmux sessions.",
    },
  },
];

export function filterTermuxCommands(
  query: string,
  lang: CommandLang
): TermuxCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return TERMUX_COMMANDS;
  return TERMUX_COMMANDS.filter((c) => {
    const hay = [
      c.command,
      c.id,
      c.category,
      c.name[lang],
      c.description[lang],
      TERMUX_COMMAND_CATEGORIES[c.category as keyof typeof TERMUX_COMMAND_CATEGORIES]?.[lang] || "",
    ]
      .join(" ")
      .toLowerCase();
    return q.split(/\s+/).every((part) => hay.includes(part));
  });
}
