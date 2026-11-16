import type { AppLanguage } from "./i18n";

type RuntimeCopyKey =
  | "title" | "supervisor" | "runtimeLabel" | "rootfs" | "schema" | "watchdog" | "watched"
  | "startWatchdog" | "stopWatchdog" | "linuxTermux" | "backend" | "profile" | "available"
  | "notChecked" | "unknown" | "yes" | "no" | "connected" | "unavailable" | "checkingLinux"
  | "checkLinux" | "unameTest" | "bootstrapUbuntu" | "containerManager" | "container" | "none"
  | "ubuntuUserspace" | "working" | "createStartUbuntu" | "installCheckWorkspace" | "buildingWorkspace"
  | "generateBuildTest" | "generatingProject" | "codeBuildTestRepair" | "codingAgent" | "stop" | "remove"
  | "deviceBridge" | "status" | "connectAdb" | "logcat" | "stopSession" | "apkPath" | "packagePath"
  | "installLaunchScreenshotLogcat" | "deviceTestGoal" | "generateRunSuite" | "runSuite" | "selfHealingQa"
  | "releaseGate" | "releaseBundle" | "publishChannel" | "rollbackRelease" | "productionDeploy"
  | "fleetRollout" | "fleetCanary" | "fleetCommandRunning" | "buildVisionFixRunning" | "realAndroidRunning" | "workspaceRunning" | "memoryRunning" | "ack" | "resolve" | "fleetObservability" | "fleetPolicy" | "fleetBackup" | "verifyBackup"
  | "recoverySlo" | "scheduledRecovery" | "unifiedFleet" | "fleetSlo" | "fleetEscalation" | "restoreBackup"
  | "disasterRecovery" | "audit" | "secureAudit" | "exportAudit" | "createSnapshot" | "restoreSnapshot"
  | "fleetCommand" | "deploy" | "rollback" | "buildVisionFix" | "realAndroid" | "workspace"
  | "workspaceStatus" | "checkpoint" | "snapshot" | "undoLast" | "aiMemory" | "recordBuild" | "recordTest"
  | "factory" | "appProjectName" | "describeApp" | "factoryRunning" | "factoryRun" | "activeProject"
  | "id" | "name" | "path" | "bindActive" | "sessions" | "processes" | "containers" | "images"
  | "agents" | "toolchains" | "privilege" | "native" | "recovery" | "finalValidation" | "backupRestore"
  | "backupDirectory" | "createFullBackup" | "restore" | "diagnostics" | "noData" | "runningDevice" | "selfHealingRunning" | "releaseGateRunning" | "releaseBundleRunning" | "releaseChannel" | "publishingChannel" | "rollingBack" | "productionDeploying" | "fleetDeploying" | "fleetCanaryRunning" | "fleetObservabilityRunning" | "fleetRole" | "productionPhrase" | "saveFleetPolicy" | "backupSecret" | "unifiedControlRunning" | "fleetEscalationRunning" | "fleetSloRunning" | "health" | "runHealth" | "repairAll" | "healthHint" | "userspaceRuntime" | "probeBackends"| "userspaceHint" | "startupTrace" | "noStartupTrace"| "supervisorHelp" | "linuxHelp" | "linuxWhat" | "linuxYesDetail" | "linuxNoDetail"| "linuxNeedCheck" | "linuxInstallHint" | "containerHelp" | "pressCheckFirst"| "watchdogHelp" | "statusOk" | "statusBad" | "statusUnknown";

