# Автосборка пакетов (без ручного Run)

## Триггеры (сами)

| Событие | Что происходит |
|---------|----------------|
| **push в main** | сборка `git openssh python` → commit apt/ |
| **каждый понедельник 03:00 UTC** | повторная сборка |
| workflow_dispatch | ручной догон (опционально) |

Повторный push от `github-actions[bot]` с сообщением `ci: auto-build` **не** запускает цикл заново.

## Установка (один раз)

1. Распакуй архив
2. Скопируй в **корень** https://github.com/Argus-94/TERMUX_APP_PACKAGE :
   - `.github/workflows/build-packages.yml`
   - `.github/workflows/pages.yml`
3. Commit + **push в main** → Action стартует **сам**
4. **Settings → Actions → General → Workflow permissions → Read and write** → Save  
5. **Settings → Pages → Source: GitHub Actions**

Первая сборка: **долго** (часто 1–4+ часа).

## Feed

```text
deb https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main stable main
```
