# Распакуй и запушь

```bash
# 1. Распаковать
unzip TERMUX_APP_PACKAGE_scaffold.zip
cd TERMUX_APP_PACKAGE

# 2. Подготовить commit
./scripts/push-to-github.sh

# 3. Отправить (нужен доступ к GitHub)
git push -u origin main

# 4. Включить Pages
# GitHub → Settings → Pages → Source: GitHub Actions
```

Подробности: `CHECKLIST_RU.md`, `APT_REPO_SETUP_RU.md`.

**Пока нет `.deb` в `pool/` — `pkg install` ничего не поставит.**  
Сборка пакетов: `docs/BUILD_PACKAGES_RU.md`.