const copy: Record<RuntimeCopyKey, Record<AppLanguage, string>> = {
  title: { ru: "Среда выполнения", uk: "Середовище виконання", en: "Runtime environment" },
  supervisor: { ru: "Супервизор среды", uk: "Супервізор середовища", en: "Runtime supervisor" },
  runtimeLabel: { ru: "Среда выполнения", uk: "Середовище виконання", en: "Runtime environment" },
  rootfs: { ru: "Rootfs", uk: "Rootfs", en: "Rootfs" },
  schema: { ru: "Схема", uk: "Схема", en: "Schema" },
  watchdog: { ru: "Сторож", uk: "Сторож", en: "Watchdog" },
  watched: { ru: "под наблюдением", uk: "під наглядом", en: "watched" },
  startWatchdog: { ru: "Запустить сторож", uk: "Запустити сторож", en: "Start watchdog" },
  stopWatchdog: { ru: "Остановить сторож", uk: "Зупинити сторож", en: "Stop watchdog" },
  linuxTermux: { ru: "Linux / Termux", uk: "Linux / Termux", en: "Linux / Termux" },
  backend: { ru: "Система", uk: "Система", en: "Backend" },
  profile: { ru: "Профиль", uk: "Профіль", en: "Profile" },
  available: { ru: "Доступно", uk: "Доступно", en: "Available" },
  notChecked: { ru: "не проверено", uk: "не перевірено", en: "not checked" },
  unknown: { ru: "неизвестно", uk: "невідомо", en: "unknown" },
  yes: { ru: "да", uk: "так", en: "yes" },
  no: { ru: "нет", uk: "ні", en: "no" },
  connected: { ru: "подключено", uk: "підключено", en: "connected" },
  unavailable: { ru: "недоступно", uk: "недоступно", en: "unavailable" },
  checkingLinux: { ru: "Проверка Linux…", uk: "Перевірка Linux…", en: "Checking Linux…" },
  checkLinux: { ru: "Проверить Linux", uk: "Перевірити Linux", en: "Check Linux Runtime" },
  unameTest: { ru: "Тест uname", uk: "Тест uname", en: "Run uname test" },
  bootstrapUbuntu: { ru: "Настроить Ubuntu", uk: "Налаштувати Ubuntu", en: "Bootstrap Ubuntu" },
  containerManager: { ru: "Контейнер / proot", uk: "Контейнер / proot", en: "Container Manager / proot" },
  container: { ru: "Контейнер", uk: "Контейнер", en: "Container" },
  none: { ru: "нет", uk: "немає", en: "none" },
  ubuntuUserspace: { ru: "Ubuntu, проект в /workspace; root не нужен.", uk: "Ubuntu, проєкт у /workspace; root не потрібен.", en: "Ubuntu userspace, project at /workspace; no root required." },
  working: { ru: "Выполнение…", uk: "Виконується…", en: "Working…" },
  createStartUbuntu: { ru: "Создать и запустить Ubuntu", uk: "Створити й запустити Ubuntu", en: "Create + Start Ubuntu Container" },
  installCheckWorkspace: { ru: "Установить и проверить", uk: "Встановити й перевірити", en: "Install + Check Workspace" },
  buildingWorkspace: { ru: "Сборка среды…", uk: "Збірка середовища…", en: "Building workspace…" },
  generateBuildTest: { ru: "Создать → собрать → тест", uk: "Створити → зібрати → тест", en: "Generate → Build → Test" },
  generatingProject: { ru: "Создание проекта…", uk: "Створення проєкту…", en: "Generating project…" },
  codeBuildTestRepair: { ru: "Код → сборка → тест → исправление", uk: "Код → збірка → тест → виправлення", en: "Code → Build → Test → Repair" },
  codingAgent: { ru: "ИИ-агент пишет код…", uk: "ШІ-агент пише код…", en: "AI coding agent running…" },
  stop: { ru: "Стоп", uk: "Стоп", en: "Stop" },
  remove: { ru: "Удалить", uk: "Видалити", en: "Remove" },
  deviceBridge: { ru: "Устройство / ADB", uk: "Пристрій / ADB", en: "Device / ADB bridge" },
  status: { ru: "Статус", uk: "Статус", en: "Status" },
  connectAdb: { ru: "Подключить ADB", uk: "Підключити ADB", en: "Connect ADB device" },
  logcat: { ru: "Logcat", uk: "Logcat", en: "Logcat" },
  stopSession: { ru: "Остановить сессию", uk: "Зупинити сесію", en: "Stop session" },
  apkPath: { ru: "Путь к APK для Termux", uk: "Шлях до APK для Termux", en: "APK path visible to Termux" },
  packagePath: { ru: "com.example.app (необязательно)", uk: "com.example.app (необов’язково)", en: "com.example.app (optional)" },
  installLaunchScreenshotLogcat: { ru: "Установить → запустить → скриншот → Logcat", uk: "Встановити → запустити → скриншот → Logcat", en: "Install → Launch → Screenshot → Logcat" },
  deviceTestGoal: { ru: "Цель теста устройства", uk: "Мета тесту пристрою", en: "AI device test goal" },
  generateRunSuite: { ru: "Создать и запустить тесты", uk: "Створити й запустити тести", en: "Generate & Run Test Suite" },
  runSuite: { ru: "ИИ: запуск тестов…", uk: "ШІ: запуск тестів…", en: "AI Planner → Run Suite…" },
  selfHealingQa: { ru: "Самоисправление QA", uk: "Самовиправлення QA", en: "AI Self-Healing QA" },
  releaseGate: { ru: "Контроль релиза", uk: "Контроль релізу", en: "AI Release Gate" },
  releaseBundle: { ru: "Пакет релиза", uk: "Пакет релізу", en: "AI Release Bundle" },
  publishChannel: { ru: "Опубликовать канал", uk: "Опублікувати канал", en: "Publish Release Channel" },
  rollbackRelease: { ru: "Откатить релиз", uk: "Відкотити реліз", en: "Rollback Previous Release" },
  productionDeploy: { ru: "Релиз + проверка + автооткат", uk: "Реліз + перевірка + авто-відкат", en: "Deploy + Health Check + Auto-Rollback" },
  fleetRollout: { ru: "Развернуть на устройства", uk: "Розгорнути на пристрої", en: "Fleet Rollout + Per-Device Rollback" },
  fleetCanary: { ru: "Канарейка 10% → 25% → 100%", uk: "Канарейка 10% → 25% → 100%", en: "Fleet Canary 10% → 25% → 100%" },
  fleetCommandRunning: { ru: "Центр управления флотом…", uk: "Центр керування флотом…", en: "AI Fleet Command Center…" },
  buildVisionFixRunning: { ru: "Сборка → Vision → исправление…", uk: "Збірка → Vision → виправлення…", en: "AI Build → Vision → Fix…" },
  realAndroidRunning: { ru: "Интеграция с Android…", uk: "Інтеграція з Android…", en: "Real Android integration…" },
  workspaceRunning: { ru: "Среда…", uk: "Середовище…", en: "Workspace…" },
  memoryRunning: { ru: "Память…", uk: "Пам’ять…", en: "Memory…" },
  ack: { ru: "Подтвердить", uk: "Підтвердити", en: "ACK" },
  resolve: { ru: "Закрыть", uk: "Закрити", en: "RESOLVE" },
  fleetObservability: { ru: "Наблюдение + инциденты", uk: "Спостереження + інциденти", en: "Fleet Observability + Incidents" },
  fleetPolicy: { ru: "Политика флота", uk: "Політика флоту", en: "Fleet Policy" },
  fleetBackup: { ru: "Создать зашифрованную копию", uk: "Створити зашифровану копію", en: "Create Encrypted Fleet Backup" },
  verifyBackup: { ru: "Проверить последнюю копию", uk: "Перевірити останню копію", en: "Verify Latest Backup" },
  recoverySlo: { ru: "SLO восстановления", uk: "SLO відновлення", en: "Recovery SLO & Schedule" },
  scheduledRecovery: { ru: "Запустить плановую проверку", uk: "Запустити планову перевірку", en: "Run Scheduled Recovery Check" },
  unifiedFleet: { ru: "Единый центр флота", uk: "Єдиний центр флоту", en: "Unified Fleet Control Center" },
  fleetSlo: { ru: "SLO и центр алертов", uk: "SLO та центр сповіщень", en: "Fleet SLO & Alert Center" },
  fleetEscalation: { ru: "Эскалация алертов", uk: "Ескалація сповіщень", en: "Fleet Alert Escalation" },
  restoreBackup: { ru: "Восстановить последнюю копию", uk: "Відновити останню копію", en: "Restore Latest Backup" },
  disasterRecovery: { ru: "Тест восстановления (только стенд)", uk: "Тест відновлення (лише стенд)", en: "Disaster Recovery Drill (Staging Only)" },
  audit: { ru: "Аудит", uk: "Аудит", en: "Audit" },
  secureAudit: { ru: "Проверить защищённый аудит", uk: "Перевірити захищений аудит", en: "Secure Audit Verify" },
  exportAudit: { ru: "Экспорт аудита", uk: "Експорт аудиту", en: "Export Audit Bundle" },
  createSnapshot: { ru: "Создать снимок восстановления", uk: "Створити знімок відновлення", en: "Create Recovery Snapshot" },
  restoreSnapshot: { ru: "Восстановить последний снимок", uk: "Відновити останній знімок", en: "Restore Last Snapshot" },
  fleetCommand: { ru: "Центр управления флотом", uk: "Центр керування флотом", en: "Fleet Command Center" },
  deploy: { ru: "Развернуть", uk: "Розгорнути", en: "Deploy" },
  rollback: { ru: "Откат", uk: "Відкат", en: "Rollback" },
  buildVisionFix: { ru: "Сборка → установка → Vision → исправление", uk: "Збірка → встановлення → Vision → виправлення", en: "Build → Install → Vision → Fix" },
  realAndroid: { ru: "Интеграция с Android", uk: "Інтеграція з Android", en: "Real Android Device Integration" },
  workspace: { ru: "Рабочая среда", uk: "Робоче середовище", en: "Workspace" },
  workspaceStatus: { ru: "Статус среды", uk: "Статус середовища", en: "Workspace Status" },
  checkpoint: { ru: "Точка сохранения", uk: "Точка збереження", en: "Checkpoint" },
  snapshot: { ru: "Снимок", uk: "Знімок", en: "Snapshot" },
  undoLast: { ru: "Отменить последнее", uk: "Скасувати останнє", en: "Undo Last" },
  aiMemory: { ru: "Память ИИ", uk: "Пам’ять ШІ", en: "AI Memory" },
  recordBuild: { ru: "Записать сборку", uk: "Записати збірку", en: "Record Build" },
  recordTest: { ru: "Записать тест", uk: "Записати тест", en: "Record Test" },
  factory: { ru: "Фабрика приложений", uk: "Фабрика додатків", en: "One-Click App Factory" },
  appProjectName: { ru: "Название приложения / проекта", uk: "Назва додатка / проєкту", en: "App/project name" },
  describeApp: { ru: "Опишите приложение", uk: "Опишіть додаток", en: "Describe the app you want" },
  factoryRunning: { ru: "Фабрика: проект → код → APK…", uk: "Фабрика: проєкт → код → APK…", en: "Factory: project → code → APK…" },
  factoryRun: { ru: "Запустить фабрику", uk: "Запустити фабрику", en: "One-Click App Factory" },
  activeProject: { ru: "Активный проект", uk: "Активний проєкт", en: "Active project" },
  id: { ru: "ID", uk: "ID", en: "ID" },
  name: { ru: "Название", uk: "Назва", en: "Name" },
  path: { ru: "Путь", uk: "Шлях", en: "Path" },
  bindActive: { ru: "Привязать к среде", uk: "Прив’язати до середовища", en: "Bind to Runtime" },
  sessions: { ru: "Сессии", uk: "Сесії", en: "Sessions" },
  processes: { ru: "Процессы", uk: "Процеси", en: "Processes" },
  containers: { ru: "Контейнеры", uk: "Контейнери", en: "Containers" },
  images: { ru: "Образы", uk: "Образи", en: "Images" },
  agents: { ru: "Агенты", uk: "Агенти", en: "Agents" },
  toolchains: { ru: "Инструменты", uk: "Інструменти", en: "Toolchains" },
  privilege: { ru: "Права", uk: "Права", en: "Privilege" },
  native: { ru: "Native", uk: "Native", en: "Native" },
  recovery: { ru: "Восстановление", uk: "Відновлення", en: "Recovery" },
  finalValidation: { ru: "Итоговая проверка", uk: "Фінальна перевірка", en: "Final validation" },
  backupRestore: { ru: "Копия / восстановление", uk: "Копія / відновлення", en: "Backup / Restore" },
  backupDirectory: { ru: "Папка резервной копии", uk: "Папка резервної копії", en: "Backup directory" },
  createFullBackup: { ru: "Создать полную копию", uk: "Створити повну копію", en: "Create full backup" },
  restore: { ru: "Восстановить", uk: "Відновити", en: "Restore" },
  diagnostics: { ru: "Диагностика", uk: "Діагностика", en: "Diagnostics" },
  noData: { ru: "Нет данных", uk: "Немає даних", en: "No data" },
  runningDevice: { ru: "Запуск теста устройства…", uk: "Запуск тесту пристрою…", en: "Running device loop…" },
  selfHealingRunning: { ru: "Самоисправление QA…", uk: "Самовиправлення QA…", en: "AI Self-Healing QA…" },
  releaseGateRunning: { ru: "Проверка релиза…", uk: "Перевірка релізу…", en: "AI Release Gate…" },
  releaseBundleRunning: { ru: "Создание пакета…", uk: "Створення пакета…", en: "AI Release Bundle…" },
  publishingChannel: { ru: "Публикация канала…", uk: "Публікація каналу…", en: "Publishing channel…" },
  rollingBack: { ru: "Откат…", uk: "Відкат…", en: "Rolling back…" },
  productionDeploying: { ru: "Развёртывание…", uk: "Розгортання…", en: "AI Production Deploy…" },
  fleetDeploying: { ru: "Развёртывание на устройства…", uk: "Розгортання на пристрої…", en: "AI Device Fleet…" },
  fleetCanaryRunning: { ru: "Канарейка…", uk: "Канарейка…", en: "AI Fleet Canary…" },
  fleetObservabilityRunning: { ru: "Загрузка наблюдения…", uk: "Завантаження спостереження…", en: "AI Fleet Observability…" },
  releaseChannel: { ru: "Канал релиза: debug / internal / beta / production", uk: "Канал релізу: debug / internal / beta / production", en: "Release channel: debug / internal / beta / production" },
  fleetRole: { ru: "Роль: viewer / operator / release-manager / admin", uk: "Роль: viewer / operator / release-manager / admin", en: "Fleet role: viewer / operator / release-manager / admin" },
  productionPhrase: { ru: "Фраза подтверждения релиза", uk: "Фраза підтвердження релізу", en: "Production confirmation phrase" },
  saveFleetPolicy: { ru: "Сохранить политику", uk: "Зберегти політику", en: "Save Fleet Policy" },
  backupSecret: { ru: "Секрет копии (12+ символов; не сохраняется)", uk: "Секрет копії (12+ символів; не зберігається)", en: "Backup secret (12+ chars; never stored)" },
  unifiedControlRunning: { ru: "Единый центр…", uk: "Єдиний центр…", en: "AI Unified Control Center…" },
  fleetSloRunning: { ru: "SLO флота…", uk: "SLO флоту…", en: "AI Fleet SLO & Alert Center" },
  fleetEscalationRunning: { ru: "Эскалация…", uk: "Ескалація…", en: "AI Fleet Alert Escalation…" },
  health: { ru: "Здоровье", uk: "Здоров'я", en: "Health" },
  runHealth: { ru: "Проверить", uk: "Перевірити", en: "Run health" },
  repairAll: { ru: "Исправить всё", uk: "Виправити все", en: "Repair all" },
  healthHint: {
    ru: "Проверка Termux, Java/Gradle/Node, userspace. «Исправить всё» — только allowlisted-рецепты.",
    uk: "Перевірка Termux, Java/Gradle/Node, userspace. «Виправити все» — лише дозволені рецепти.",
    en: "Probes Termux, Java/Gradle/Node, userspace. Repair all runs allowlisted recipes only.",
  },
  userspaceRuntime: { ru: "Userspace runtime", uk: "Userspace runtime", en: "Userspace runtime" },
  probeBackends: { ru: "Проверить бэкенды", uk: "Перевірити бекенди", en: "Probe backends" },
  userspaceHint: {
    ru: "termux-native + proot-distro (открытая альтернатива proroot)",
    uk: "termux-native + proot-distro (відкрита альтернатива proroot)",
    en: "termux-native + proot-distro (open alternative to proroot)",
  },
  startupTrace: { ru: "Последний старт", uk: "Останній старт", en: "Last startup" },
  noStartupTrace: { ru: "Нет сохранённых загрузок", uk: "Немає збережених завантажень", en: "No saved boots" },
  supervisorHelp: {
    ru: "Следит за фоновыми процессами среды (контейнеры, агент). Не путать с Termux.",
    uk: "Стежить за фоновими процесами середовища. Не плутати з Termux.",
    en: "Watches runtime background processes (containers, agent). Not the same as Termux.",
  },
  watchdogHelp: {
    ru: "Сторож периодически проверяет процессы с флагом watchdog. Запустите, если идут долгие задачи.",
    uk: "Вартовий періодично перевіряє процеси з прапорцем watchdog. Увімкніть для довгих задач.",
    en: "Periodically checks processes flagged for watchdog. Start it for long-running jobs.",
  },
  linuxHelp: {
    ru: "Это НЕ отдельный Linux на телефоне. Это Ubuntu внутри Termux через proot (без root). Нужен для полноценного apt/glibc, когда не хватает пакетов Termux.",
    uk: "Це НЕ окремий Linux на телефоні. Це Ubuntu всередині Termux через proot (без root).",
    en: "This is NOT a full Linux install. It is Ubuntu inside Termux via proot (no root). Use when Termux packages are not enough.",
  },
  linuxWhat: {
    ru: "Что это?",
    uk: "Що це?",
    en: "What is this?",
  },
  linuxYesDetail: {
    ru: "Linux-userspace доступен (proot-distro или proot+rootfs).",
    uk: "Linux-userspace доступний.",
    en: "Linux userspace is available (proot-distro or proot+rootfs).",
  },
  linuxNoDetail: {
    ru: "Нет proot-distro. В Termux: pkg install proot-distro, затем «Настроить Ubuntu».",
    uk: "Немає proot-distro. У Termux: pkg install proot-distro.",
    en: "No proot-distro. In Termux: pkg install proot-distro, then Bootstrap Ubuntu.",
  },
  linuxNeedCheck: {
    ru: "Ещё не проверяли. Нажмите «Проверить Linux».",
    uk: "Ще не перевіряли. Натисніть «Перевірити Linux».",
    en: "Not checked yet. Tap “Check Linux”.",
  },
  linuxInstallHint: {
    ru: "Сначала установите proot-distro в Termux, иначе кнопка «Настроить Ubuntu» неактивна.",
    uk: "Спочатку встановіть proot-distro в Termux.",
    en: "Install proot-distro in Termux first; otherwise Bootstrap stays disabled.",
  },
  containerHelp: {
    ru: "Изолированный Ubuntu для проекта: код монтируется в /workspace. Удобно собирать нативные вещи отдельно от Termux.",
    uk: "Ізольований Ubuntu для проєкту: код у /workspace.",
    en: "Isolated Ubuntu for a project; code is mounted at /workspace.",
  },
  pressCheckFirst: {
    ru: "Сначала нажмите «Проверить Linux»",
    uk: "Спочатку натисніть «Перевірити Linux»",
    en: "Tap “Check Linux” first",
  },
  statusOk: { ru: "OK", uk: "OK", en: "OK" },
  statusBad: { ru: "Нет", uk: "Немає", en: "No" },
  statusUnknown: { ru: "Не проверено", uk: "Не перевірено", en: "Not checked" },
};

