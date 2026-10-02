#!/usr/bin/env bash
set -euo pipefail

for tool in pulseaudio pactl; do
  if ! command -v "$tool" >/dev/null; then
    echo "Browser audio tests require pulseaudio and pulseaudio-utils" >&2
    exit 1
  fi
done

audio_dir="$(mktemp -d "${TMPDIR:-/tmp}/talos-audio.XXXXXX")"
export PULSE_RUNTIME_PATH="$audio_dir"
export PULSE_SERVER="unix:$audio_dir/native"

cat > "$audio_dir/default.pa" <<EOF
load-module module-native-protocol-unix socket=$audio_dir/native auth-anonymous=1
load-module module-null-sink sink_name=talos rate=48000 channels=2
set-default-sink talos
set-default-source talos.monitor
EOF

DBUS_SESSION_BUS_ADDRESS="unix:path=$audio_dir/no-session-bus" \
  pulseaudio --daemonize=no --exit-idle-time=-1 --use-pid-file=no -n \
  --file="$audio_dir/default.pa" > "$audio_dir/pulseaudio.log" 2>&1 &
audio_pid=$!

cleanup() {
  kill "$audio_pid" 2>/dev/null || true
  wait "$audio_pid" 2>/dev/null || true
  rm -rf "$audio_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if pactl info >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$audio_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  cat "$audio_dir/pulseaudio.log" >&2
  echo "Virtual audio backend did not start" >&2
  exit 1
fi

pactl info
pactl list short sinks
if [[ "$#" == 0 ]]; then
  set -- bun run test:browser
fi
"$@"
