# TERMUX_APP_PACKAGE — настройка apt-репозитория для AI Builder

**Репозиторий:** https://github.com/Argus-94/TERMUX_APP_PACKAGE  
**Application ID:** `com.karat.aibuilder`  
**Архитектура:** `aarch64` (arm64-v8a)  
**Цель:** чтобы в embedded Termux AI Builder работали `pkg update` / `pkg install …`

---

## 1. Зачем отдельный репозиторий

Официальный Termux:

```text
https://packages.termux.dev/apt/termux-main
```

собирает пакеты под **`com.termux`**. Внутри `.deb` и postinst часто зашиты пути:

```text
/data/data/com.termux/files/usr
/data/data/com.termux/files/home
```

AI Builder использует:

```text
/data/data/com.karat.aibuilder/files/usr   → $PREFIX
/data/data/com.karat.aibuilder/files/home  → $HOME
```

Поэтому нужен **свой** apt feed с пакетами, собранными при:

```bash
export TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder
```

Без этого `pkg install git` либо не найдёт пакеты, либо поставит бинарники с чужими путями.

В bootstrap AI Builder apt по умолчанию **выключен** до появления совместимого feed  
(`defaultAptRepository: disabled-until-app-compatible-feed`).

---

## 2. Итоговая структура каталогов

Создай в корне GitHub-репозитория:

```text
TERMUX_APP_PACKAGE/
├── README.md
├── LICENSE                                 # рекомендуется (GPL/совместимые)
├── docs/                                   # опционально
│   └── BUILD.md
│
└── apt/
    └── termux-main/                        # ← base URL для sources.list
        ├── Release                         # метаданные репозитория
        ├── InRelease                       # опционально: gpg-подпись Release
        │
        ├── dists/
        │   └── stable/
        │       ├── Release
        │       └── main/
        │           └── binary-aarch64/
        │               ├── Packages        # текстовый индекс (обязательно)
        │               ├── Packages.gz     # сжатый индекс (обязательно)
        │               └── Release         # опционально
        │
        └── pool/
            └── main/
                ├── bash/
                │   └── bash_<ver>_aarch64.deb
                ├── git/
                │   └── git_<ver>_aarch64.deb
                ├── python/
                │   └── python_<ver>_aarch64.deb
                ├── nodejs/
                │   └── ...
                ├── openjdk-17/
                │   └── ...
                └── <package-name>/
                    └── <package>_<ver>_aarch64.deb
```

### Что обязательно

| Путь | Назначение |
|------|------------|
| `apt/termux-main/` | Корень feed |
| `apt/termux-main/dists/stable/main/binary-aarch64/Packages` | Индекс пакетов |
| `apt/termux-main/dists/stable/main/binary-aarch64/Packages.gz` | Тот же индекс, gzip |
| `apt/termux-main/pool/main/**/*.deb` | Сами пакеты |

### Что опционально, но желательно

| Путь | Назначение |
|------|------------|
| `Release` / `InRelease` | Метаданные + подпись |
| Подпапки `pool/main/<name>/` | Удобная организация `.deb` |

---

## 3. URL для AI Builder

После публикации через **GitHub Pages** (см. §6):

```text
deb https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main stable main
```

В коде AI Builder:

| Константа | Значение |
|-----------|----------|
| `AIB_TERMUX_PACKAGE_REPO` | `https://github.com/Argus-94/TERMUX_APP_PACKAGE` |
| `AIB_TERMUX_APT_FEED_PLANNED` | `https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main` |
| `AIB_TERMUX_APT_FEED_DEFAULT` | `null`, пока index не отдаёт HTTP 200 |

Файл в приложении: `lib/termux-apt-feed.ts`.

---

## 4. Создание пустых папок (сразу)

На машине с клоном repo:

```bash
cd TERMUX_APP_PACKAGE

mkdir -p apt/termux-main/dists/stable/main/binary-aarch64
mkdir -p apt/termux-main/pool/main

# заглушки, чтобы структура была видна в git
printf 'Package: \n' > apt/termux-main/dists/stable/main/binary-aarch64/Packages
printf '' | gzip -9c > apt/termux-main/dists/stable/main/binary-aarch64/Packages.gz

cat > apt/termux-main/Release << 'REL'
Origin: AI Builder Termux
Label: termux-main
Suite: stable
Codename: stable
Architectures: aarch64
Components: main
Description: App-compatible Termux packages for com.karat.aibuilder
REL

git add apt README.md
git commit -m "Add apt repository layout for com.karat.aibuilder"
git push
```

Пока нет реальных `.deb`, `pkg update` будет «пустым», но путь уже правильный.

---

## 5. Сборка `.deb` под `com.karat.aibuilder`

### 5.1. Исходники

Официальная система сборки:

```text
https://github.com/termux/termux-packages
```

Используй тот же (или близкий) commit, что и bootstrap AI Builder  
(см. `assets/termux-bootstrap/*.provenance.json` → `sourceCommit`).

### 5.2. Namespace (критично)

Перед сборкой:

```bash
export TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder
# устаревший алиас (если скрипты ещё читают):
export TERMUX_APP_PACKAGE=com.karat.aibuilder
```

В `scripts/properties.sh` upstream должно быть **ровно**:

```bash
TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"
```

Не оставляй `com.termux`.

### 5.3. Пример сборки пакета

```bash
# типичный путь через Docker (официальный способ termux-packages)
./scripts/run-docker.sh ./build-package.sh -a aarch64 git
./scripts/run-docker.sh ./build-package.sh -a aarch64 python
./scripts/run-docker.sh ./build-package.sh -a aarch64 nodejs
./scripts/run-docker.sh ./build-package.sh -a aarch64 openjdk-17
```

Готовые `.deb` обычно лежат в каталоге вывода сборки (зависит от версии scripts; часто `output/` или debs в work tree).

### 5.4. Минимальный набор для функций билдера

| Пакет | Зачем AI Builder |
|-------|------------------|
| `git` | клоны, sync проектов |
| `openssh` | git+ssh, remote |
| `python` | скрипты, tooling |
| `nodejs` / `npm` | JS tooling, часть шаблонов |
| `openjdk-17` | Gradle / Android build |
| `wget`, `curl`, `unzip`, `tar` | уже в bootstrap; обновить при необходимости |
| `aapt` / android-tools | если есть recipe и нужен билду |

Bootstrap уже содержит ~75 базовых пакетов (`bash`, `coreutils`, `apt`, `curl`…).  
Сюда клади то, чего **нет** в bootstrap или что нужно обновлять.

### 5.5. Проверка namespace в `.deb`

```bash
# список файлов в пакете
dpkg-deb -c git_*.deb | head

# не должно быть /data/data/com.termux/ в критичных путях install
dpkg-deb -c git_*.deb | grep -F 'com.termux' && echo "BAD: still com.termux" || echo "OK"
```

---

## 6. Генерация индекса `Packages`

После копирования `.deb` в `pool/main/...`:

```bash
cd apt/termux-main

# индекс относительно корня termux-main
dpkg-scanpackages -m pool /dev/null \
  > dists/stable/main/binary-aarch64/Packages

gzip -9c dists/stable/main/binary-aarch64/Packages \
  > dists/stable/main/binary-aarch64/Packages.gz
```

Альтернатива из экосистемы Termux: утилита **`termux-apt-repo`**  
(см. wiki termux-packages / package `termux-apt-repo`) — собирает структуру репо из набора `.deb`.

### Пример фрагмента `Packages`

```text
Package: git
Version: 2.47.0
Architecture: aarch64
Maintainer: ...
Filename: pool/main/git/git_2.47.0_aarch64.deb
Size: 1234567
SHA256: abcdef...
Description: fast distributed version control system
```