type RuntimeMessageKey =
  | "checkPhaseLabel" | "preparationPhaseLabel" | "activeCommandLabel"
  | "stagePreflight" | "stageHostCheck" | "stageRootfsCheck" | "stageGuestBaseline" | "stageGuestPreflight"
  | "stageGuestIndexUpdate" | "stageGuestMirrorFallback" | "stageGuestInstall" | "stageGuestVerification"
  | "stageFinalRootfsReadback" | "stageReady" | "stageError" | "stageLock" | "stageRootfs" | "stageUnknown"
  | "actionRequiresCheck" | "readinessReady" | "readinessHostMissing" | "readinessRootfsMissing" | "readinessBaselineMissing"
  | "readinessHostError" | "readinessRootfsError" | "readinessBaselineError" | "readinessGenericError"
  | "reasonPermission" | "reasonTimeout" | "reasonTruncated" | "reasonCommandFailed" | "reasonBridge"
  | "reasonInterrupted" | "reasonUnknownStatus" | "reasonListUnverified" | "reasonArchitectureMismatch"
  | "reasonIdentityUnverified" | "reasonGuestCheck" | "reasonUnknown"
  | "progressHostCheck" | "progressRootfsCheck" | "progressGuestCheck" | "progressIndexUpdate"
  | "progressMirrorFallback" | "progressGuestInstall" | "progressGuestVerification" | "progressFinalReadback"
  | "progressReady" | "progressWaiting" | "checkFailed" | "prepareStarted" | "prepareAlreadyReady"
  | "prepareBlocked" | "prepareCancelled" | "prepareFailed" | "prepareSucceeded" | "finalReadbackFailed";

