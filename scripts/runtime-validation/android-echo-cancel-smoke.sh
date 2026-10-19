#!/usr/bin/env bash
# Must run inside com.karat.aibuilder's own terminal, after separately approved
# signed-candidate provisioning. No install/update, no public feed, no default
# server control, no microphone, no global config changes.
set -euo pipefail
expected=/data/user/0/com.karat.aibuilder/files/usr
[[ ${PREFIX:-} == "$expected" ]] || { echo 'BLOCKED: unexpected PREFIX' >&2; exit 64; }
[[ ${TERMUX_APP_PACKAGE:-${TERMUX_APP__PACKAGE_NAME:-}} == com.karat.aibuilder ]] || {
  echo 'BLOCKED: run through the target application environment' >&2; exit 64;
}
for c in pulseaudio pactl pacat parec mktemp wc sleep id stat mkdir grep tee; do
  command -v "$c" >/dev/null || { echo "BLOCKED: missing $c" >&2; exit 65; }
done
uid=$(id -u)
owner=$(stat -c %u /data/user/0/com.karat.aibuilder)
[[ $uid -ge 10000 && $uid == "$owner" ]] || {
  echo 'BLOCKED: target application directory owner UID mismatch' >&2; exit 65;
}
export LD_LIBRARY_PATH="$PREFIX/lib"
work=$(mktemp -d "$PREFIX/tmp/echo-qualification.XXXXXX")
server_pid= play_pid= record_pid=
cleanup() {
  for pid in "$play_pid" "$record_pid" "$server_pid"; do
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  echo "Evidence kept: $work"
}
trap cleanup EXIT
export PULSE_RUNTIME_PATH="$work/runtime"
mkdir -m 700 "$PULSE_RUNTIME_PATH"
export PULSE_SERVER="unix:$work/native"
export PULSE_CLIENTCONFIG="$work/client.conf"
printf 'autospawn = no\n' > "$PULSE_CLIENTCONFIG"
cat > "$work/probe.pa" <<EOF
.fail
load-module module-native-protocol-unix socket=$work/native auth-anonymous=1
load-module module-null-sink sink_name=probe_capture channels=1 rate=48000
load-module module-null-sink sink_name=probe_playback channels=1 rate=48000
load-module module-echo-cancel source_master=probe_capture.monitor sink_master=probe_playback source_name=probe_echo_source sink_name=probe_echo_sink channels=1 rate=48000 aec_method=webrtc aec_args="analog_gain_control=1 digital_gain_control=0"
EOF
{
  id
  /system/bin/getprop ro.build.version.sdk
  /system/bin/getprop ro.product.cpu.abi
  printf 'PREFIX=%s\nLD_LIBRARY_PATH=%s\n' "$PREFIX" "$LD_LIBRARY_PATH"
  pulseaudio --version
} > "$work/environment.txt"
pulseaudio --daemonize=no --exit-idle-time=-1 --use-pid-file=no --log-target=stderr --log-level=debug -n -F "$work/probe.pa" > "$work/server.log" 2>&1 &
server_pid=$!
ready=0
for _ in {1..50}; do
  kill -0 "$server_pid" 2>/dev/null || { echo 'FAIL: private server exited; see server.log' >&2; exit 1; }
  if pactl info > "$work/server-info.txt" 2> "$work/client-error.txt"; then ready=1; break; fi
  sleep 0.1
done
[[ $ready == 1 ]] || { echo 'FAIL: private server unavailable' >&2; exit 1; }
pactl list short modules > "$work/modules.txt"
pactl list short sources > "$work/sources.txt"
pactl list short sinks > "$work/sinks.txt"
grep -q 'module-echo-cancel' "$work/modules.txt"
grep -q 'probe_echo_source' "$work/sources.txt"
grep -q 'probe_echo_sink' "$work/sinks.txt"
pacat --playback --raw --format=s16le --channels=1 --rate=48000 --device=probe_echo_sink < /dev/zero > "$work/playback.out" 2> "$work/playback.err" &
play_pid=$!
parec --record --raw --format=s16le --channels=1 --rate=48000 --device=probe_echo_source > "$work/capture.raw" 2> "$work/record.err" &
record_pid=$!
sleep 2
for pid in "$server_pid" "$play_pid" "$record_pid"; do
  kill -0 "$pid" 2>/dev/null || { echo 'FAIL: audio process exited' >&2; exit 1; }
done
bytes=$(wc -c < "$work/capture.raw")
[[ $bytes -gt 0 ]] || { echo 'FAIL: no captured bytes' >&2; exit 1; }
printf 'PASS: isolated WebRTC module init and null-audio processing; bytes=%s\nNot physical audio quality or full package qualification.\n' "$bytes" | tee "$work/result.txt"
