// Config + HTTP logic; plain GLib/Soup only, so it can be tested outside gnome-shell (see test.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export const CONFIG = GLib.build_filenamev([GLib.get_user_config_dir(), 'selfcheck-watch.ini']);
const HEADER_PREFIX = 'header.';
export const DEFAULT_USER_AGENT = 'selfcheck-watch/1';

function keys(kf, group) {
    return kf.get_groups()[0].includes(group) ? kf.get_keys(group)[0] : [];
}

function headers(kf, group) {
    return Object.fromEntries(keys(kf, group)
        .filter(k => k.startsWith(HEADER_PREFIX))
        .map(k => [k.slice(HEADER_PREFIX.length), kf.get_string(group, k)]));
}

// Raw value (get_value, not get_string): KeyFile unescaping would turn \s into a space and reject \d.
function regex(kf, group, key, flags) {
    const g = keys(kf, group).includes(key) ? group : keys(kf, 'general').includes(key) ? 'general' : null;
    if (!g)
        return null;
    try {
        return new RegExp(kf.get_value(g, key), flags);
    } catch (e) {
        throw new Error(`[${g}] ${key}: ${e.message}`);
    }
}

const DEFAULT_OK_REGEX = /"status"\s*:\s*"OK"/;

function positiveInt(kf, key, fallback) {
    if (!keys(kf, 'general').includes(key))
        return fallback;
    const value = kf.get_integer('general', key);
    if (value < 1)
        throw new Error(`${key} must be >= 1, got ${value}`);
    return value;
}

// Returns {intervalMin, timeoutSec, endpoints: [{name, url, enabled, headers, okRegex, problemRegex}]}.
// Throws GLib.Error / Error on a missing or broken file.
export function loadConfig(path = CONFIG) {
    const kf = new GLib.KeyFile();
    kf.load_from_file(path, GLib.KeyFileFlags.NONE);
    const common = headers(kf, 'general');
    const endpoints = kf.get_groups()[0]
        .filter(g => keys(kf, g).includes('url'))
        .map(g => ({
            name: g,
            url: kf.get_string(g, 'url'),
            enabled: !keys(kf, g).includes('enabled') || kf.get_boolean(g, 'enabled'),
            headers: {...common, ...headers(kf, g)},
            okRegex: regex(kf, g, 'ok_regex', '') ?? DEFAULT_OK_REGEX,
            problemRegex: regex(kf, g, 'problem_regex', 'g'),
        }));
    return {
        intervalMin: positiveInt(kf, 'interval_minutes', 30),
        timeoutSec: positiveInt(kf, 'timeout_seconds', 30),
        endpoints,
    };
}

// Copies the example config to `path` if there is no config yet; never overwrites an existing one.
export function ensureConfig(examplePath, path = CONFIG) {
    const dest = Gio.File.new_for_path(path);
    if (dest.query_exists(null))
        return;
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    Gio.File.new_for_path(examplePath).copy(dest, Gio.FileCopyFlags.NONE, null, null);
    GLib.chmod(path, 0o600); // the config may hold tokens (header.Authorization)
}

// Writes enabled=<value> for one endpoint, keeping the rest of the file (comments included).
export function setEnabled(name, value, path = CONFIG) {
    const kf = new GLib.KeyFile();
    kf.load_from_file(path, GLib.KeyFileFlags.KEEP_COMMENTS);
    kf.set_boolean(name, 'enabled', value);
    kf.save_to_file(path);
}

// Resolves to 'OK' or a short problem description; never rejects.
export function fetchStatus(session, {url, headers, okRegex, problemRegex}) {
    return new Promise(resolve => {
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (e) {}
        if (!msg)
            return resolve(`bad url: ${url}`);
        // set here, not on the Session: a Session user_agent would override the configured header
        for (const [name, value] of Object.entries({'User-Agent': DEFAULT_USER_AGENT, ...headers}))
            msg.request_headers.replace(name, value);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const body = new TextDecoder().decode(s.send_and_read_finish(res).get_data());
                if (msg.get_status() !== 200)
                    return resolve(`HTTP ${msg.get_status()}`);
                if (okRegex.test(body))
                    return resolve('OK');
                const found = problemRegex ? [...body.matchAll(problemRegex)].map(m => m[1] ?? m[0]) : [];
                resolve(found.length ? found.join(', ') : `unexpected response: ${body.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
            } catch (e) {
                resolve(`error: ${e.message}`);
            }
        });
    });
}