const runtimeMessages: Record<RuntimeMessageKey, Record<AppLanguage, string>> = {
  checkPhaseLabel: { ru: "Этап проверки", uk: "Етап перевірки", en: "Check phase" },
  preparationPhaseLabel: { ru: "Этап подготовки", uk: "Етап підготовки", en: "Preparation phase" },
  activeCommandLabel: { ru: "Текущая операция", uk: "Поточна дія", en: "Active operation" },
  stagePreflight: { ru: "Предварительная проверка", uk: "Попередня перевірка", en: "Preflight" },
  stageHostCheck: { ru: "Проверка Termux", uk: "Перевірка Termux", en: "Termux check" },
  stageRootfsCheck: { ru: "Проверка rootfs", uk: "Перевірка rootfs", en: "Rootfs check" },
  stageGuestBaseline: { ru: "Проверка базовых пакетов", uk: "Перевірка базових пакетів", en: "Baseline package check" },
  stageGuestPreflight: { ru: "Проверка пакетов", uk: "Перевірка пакетів", en: "Package preflight" },
  stageGuestIndexUpdate: { ru: "Обновление индексов пакетов", uk: "Оновлення індексів пакетів", en: "Package index update" },
  stageGuestMirrorFallback: { ru: "Проверка резервного зеркала", uk: "Перевірка резервного дзеркала", en: "Mirror fallback" },
  stageGuestInstall: { ru: "Установка пакетов", uk: "Встановлення пакетів", en: "Package installation" },
  stageGuestVerification: { ru: "Проверка установленных пакетов", uk: "Перевірка встановлених пакетів", en: "Package verification" },
  stageFinalRootfsReadback: { ru: "Итоговая проверка rootfs", uk: "Підсумкова перевірка rootfs", en: "Final rootfs verification" },
  stageReady: { ru: "Готово", uk: "Готово", en: "Ready" },
  stageError: { ru: "Ошибка", uk: "Помилка", en: "Error" },
  stageLock: { ru: "Ожидание другой операции", uk: "Очікування іншої операції", en: "Waiting for another operation" },
  stageRootfs: { ru: "Подготовка rootfs", uk: "Підготовка rootfs", en: "Rootfs preparation" },
  stageUnknown: { ru: "Проверка состояния", uk: "Перевірка стану", en: "Status check" },
  actionRequiresCheck: { ru: "Действия с {distro} доступны после успешной проверки выбранной среды.", uk: "Дії з {distro} доступні після успішної перевірки вибраного середовища.", en: "{distro} actions are available after the selected environment passes a readiness check." },
  readinessReady: { ru: "{distro}: готова; host, вход в rootfs и базовые инструменты проверены.", uk: "{distro}: готове; host, вхід до rootfs і базові інструменти перевірено.", en: "{distro}: ready; host, rootfs login, and baseline tools are verified." },
  readinessHostMissing: { ru: "В Termux не найден proot-distro. Установка подтверждённо отсутствующего компонента может быть предложена отдельно.", uk: "У Termux не знайдено proot-distro. Встановлення підтверджено відсутнього компонента може бути запропоновано окремо.", en: "proot-distro is confirmed absent in Termux. Installation may be offered separately for this confirmed absence." },
  readinessRootfsMissing: { ru: "{distro}: отсутствие rootfs подтверждено списком установленных дистрибутивов.", uk: "{distro}: відсутність rootfs підтверджено списком встановлених дистрибутивів.", en: "{distro}: rootfs absence is confirmed by the installed-distribution list." },
  readinessBaselineMissing: { ru: "{distro}: отсутствуют базовые инструменты: {items}.", uk: "{distro}: бракує базових інструментів: {items}.", en: "{distro}: baseline tools are missing: {items}." },
  readinessHostError: { ru: "{distro}: не удалось проверить обязательный инструмент Termux ({reason}). Установка заблокирована до подтверждения отсутствия.", uk: "{distro}: не вдалося перевірити обов'язковий інструмент Termux ({reason}). Встановлення заблоковано до підтвердження відсутності.", en: "{distro}: the required Termux tool could not be verified ({reason}). Installation is blocked until absence is confirmed." },
  readinessRootfsError: { ru: "{distro}: состояние rootfs или вход в него не подтверждены ({reason}). Существующие данные сохранены; установка заблокирована.", uk: "{distro}: стан rootfs або вхід до нього не підтверджено ({reason}). Наявні дані збережено; встановлення заблоковано.", en: "{distro}: rootfs state or login is unverified ({reason}). Existing data is preserved; installation is blocked." },
  readinessBaselineError: { ru: "{distro}: проверка базовых инструментов не завершена ({reason}). Установка не запускалась.", uk: "{distro}: перевірку базових інструментів не завершено ({reason}). Встановлення не запускалося.", en: "{distro}: baseline tool verification did not complete ({reason}). Installation was not started." },
  readinessGenericError: { ru: "{distro}: состояние среды не подтверждено ({reason}). Ничего не устанавливалось.", uk: "{distro}: стан середовища не підтверджено ({reason}). Нічого не встановлювалося.", en: "{distro}: environment state is unverified ({reason}). Nothing was installed." },
  reasonPermission: { ru: "встроенное выполнение или файловый доступ запрещены", uk: "вбудоване виконання або файловий доступ заборонено", en: "bundled execution or filesystem access was denied" },
  reasonTimeout: { ru: "истекло время ожидания команды", uk: "час очікування команди вичерпано", en: "the command timed out" },
  reasonTruncated: { ru: "получен неполный ответ", uk: "отримано неповну відповідь", en: "the command returned incomplete output" },
  reasonCommandFailed: { ru: "команда завершилась с ошибкой", uk: "команда завершила роботу з помилкою", en: "the command failed" },
  reasonBridge: { ru: "мост команд Termux не вернул результат", uk: "міст команд Termux не повернув результат", en: "the Termux command bridge returned no result" },
  reasonInterrupted: { ru: "проверка была прервана", uk: "перевірку перервано", en: "the check was interrupted" },
  reasonUnknownStatus: { ru: "маркер состояния отсутствует или неоднозначен", uk: "маркер стану відсутній або неоднозначний", en: "the status marker is missing or ambiguous" },
  reasonListUnverified: { ru: "список установленных дистрибутивов не подтверждён", uk: "список встановлених дистрибутивів не підтверджено", en: "the installed-distribution list is unverified" },
  reasonArchitectureMismatch: { ru: "архитектуры host и rootfs не совпадают", uk: "архітектури host і rootfs не збігаються", en: "host and rootfs architectures do not match" },
  reasonIdentityUnverified: { ru: "login или идентификатор ОС не подтверждён", uk: "login або ідентифікатор ОС не підтверджено", en: "login or operating-system identity is unverified" },
  reasonGuestCheck: { ru: "ошибка проверки пакета в гостевой среде", uk: "помилка перевірки пакета в гостьовому середовищі", en: "a guest package check failed" },
  reasonUnknown: { ru: "причина не определена", uk: "причину не визначено", en: "the cause is unknown" },
  progressHostCheck: { ru: "Проверка доступности proot-distro в Termux…", uk: "Перевірка доступності proot-distro у Termux…", en: "Checking proot-distro availability in Termux…" },
  progressRootfsCheck: { ru: "Проверка списка и входа в {distro} rootfs…", uk: "Перевірка списку та входу до {distro} rootfs…", en: "Checking the {distro} rootfs list and login…" },
  progressGuestCheck: { ru: "Проверка базовых инструментов в {distro}…", uk: "Перевірка базових інструментів у {distro}…", en: "Checking baseline tools in {distro}…" },
  progressIndexUpdate: { ru: "Обновление индексов пакетов {distro}…", uk: "Оновлення індексів пакетів {distro}…", en: "Updating {distro} package indexes…" },
  progressMirrorFallback: { ru: "Проверка официального резервного источника пакетов…", uk: "Перевірка офіційного резервного джерела пакетів…", en: "Checking the official package mirror fallback…" },
  progressGuestInstall: { ru: "Установка недостающих инструментов в {distro}…", uk: "Встановлення відсутніх інструментів у {distro}…", en: "Installing missing tools in {distro}…" },
  progressGuestVerification: { ru: "Проверка базовых инструментов в {distro}…", uk: "Перевірка базових інструментів у {distro}…", en: "Verifying baseline tools in {distro}…" },
  progressFinalReadback: { ru: "Повторная проверка входа и идентификатора {distro} перед отметкой «готово»…", uk: "Повторна перевірка входу та ідентифікатора {distro} перед позначенням «готово»…", en: "Rechecking {distro} login and identity before marking ready…" },
  progressReady: { ru: "Проверки завершены.", uk: "Перевірки завершено.", en: "Verification completed." },
  progressWaiting: { ru: "Ожидание следующего этапа…", uk: "Очікування наступного етапу…", en: "Waiting for the next step…" },
  checkFailed: { ru: "{distro}: проверка состояния завершилась с ошибкой или была прервана. Статус остаётся неизвестным; установка не запускалась.", uk: "{distro}: перевірка стану завершилася помилкою або її перервано. Стан залишається невідомим; встановлення не запускалося.", en: "{distro}: the status check failed or was interrupted. State remains unknown; installation was not started." },
  prepareStarted: { ru: "{distro}: повторная проверка перед изменениями.", uk: "{distro}: повторна перевірка перед змінами.", en: "{distro}: rechecking state before making changes." },
  prepareAlreadyReady: { ru: "{distro}: среда уже готова; переустановка не выполнялась.", uk: "{distro}: середовище вже готове; повторне встановлення не виконувалося.", en: "{distro}: the environment is already ready; nothing was reinstalled." },
  prepareBlocked: { ru: "{distro}: подготовка безопасно остановлена. {reason}", uk: "{distro}: підготовку безпечно зупинено. {reason}", en: "{distro}: preparation stopped safely. {reason}" },
  prepareCancelled: { ru: "{distro}: остановлено после завершения текущей команды; следующие этапы не запускались.", uk: "{distro}: зупинено після завершення поточної команди; наступні етапи не запускалися.", en: "{distro}: stopped after the current command completed; later stages were not started." },
  prepareFailed: { ru: "{distro}: подготовка остановлена на этапе «{stage}» ({reason}). Готовность не подтверждена; автоматический сброс или удаление rootfs не выполнялись.", uk: "{distro}: підготовку зупинено на етапі «{stage}» ({reason}). Готовність не підтверджено; автоматичного скидання чи видалення rootfs не виконувалося.", en: "{distro}: preparation stopped at {stage} ({reason}). Readiness is unconfirmed; no automatic rootfs reset or removal was performed." },
  prepareSucceeded: { ru: "{distro}: готово. Установлено: {installed}. Уже было: {existing}.", uk: "{distro}: готово. Встановлено: {installed}. Уже було: {existing}.", en: "{distro}: ready. Installed: {installed}. Already present: {existing}." },
  finalReadbackFailed: { ru: "{distro}: базовые команды завершились, но итоговая проверка входа и идентификатора rootfs не пройдена. Среда не отмечена как готовая.", uk: "{distro}: базові команди завершилися, але підсумкова перевірка входу й ідентифікатора rootfs не пройдена. Середовище не позначено як готове.", en: "{distro}: baseline commands completed, but the final rootfs login and identity check did not pass. The environment is not marked ready." },
};

