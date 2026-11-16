// Run: gjs -m test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {DEFAULT_USER_AGENT, ensureConfig, fetchStatus, loadConfig, setEnabled} from './lib.js';

const eq = (a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`expected ${JSON.stringify(b)}\n     got ${JSON.stringify(a)}`);
};
const throws = fn => {
    try { fn(); } catch (e) { return; }
    throw new Error('expected an exception');
};
const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const ini = GLib.build_filenamev([GLib.get_tmp_dir(), `selfcheck-watch-test-${GLib.random_int()}.ini`]);
const write = s => GLib.file_set_contents(ini, s);

// --- config ---
write(`# top comment
[general]
interval_minutes=5
header.User-Agent=ua-general
header.X-Common=c
[a]
# a comment
url=https://a/
header.User-Agent=ua-a
[b]
url=https://b/
enabled=false
[not-an-endpoint]
foo=bar
`);
eq(loadConfig(ini), {intervalMin: 5, timeoutSec: 30, endpoints: [
    {name: 'a', url: 'https://a/', enabled: true, headers: {'User-Agent': 'ua-a', 'X-Common': 'c'}},
    {name: 'b', url: 'https://b/', enabled: false, headers: {'User-Agent': 'ua-general', 'X-Common': 'c'}},
]});
setEnabled('a', false, ini);
setEnabled('b', true, ini);
eq(loadConfig(ini).endpoints.map(e => e.enabled), [false, true]);
if (!read(ini).includes('# top comment') || !read(ini).includes('# a comment'))
    throw new Error(`comments lost:\n${read(ini)}`);

write('[a]\nurl=https://a/\n');
eq(loadConfig(ini), {intervalMin: 30, timeoutSec: 30, endpoints: [{name: 'a', url: 'https://a/', enabled: true, headers: {}}]});
write('[general]\ninterval_minutes=0\n');
throws(() => loadConfig(ini));
write('[general]\ntimeout_seconds=abc\n');
throws(() => loadConfig(ini));
throws(() => loadConfig('/nonexistent/selfcheck-watch.ini'));
GLib.unlink(ini);

// --- first run: config created from the example, never overwritten ---
const dir = GLib.dir_make_tmp('selfcheck-watch-XXXXXX');
const fresh = GLib.build_filenamev([dir, 'sub', 'selfcheck-watch.ini']);
const example = GLib.build_filenamev([GLib.get_current_dir(), 'config.example.ini']);
ensureConfig(example, fresh);
eq(read(fresh), read(example));
eq(Gio.File.new_for_path(fresh).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777, 0o600);
eq(loadConfig(fresh).endpoints.map(e => e.enabled), [false, false]); // placeholders must not alert
GLib.file_set_contents(fresh, 'mine');
ensureConfig(example, fresh);
eq(read(fresh), 'mine');
GLib.unlink(fresh);
GLib.rmdir(GLib.path_get_dirname(fresh));
GLib.rmdir(dir);

// --- HTTP, against a local server ---
const server = new Soup.Server();
server.add_handler(null, (_s, msg, path) => {
    const ua = msg.get_request_headers().get_one('User-Agent');
    const body = {
        '/ok': '{"status":"OK","messages":[]}',
        '/warn': '{"status":"WARNING","messages":["basket 1","basket 2"]}',
        '/junk': 'not json',
        '/ua': JSON.stringify({status: ua}),
    }[path];
    msg.set_status(body ? 200 : 500, null);
    msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(body ?? ''));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const base = server.get_uris()[0].to_string().replace(/\/$/, '');
const session = new Soup.Session({timeout: 5});
const get = (path, headers = {}) => fetchStatus(session, {url: base + path, headers});

const loop = new GLib.MainLoop(null, false);
let failure = null;
(async () => {
    eq(await get('/ok'), 'OK');
    eq(await get('/warn'), 'WARNING basket 1; basket 2');
    eq(await get('/boom'), 'HTTP 500');
    eq((await get('/junk')).startsWith('error: '), true);
    eq(await get('/ua'), `${DEFAULT_USER_AGENT} `);
    eq(await get('/ua', {'User-Agent': 'custom-ua'}), 'custom-ua ');
    eq(await fetchStatus(session, {url: 'not a url', headers: {}}), 'bad url: not a url');
})().catch(e => (failure = e)).finally(() => loop.quit());
loop.run();
if (failure)
    throw failure;
print('all tests passed');
