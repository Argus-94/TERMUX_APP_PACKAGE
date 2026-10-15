# Публичный ключ feed

`aibuilder-termux-feed-keyring.gpg` и `feed-signing.json` — публичные данные. Соответствующий private key хранится только в GitHub Actions secret `AIB_TERMUX_FEED_SIGNING_KEY`. Никогда не добавлять private key, его export, passphrase или revocation response в репозиторий. Сам факт подписи подтверждает целостность APT metadata относительно закреплённого ключа; он **не** доказывает происхождение или runtime-совместимость package binaries.
