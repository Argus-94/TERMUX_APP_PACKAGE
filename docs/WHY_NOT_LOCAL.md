# Почему пакеты нельзя «просто скачать готовыми» из этого чата

- Нужны `.deb` для **aarch64** + namespace **`com.karat.aibuilder`**
- Официальные пакеты Termux собраны под **`com.termux`** — ставить их в AI Builder нельзя
- Сборка идёт через `termux-packages` + Docker (часы CPU, гигабайты диска)

Ниже: готовый GitHub Actions workflow и скрипт — пакеты соберутся **на GitHub**, не в этом sandbox.
