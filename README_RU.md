# Авто-Pages для TERMUX_APP_PACKAGE

## Что в архиве

| Workflow | Роль |
|----------|------|
| `pages.yml` | деплой через **GitHub Actions Pages** (после каждого push / после сборки пакетов) |
| `gh-pages-branch.yml` | пишет ветку **`gh-pages`** (запасной вариант) |
| `enable-pages-hint.yml` | проверка, жив ли feed |

## Как поставить (1 раз)

```bash
# содержимое архива → корень Argus-94/TERMUX_APP_PACKAGE
cp -r .github /path/to/TERMUX_APP_PACKAGE/
git add .github
git commit -m "ci: auto deploy Pages + gh-pages branch"
git push
```

## Единственный ручной клик (без него 404)

Открой: https://github.com/Argus-94/TERMUX_APP_PACKAGE/settings/pages

**Вариант A (предпочтительно):**  
Source → **GitHub Actions** → Save  

**Вариант B:**  
Source → **Deploy from a branch** → Branch: **`gh-pages`** → folder: **/ (root)** → Save  

После Save в течение 1–2 минут:

```text
https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main/dists/stable/main/binary-aarch64/Packages
```

должен дать **HTTP 200**.

GitHub **не позволяет** включить Pages только файлом в repo без этого клика (или без admin API token).

## Права Actions

Settings → Actions → General → Workflow permissions → **Read and write** → Save
