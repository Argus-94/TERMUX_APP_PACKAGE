# Установка в TERMUX_APP_PACKAGE

```bash
# из распакованного архива
cp -r .github /path/to/TERMUX_APP_PACKAGE/
# commit push
```

Обязательно в GitHub repo:

**Settings → Actions → General → Workflow permissions → Read and write permissions → Save**

Иначе auto-push `.deb` упадёт с permission denied.
