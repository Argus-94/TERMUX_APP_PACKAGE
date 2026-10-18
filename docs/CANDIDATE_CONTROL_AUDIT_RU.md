# Статическая проверка control-метаданных кандидатов

`scripts/audit-unified-control-metadata.py` читает `.deb` как данные. Он не устанавливает пакеты и не исполняет maintainer scripts. Вход — точный manifest с SHA-256 каждого пакета и соответствующие файлы из независимо проверенных candidate bundles; неполный набор, повтор identity или несовпадающий hash отклоняются.

Проверяются обязательные control fields, Debian version/epoch, разрешённые regular control members, owner/mode, повторные archive members, prefix confinement, conffiles, triggers и optional md5sums. Payload хешируется потоково; symlink mode 0777 не смешивается с world-writable regular file. Проверка полного разрешения ссылок остаётся обязанностью отдельного aggregate payload audit.

```sh
python3 scripts/audit-unified-control-metadata.py \
  --package-set /path/to/exact-package-set.json \
  --prefix /data/user/0/com.karat.aibuilder/files/usr \
  --report /path/to/control-report.json \
  /path/to/canonical-packages/*.deb
```

## Что действительно требует installer behavior

[Debian conffiles](https://manpages.debian.org/bookworm/dpkg-dev/deb-conffiles.5.en.html) используют абсолютный pathname. Флаг `remove-on-upgrade` стоит перед pathname; такой obsolete file не должен присутствовать в пакете.

[Upstream dpkg script.c](https://raw.githubusercontent.com/guillemj/dpkg/main/src/main/script.c) вызывает `setexecute()` перед script execution и при необходимости делает `chmod(0755)`. Поэтому archived mode 0644 сам по себе не доказывает несовместимость. Report сохраняет исходный mode и `requiresDpkgSetexecute` — это проверяемое требование к реальному installer, а не заявленная Android-установка.

[dpkg command.c](https://raw.githubusercontent.com/guillemj/dpkg/main/lib/dpkg/command.c) вызывает `execvp()`. [Android Bionic exec.cpp](https://android.googlesource.com/platform/bionic/+/refs/heads/main/libc/bionic/exec.cpp) содержит ENOEXEC shell fallback для script без shebang. Такой случай явно записывается как `requiresExecvpShellFallback`; наличие и работа нужного пути исполнения в конкретном APK ещё не доказаны.

Shell text проверяется только `bash -n`, включая script без shebang. Другие interpreters записываются как `NOT_CHECKED_NON_SHELL`; opaque programs не выдаются за проверенную shell syntax. Syntax parse не подтверждает наличие команд, baseline utilities, interpreter, корректность side effects или успешную работу scripts.

Любой успешный report сохраняет `qualified=false`, `productionAllowed=false`, `actualAndroidMaintainerEffects=NOT_RUN`. Он не заменяет подписи/provenance, dependency/payload/ELF/symbol audits, aggregate signed-by APT simulation и реальную Android install/upgrade/rollback квалификацию. Без последней production feed, Pages и Builder installer остаются закрытыми.

Unit tests используют только временные, явно TEST-ONLY ar/tar/DEB fixtures, проверяют настоящую реализацию parser и отдельно доказывают, что marker-команды в scripts не были исполнены. Эти fixtures никогда не являются candidate artifacts.