type RuntimeReadinessLike = Readonly<{
  target: "ubuntu-proot";
  status: "ready" | "missing" | "error";
  phase: string;
  detail?: string;
  reason?: string;
  missingItems?: readonly string[];
}>;

function runtimeMessageText(language: AppLanguage, key: RuntimeMessageKey, params: Record<string, string | number> = {}): string {
  const template = runtimeMessages[key][language] ?? runtimeMessages[key].ru;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => params[name] === undefined ? `{${name}}` : String(params[name]));
}

export function runtimeStageLabel(language: AppLanguage, phase: string): string {
  const keys: Record<string, RuntimeMessageKey> = {
    preflight: "stagePreflight", "host-check": "stageHostCheck", "rootfs-check": "stageRootfsCheck",
    "guest-baseline": "stageGuestBaseline", "guest-preflight": "stageGuestPreflight",
    "guest-index-update": "stageGuestIndexUpdate", "guest-mirror-fallback": "stageGuestMirrorFallback",
    "guest-install": "stageGuestInstall", "guest-verification": "stageGuestVerification",
    "final-rootfs-readback": "stageFinalRootfsReadback", ready: "stageReady", error: "stageError",
    lock: "stageLock", rootfs: "stageRootfs",
  };
  return runtimeMessageText(language, keys[phase] ?? "stageUnknown");
}