Поле **`Filename`** должно указывать путь **относительно** `apt/termux-main/`.

---

## 7. GitHub Pages (как отдать репо по HTTPS)

1. Settings → Pages → Source: **Deploy from branch**  
2. Branch: `main` (или `gh-pages`), folder: **/ (root)**  
3. После деплоя проверь в браузере:

```text
https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main/dists/stable/main/binary-aarch64/Packages
```

Должен быть **HTTP 200** и текст индекса, не HTML 404.

### sources.list

```text
deb https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main stable main
```

### Вариант через Releases (сложнее)

Можно класть `.deb` в GitHub Releases, но apt всё равно нужен **статический index** (`Packages`) по стабильному HTTPS URL. Pages проще.

---

## 8. Подключение в AI Builder

### 8.1. Когда index уже online

1. В `lib/termux-apt-feed.ts` выставить:

```ts
export const AIB_TERMUX_APT_FEED_DEFAULT =
  "https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main";
```

2. Либо на устройстве через settings API:

```ts
await setAptFeedUrl("https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main");
// затем выполнить buildWriteAptSourcesCommand(url) через embedded shell
```

### 8.2. Команды в embedded shell

```bash
# после записи sources.list
pkg update
pkg install -y git
command -v git
echo "$PREFIX"   # ожидается .../com.karat.aibuilder/files/usr
```

### 8.3. Запрещено как primary

- `https://packages.termux.dev/apt/termux-main`
- любые зеркала официального Termux без пересборки под `com.karat.aibuilder`

Код AI Builder отклоняет такие URL в `normalizeAptFeedUrl()`.

---

## 9. Подпись репозитория (позднее, для production)

Для публичного распространения желательно:

```bash
gpg --armor --detach-sign -o Release.gpg Release
# или объединённый InRelease
```

На клиенте — доверенный ключ в `$PREFIX/etc/apt/trusted.gpg.d/`.  
Пока идёт отладка, можно работать без подписи, но **не** для публичного production без понимания рисков.

---

## 10. Чеклист готовности

- [ ] Папки `apt/termux-main/dists/.../binary-aarch64/` и `pool/main/` созданы  
- [ ] Хотя бы один `.deb` собран с `TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder`  
- [ ] В `.deb` нет критичных путей `com.termux`  
- [ ] `Packages` + `Packages.gz` сгенерированы  
- [ ] GitHub Pages отдаёт `Packages` по HTTPS (код 200)  
- [ ] `pkg update` в embedded AI Builder проходит  
- [ ] `pkg install git` ставит бинарник в `$PREFIX/bin/git`  
- [ ] В AI Builder выставлен `AIB_TERMUX_APT_FEED_DEFAULT` или сохранён URL в settings  

---

## 11. Типичные ошибки

| Симптом | Причина |
|---------|---------|
| `404` на Packages | Pages не включён / неверный путь |
| `NO_PUBKEY` / signature | нет ключа; для теста временно unsigned |
| `pkg` ставит, бинарник ломается | пакет собран под `com.termux` |
| Пустой `apt update` | пустой `Packages`, нет `.deb` в pool |
| `All packages are up to date`, install not found | пакет не попал в индекс / неверная Architecture |

---

## 12. Связь с AI Builder (кратко)

| Компонент | Роль |
|-----------|------|
| Bootstrap ZIP в APK | Базовый `$PREFIX` без внешнего Termux |
| ProcessBuilder `runCommand` | Исполнение команд в private prefix |
| Этот GitHub apt feed | Доустановка `git`, JDK, python, … |
| `lib/termux-packs.ts` | UI/логика `pkg install` для наборов инструментов |

Пока этот feed пуст — билдер работает на пакетах из bootstrap + прямых download-шагах packs, но **не** на полноценном `pkg install` из сети.

---

*Документ для репозитория Argus-94/TERMUX_APP_PACKAGE и сопровождения AI Builder embedded Termux.*
