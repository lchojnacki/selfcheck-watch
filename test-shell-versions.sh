#!/bin/bash
# Loads the extension in a headless GNOME Shell (Docker) for every version listed in
# metadata.json's shell-version, and runs test.js with that version's gjs.
# Usage: ./test-shell-versions.sh [version...]   (default: all versions from metadata.json)
set -u
cd "$(dirname "$0")"
UUID=$(grep -oE '"uuid": *"[^"]+"' metadata.json | cut -d'"' -f4)
VERSIONS=${*:-$(grep -oE '"shell-version": *\[[^]]*\]' metadata.json | grep -oE '[0-9]+')}

ubuntu_for() {
    case $1 in
        46) echo 24.04 ;; 47) echo 24.10 ;; 48) echo 25.04 ;; 49) echo 25.10 ;; 50) echo 26.04 ;;
        *) return 1 ;;
    esac
}

# Runs inside the container. Prints the exact shell version, then (on failure) the reason and details;
# everything else goes to a log nobody reads.
INNER='
mkdir /ext && tar -x -C /ext  # repo arrives on stdin; no bind mount, so it also works in act/DinD
exec 3>&1 >/tmp/noise.log 2>&1
say() { echo "$@" >&3; }
mkdir -p /run/dbus && dbus-daemon --system --fork
rm -rf /run/systemd/seats  # no logind in the container -> shell uses its dummy login manager
mkdir -p -m 1777 /tmp/.X11-unix
export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR
mkdir -p ~/.local/share/gnome-shell/extensions && cp -r /ext ~/.local/share/gnome-shell/extensions/$UUID
gsettings set org.gnome.shell enabled-extensions "[\"$UUID\"]"
say "$(gnome-shell --version | cut -d" " -f3)"
gnome-shell --headless --wayland --virtual-monitor 1280x800 >/tmp/gs.log 2>&1 &
info=
for _ in $(seq 60); do
    sleep 1
    info=$(gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell \
        -m org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" 2>/dev/null) || continue
    echo "$info" | grep -q "state.: <1.0>" && [ -e ~/.config/selfcheck-watch.ini ] && break
done
err=$(echo "$info" | grep -oE "error.: <[^>]*>" | sed -E "s/.*<.(.*).>/\1/")
if [ -z "$info" ]; then say "gnome-shell did not start"; tail -20 /tmp/gs.log >&3; exit 1; fi
state=$(echo "$info" | grep -oE "state.: <[0-9]+" | grep -oE "[0-9]+$")
case $state in  # ExtensionState from GNOME Shell misc/extensionUtils.js
    2) state=DISABLED ;; 3) state=ERROR ;; 4) state="OUT_OF_DATE - version not in metadata.json shell-version" ;;
    6) state=INITIALIZED ;; 99) state=UNINSTALLED ;;
esac
if ! echo "$info" | grep -q "state.: <1.0>"; then say "extension not enabled (state ${state:-not loaded})${err:+: $err}"; grep -A5 "$UUID" /tmp/gs.log >&3; exit 1; fi
if grep -qiE "$UUID|JS ERROR.*selfcheck" /tmp/gs.log; then say "errors in shell log"; grep -A5 -iE "$UUID|JS ERROR.*selfcheck" /tmp/gs.log >&3; exit 1; fi
[ -e ~/.config/selfcheck-watch.ini ] || { say "first check did not run (no config created)"; exit 1; }
out=$(cd /ext && gjs -m test.js 2>&1) || { say "test.js failed"; echo "$out" >&3; exit 1; }
'

if [ -t 1 ]; then OK=$'\e[32mOK\e[0m' FAIL=$'\e[31mFAILED\e[0m' DIM=$'\e[2m' RST=$'\e[0m' CLR=$'\r\e[K'; else OK=OK FAIL=FAILED DIM= RST= CLR=; fi
progress() { [ -n "$CLR" ] && printf '%s  GNOME Shell %-3s %s' "$CLR" "$v" "$DIM$1$RST"; }  # terminal only
echo "Testing $UUID on GNOME Shell $(echo $VERSIONS)"
echo
failed=()
for v in $VERSIONS; do
    if ! ubuntu=$(ubuntu_for "$v"); then
        printf '  GNOME Shell %-3s ' "$v"; echo "$FAIL  no Ubuntu release mapped - add it to ubuntu_for()"; failed+=("$v"); continue
    fi
    progress "building image (Ubuntu $ubuntu)..."
    # EOL Ubuntu releases move to old-releases.ubuntu.com
    if ! build=$(docker build -q -t "selfcheck-watch-gs$v" - 2>&1 <<EOF
FROM ubuntu:$ubuntu
RUN (apt-get update || (sed -i -E 's#(archive|security).ubuntu.com#old-releases.ubuntu.com#' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null; apt-get update)) \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gnome-shell gjs dbus-x11 gir1.2-soup-3.0 \
 && rm -rf /var/lib/apt/lists/*
EOF
    ); then
        printf '%s  GNOME Shell %-3s %s  image build failed (Ubuntu %s)\n' "$CLR" "$v" "$FAIL" "$ubuntu"
        echo "$build" | tail -5 | sed 's/^/      /'; failed+=("$v"); continue
    fi
    progress "running..."
    out=$(tar -c --exclude=.git --exclude=.idea . | docker run --rm -i -e UUID="$UUID" "selfcheck-watch-gs$v" \
        dbus-run-session -- bash -c "$INNER" 2>/dev/null)
    rc=$?
    exact=$(head -1 <<<"$out")
    printf '%s  GNOME Shell %-3s %s  ' "$CLR" "$v" "$DIM(${exact:-?}, Ubuntu $ubuntu)$RST"
    if [ $rc = 0 ]; then
        echo "$OK"
    else
        echo "$FAIL  $(sed -n 2p <<<"$out")"
        tail -n +3 <<<"$out" | sed 's/^/      /'
        failed+=("$v")
    fi
done

echo
if [ ${#failed[@]} -eq 0 ]; then echo "All passed."; else echo "Failed: ${failed[*]}"; exit 1; fi
