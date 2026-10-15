# Публичный ключ feed

`aibuilder-termux-feed-keyring.gpg` и `feed-signing.json` — публичные данные для будущего production feed. Candidate CI эти ключи не использует и создаёт отдельный одноразовый RSA keypair. Не добавлять production private key, его export, passphrase или revocation response в репозиторий; не передавать его candidate workflow. Сам факт подписи подтверждает целостность APT metadata относительно закреплённого ключа; он **не** доказывает происхождение или runtime-совместимость package binaries.
