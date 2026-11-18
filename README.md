# Selfcheck Watch

A small GNOME Shell extension that polls HTTP health-check endpoints on an interval and
notifies you when one of them reports a problem.

- panel icon: a check mark when everything is OK, a warning sign when something is not
- menu: status of each endpoint (⚠️ with the problem text when not OK), a switch to enable or disable it
  (OK and disabled ones are collapsed under "OK" and "Disabled"), last check time ("Checking…" while a check runs),
  "Check now" and "Edit config"
- desktop notification on every check that finds a problem

An endpoint is OK when it answers HTTP 200 and the body matches `ok_regex` (a JavaScript regex,
set globally in `[general]` or per endpoint). The default, `"status"\s*:\s*"OK"`, accepts JSON like:

```json
{"status": "OK", "messages": []}
```

Anything else (no match, a non-200 response, a timeout) counts as a problem. The notification shows
every match of `problem_regex` (its first group, if it has one) joined with `, `, or the first 100
characters of the body when `problem_regex` is not set or matches nothing. For example
`problem_regex=problem id: (\d+)` turns
`{"status":"WARNING","messages":["Check failed, problem id: 5369","Check failed, problem id: 5359"]}`
into `5369, 5359`.

## Install

Requires GNOME Shell 46 to 50.

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
# default "status"\s*:\s*"OK"; both can be overridden per endpoint
ok_regex="status"\s*:\s*"OK"
problem_regex=problem id: (\d+)

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

GNOME Shell disables the extension while the screen is locked. Every unlock runs a check right away
and restarts the interval timer, so endpoints are checked at most `interval_minutes` apart and more
often if you lock the screen often. The timer stops during suspend, so after resuming without a lock
the next check can come later than `interval_minutes` of wall-clock time.

Values are not quoted (`url=https://...`) and comments must be on their own line (`# ...`). A backslash in a value starts an escape sequence
(`\\` for a literal backslash), except in `ok_regex` and `problem_regex`, which are taken as written.

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

```sh
./test-shell-versions.sh        # every version in metadata.json's shell-version
./test-shell-versions.sh 46 50  # just these
```

Needs Docker. For each GNOME Shell version it starts a headless shell in the matching Ubuntu
release, checks that the extension gets enabled without errors and runs its first check, then runs
`test.js` with that version's gjs. A new version needs its Ubuntu release added to `ubuntu_for()`.
GitHub Actions runs it on every push to main and on pull requests ([.github/workflows/test.yml](.github/workflows/test.yml)).

## License

MIT
