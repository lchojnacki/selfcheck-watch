# Selfcheck Watch

A small GNOME Shell extension that polls HTTP health-check endpoints on an interval and
notifies you when one of them reports a problem.

- panel icon: a check mark when everything is OK, a warning sign when something is not
- menu: status of each endpoint, a switch to enable or disable it, last check time,
  "Check now" and "Edit config"
- desktop notification on every check that finds a problem

Each endpoint must answer HTTP 200 with JSON like:

```json
{"status": "OK", "messages": []}
```

Anything else (another `status`, a non-200 response, a timeout, invalid JSON) counts as a
problem; `messages` are shown in the notification.

## Install

Requires GNOME Shell 50.

```sh
git clone https://github.com/lchojnacki/selfcheck-watch.git
ln -s "$PWD/selfcheck-watch" ~/.local/share/gnome-shell/extensions/selfcheck-watch@lchojnacki
```

Log out and back in (on Wayland GNOME Shell only discovers new extensions at login), then:

```sh
gnome-extensions enable selfcheck-watch@lchojnacki
```

## Configuration

`~/.config/selfcheck-watch.ini`. If it does not exist, it is created from
[config.example.ini](config.example.ini) on the first check (with placeholder endpoints switched off);
use "Edit config" in the menu to fill it in. It is re-read on every check, so changes apply on the next
check or right away with "Check now".

```ini
[general]
# default 30
interval_minutes=30
# default 30
timeout_seconds=30
# headers for every endpoint: header.<Name>=<value>
header.User-Agent=my-monitor

# section name = label in the menu
[production]
url=https://example.com/selfcheck/?format=json
# false = listed but not checked; can also be toggled from the menu
enabled=true
# overrides [general] headers
header.Authorization=Bearer secret-token
```

Toggling an endpoint in the menu writes `enabled=` back to the file. Comments are kept, but
blank lines may be reformatted.

Values are not quoted (`url=https://...`) and comments must be on their own line (`# ...`). A backslash in a value starts an escape sequence
(`\\` for a literal backslash).

## Troubleshooting

```sh
gnome-extensions info selfcheck-watch@lchojnacki
journalctl --user -b | grep -iE "selfcheck|JS ERROR"
```

To try changes without logging out, run a nested shell: `dbus-run-session gnome-shell --devkit --wayland`.

## Tests

```sh
gjs -m test.js
```

Covers config parsing and the HTTP check against a local server.

## License

MIT
