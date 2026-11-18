import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CONFIG, ensureConfig, fetchStatus, loadConfig, setEnabled} from './lib.js';

const ICON_OK = 'emblem-default-symbolic';
const ICON_PROBLEM = 'dialog-warning-symbolic';

const infoItem = text => new PopupMenu.PopupMenuItem(text, {reactive: false});

export default class SelfcheckWatch extends Extension {
    enable() {
        this._session = new Soup.Session();
        this._button = new PanelMenu.Button(0.0, this.metadata.name);
        this._icon = new St.Icon({icon_name: ICON_OK, style_class: 'system-status-icon'});
        this._button.add_child(this._icon);

        const menu = this._button.menu;
        menu.addAction('Check now', () => this._check());
        menu.addAction('Edit config', () =>
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(CONFIG, null), null));
        this._lastChecked = infoItem('Last checked: never');
        menu.addMenuItem(this._lastChecked);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._section = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._section);

        Main.panel.addToStatusArea(this.uuid, this._button);
        this._schedule(30);
        this._check();
    }

    disable() {
        GLib.source_remove(this._timer);
        this._session.abort();
        this._button.destroy();
        this._timer = this._intervalMin = null;
        this._button = this._session = this._section = this._icon = this._lastChecked = this._groups = null;
    }

    // (Re)starts the check timer; a no-op when the interval has not changed.
    _schedule(minutes) {
        if (minutes === this._intervalMin)
            return;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._intervalMin = minutes;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _check() {
        const gen = this._gen = (this._gen ?? 0) + 1;
        this._lastChecked.label.text = 'Checking…';
        const {endpoints, bad} = await this._poll();
        if (!this._button || gen !== this._gen)
            return; // disabled while fetching, or a newer check started - let it render
        this._render(endpoints, bad);
    }

    // Reads the config and checks every enabled endpoint. Never rejects: config errors end up in `bad`.
    async _poll() {
        try {
            ensureConfig(GLib.build_filenamev([this.path, 'config.example.ini']));
            const cfg = loadConfig();
            this._schedule(cfg.intervalMin); // picks up interval changes from the config
            this._session.timeout = cfg.timeoutSec;
            const {endpoints} = cfg;
            const results = await Promise.all(endpoints.map(e => e.enabled ? fetchStatus(this._session, e) : null));
            endpoints.forEach((e, i) => (e.result = results[i]));
            const bad = endpoints.filter(e => e.enabled && e.result !== 'OK').map(e => `${e.name}: ${e.result}`);
            return {endpoints, bad};
        } catch (e) {
            return {endpoints: [], bad: [`config error: ${e.message}`]};
        }
    }

    _render(endpoints, bad) {
        this._lastChecked.label.text = `Last checked: ${GLib.DateTime.new_now_local().format('%H:%M:%S')}`;
        // keep groups expanded across re-renders (e.g. after a toggle)
        const wasOpen = Object.fromEntries(Object.entries(this._groups ?? {}).map(([k, m]) => [k, m.isOpen]));
        this._section.removeAll();
        this._groups = {};
        for (const e of endpoints.filter(e => e.enabled && e.result !== 'OK'))
            this._section.addMenuItem(this._endpointItem(e));
        this._addGroup('OK', endpoints.filter(e => e.enabled && e.result === 'OK'), wasOpen);
        this._addGroup('Disabled', endpoints.filter(e => !e.enabled), wasOpen);
        if (!endpoints.length)
            this._section.addMenuItem(infoItem(bad[0] ?? 'no endpoints in config'));
        this._icon.icon_name = bad.length ? ICON_PROBLEM : ICON_OK;
        if (bad.length)
            Main.notify(`${this.metadata.name}: problem`, bad.join('\n'));
    }

    // Collapsed submenu "<title> (N)"; skipped when empty.
    _addGroup(title, endpoints, wasOpen) {
        if (!endpoints.length)
            return;
        const sub = new PopupMenu.PopupSubMenuMenuItem(`${title} (${endpoints.length})`);
        endpoints.forEach(e => sub.menu.addMenuItem(this._endpointItem(e)));
        this._section.addMenuItem(sub);
        if (wasOpen[title])
            sub.menu.open(false);
        this._groups[title] = sub.menu;
    }

    _endpointItem(e) {
        const text = !e.enabled ? e.name :e.result === 'OK' ? `✅ ${e.name}` : `⚠️ ${e.name}: ${e.result}`;
        const item = new PopupMenu.PopupSwitchMenuItem(text, e.enabled);
        if (!e.enabled)
            item.label.opacity = 110; // dim disabled endpoints
        item.connect('toggled', (_item, value) => {
            try {
                setEnabled(e.name, value);
            } catch (err) {
                Main.notify(this.metadata.name, `cannot save config: ${err.message}`);
            }
            this._check();
        });
        return item;
    }
}