function reasonKey(reason?: string): RuntimeMessageKey {
  switch (reason) {
    case "permission": return "reasonPermission";
    case "timeout": return "reasonTimeout";
    case "truncated-output": return "reasonTruncated";
    case "command-failed": return "reasonCommandFailed";
    case "bridge-failure": return "reasonBridge";
    case "interrupted": return "reasonInterrupted";
    case "unknown-status": return "reasonUnknownStatus";
    case "list-unverified": return "reasonListUnverified";
    case "architecture-mismatch": return "reasonArchitectureMismatch";
    case "identity-unverified": return "reasonIdentityUnverified";
    case "guest-check": return "reasonGuestCheck";
    default: return "reasonUnknown";
  }
}

export function runtimeReasonFromDiagnostic(diagnostic: string): string {
  if (diagnostic === "ROOTFS_ARCH_MISMATCH") return "architecture-mismatch";
  if (diagnostic === "ROOTFS_LIST_UNVERIFIED") return "list-unverified";
  if (diagnostic === "ROOTFS_INSTALLED_LOGIN_FAILED" || diagnostic === "PROOT_PROBE_INCOMPLETE" || diagnostic === "ROOTFS_STATE_UNVERIFIED") return "identity-unverified";
  return "unknown";
}

export function runtimeReadinessText(language: AppLanguage, readiness: RuntimeReadinessLike): string {
  const distro = "Ubuntu";
  if (readiness.status === "ready") return runtimeMessageText(language, "readinessReady", { distro });
  if (readiness.status === "missing") {
    if (readiness.phase === "host-check") return runtimeMessages.readinessHostMissing[language];
    if (readiness.phase === "rootfs-check") return runtimeMessageText(language, "readinessRootfsMissing", { distro });
    return runtimeMessageText(language, "readinessBaselineMissing", { distro, items: (readiness.missingItems ?? []).join(", ") || "—" });
  }
  const reason = runtimeMessageText(language, reasonKey(readiness.reason));
  if (readiness.phase === "host-check") return runtimeMessageText(language, "readinessHostError", { distro, reason });
  if (readiness.phase === "rootfs-check") return runtimeMessageText(language, "readinessRootfsError", { distro, reason });
  if (readiness.phase === "guest-baseline") return runtimeMessageText(language, "readinessBaselineError", { distro, reason });
  return runtimeMessageText(language, "readinessGenericError", { distro, reason });
}

