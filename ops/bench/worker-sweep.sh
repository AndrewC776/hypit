#!/bin/zsh
# Marginal-benefit sweep: same 1080x1920 fixture, varying only `workers`.
#
# Each run gets its own project copy, because a Build whose Outputs already exist in that project's
# Result repository could be satisfied by reuse, and a reused Output would time as "infinitely fast"
# rather than as a render. The dataRoot is shared and absolute so every run is served by the same
# already-warm Runtime Worker, which keeps startup out of the comparison.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
FIXTURE=/Users/operator/hypit-work/projects/baseline-9x16
BENCH=/Users/operator/hypit-work/bench
DATAROOT=/Users/operator/hypit-work/baseline/.hypit/runtimes/local
rm -rf "$BENCH"; mkdir -p "$BENCH"

printf "%-8s %-10s %-12s %-14s %-10s\n" "workers" "wall_s" "peakChrome" "peakChromeProc" "peakLoad"
for W in 1 2 4 6; do
  RUN="$BENCH/w$W-$RANDOM"
  mkdir -p "$RUN"
  /usr/bin/rsync -a --exclude ".hypit" --exclude "hypit.runtime*.json" "$FIXTURE/" "$RUN/project/"
  cat > "$RUN/hypit.runtime.json" <<JSON
{
  "format": "hypit.runtime-local@1",
  "dataRoot": "$DATAROOT",
  "credentials": { "os": { "use": "@hypit/credential-store-os" } },
  "endpoints": {
    "media.local": { "use": "@hypit/provider-media-local", "config": { "defaultConcurrency": 2 } },
    "hyperframes.local": {
      "use": "@hypit/provider-hyperframes-local",
      "pool": "local-render",
      "config": { "workers": $W, "defaultConcurrency": 1, "browserCapacity": 6, "browserGpu": "auto" }
    }
  }
}
JSON

  SAMPLES="$RUN/samples.txt"
  : > "$SAMPLES"
  touch "$RUN/.sampling"
  ( while [ -f "$RUN/.sampling" ]; do
      CH=$(ps -Ao rss=,command= | grep -i chrome | grep -iE "headless|chrome-mac-arm64|Chrome for Testing" | grep -v grep | awk '{s+=$1} END {printf "%.0f", s/1024}')
      NC=$(ps -Ao command= | grep -i chrome | grep -iE "headless|chrome-mac-arm64|Chrome for Testing" | grep -vc grep)
      LD=$(sysctl -n vm.loadavg | awk '{print $2}')
      echo "${CH:-0} ${NC:-0} $LD" >> "$SAMPLES"
      sleep 1
    done ) &

  START=$(date +%s)
  hypit build "$RUN/project/chat.svrun" --workspace "$RUN/project" --runtime "$RUN/hypit.runtime.json" \
    --follow --json > "$RUN/build.json" 2> "$RUN/build.err"
  END=$(date +%s)
  rm -f "$RUN/.sampling"
  sleep 1

  OUTCOME=$(python3 -c "
import json
try:
    d = json.load(open('$RUN/build.json'))
    b = d.get('build') or {}
    print((b.get('work') or {}).get('outcome') or (b.get('work') or {}).get('state') or d.get('format'))
except Exception as exc:
    print('unreadable:' + str(exc))
")
  read -r PCH PNC PLD <<< "$(awk '{if($1+0>a)a=$1+0; if($2+0>b)b=$2+0; if($3+0>c)c=$3+0} END{print a, b, c}' "$SAMPLES")"
  printf "%-8s %-10s %-12s %-14s %-10s %s\n" "$W" "$((END-START))" "${PCH}MiB" "$PNC" "$PLD" "$OUTCOME"
done
