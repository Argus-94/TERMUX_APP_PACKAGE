# Сборка .deb для com.karat.aibuilder

## 1. Клонировать termux-packages

```bash
git clone https://github.com/termux/termux-packages.git
cd termux-packages
# желательно тот же commit, что bootstrap AI Builder (см. provenance.json)
```

## 2. Namespace

```bash
export TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder
export TERMUX_APP_PACKAGE=com.karat.aibuilder
```

В `scripts/properties.sh` должно быть:

```bash
TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"
```

## 3. Сборка (Docker)

```bash
./scripts/run-docker.sh ./build-package.sh -a aarch64 git
./scripts/run-docker.sh ./build-package.sh -a aarch64 python
./scripts/run-docker.sh ./build-package.sh -a aarch64 nodejs
./scripts/run-docker.sh ./build-package.sh -a aarch64 openjdk-17
```

## 4. Копирование в этот repo

```bash
REPO=/path/to/TERMUX_APP_PACKAGE
mkdir -p "$REPO/apt/termux-main/pool/main/git"
cp output/git_*.deb "$REPO/apt/termux-main/pool/main/git/"   # путь output уточни по своей сборке
```

## 5. Пересборка индекса

```bash
cd "$REPO/apt/termux-main"
dpkg-scanpackages -m pool /dev/null > dists/stable/main/binary-aarch64/Packages
gzip -9c dists/stable/main/binary-aarch64/Packages > dists/stable/main/binary-aarch64/Packages.gz
```

Или: `./scripts/rebuild-index.sh` из корня этого репозитория.

## 6. Проверка namespace

```bash
dpkg-deb -c pool/main/git/git_*.deb | grep -F 'com.termux' && echo FAIL || echo OK
```