export function runtimeProgressText(language: AppLanguage, phase: string, target: "ubuntu-proot"): string {
  const distro = "Ubuntu";
  let key: RuntimeMessageKey;
  switch (phase) {
    case "host-check": key = "progressHostCheck"; break;
    case "rootfs-check":
    case "rootfs": key = "progressRootfsCheck"; break;
    case "guest-baseline":
    case "guest-preflight": key = "progressGuestCheck"; break;
    case "guest-index-update": key = "progressIndexUpdate"; break;
    case "guest-mirror-fallback": key = "progressMirrorFallback"; break;
    case "guest-install": key = "progressGuestInstall"; break;
    case "guest-verification": key = "progressGuestVerification"; break;
    case "final-rootfs-readback": key = "progressFinalReadback"; break;
    case "ready": key = "progressReady"; break;
    default: key = "progressWaiting";
  }
  return runtimeMessageText(language, key, { distro });
}

export function runtimePreparationFailureText(
  language: AppLanguage,
  target: "ubuntu-proot",
  stage: string,
  error: string,
  cancelled = false,
): string {
  const distro = "Ubuntu";
  if (cancelled) return runtimeMessageText(language, "prepareCancelled", { distro });
  const text = String(error ?? "");
  const reason = /permission|securityexception|eacces|eperm/i.test(text) ? "permission"
    : /timeout|timed\s*out/i.test(text) ? "timeout"
      : /truncat|incomplete|output_incomplete/i.test(text) ? "truncated-output"
        : /bridge|result unavailable/i.test(text) ? "bridge-failure"
          : /exit\s*[=:]?\s*\d+|failed|failure/i.test(text) ? "command-failed"
            : "unknown";
  return runtimeMessageText(language, "prepareFailed", {
    distro,
    stage: runtimeStageLabel(language, stage),
    reason: runtimeMessageText(language, reasonKey(reason)),
  });
}

export function runtimeText(language: AppLanguage, key: RuntimeCopyKey | RuntimeMessageKey, params?: Record<string, string | number>): string {
  if (key in runtimeMessages) return runtimeMessageText(language, key as RuntimeMessageKey, params);
  const value = copy[key as RuntimeCopyKey][language] ?? copy[key as RuntimeCopyKey].ru;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] === undefined ? `{${name}}` : String(params[name]));
}
