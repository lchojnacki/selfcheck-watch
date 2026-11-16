import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CONFIG, ensureConfig, fetchStatus, loadConfig, setEnabled} from './lib.js';

export default class SelfcheckWatch extends Extension {
    enable() {
        this._session = new Soup.Session();
        this._button = new PanelMenu.Button(0.0, this.metadata.name);
        this._icon = new St.Icon({icon_name: 'emblem-default-symbolic', style_class: 'system-status-icon'});
        this._button.add_child(this._icon);
        this._button.menu.addAction('Check now', () => this._check());
        this._button.menu.addAction('Edit config', () =>
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(CONFIG, null), null));
        this._lastChecked = new PopupMenu.PopupMenuItem('Last checked: never', {reactive: false});
        this._button.menu.addMenuItem(this._lastChecked);
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._section = new PopupMenu.PopupMenuSection();
        this._button.menu.addMenuItem(this._section);
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._schedule(30);
        this._check();
    }

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

    disable() {
        GLib.source_remove(this._timer);
        this._session.abort();
        this._button.destroy();
        this._timer = this._intervalMin = null;
        this._button = this._session = this._section = this._icon = this._lastChecked = null;
    }

    async _check() {
        const gen = this._gen = (this._gen ?? 0) + 1;
        let endpoints = [], bad = [];
        try {
            ensureConfig(GLib.build_filenamev([this.path, 'config.example.ini']));
            const cfg = loadConfig();
            this._schedule(cfg.intervalMin); // picks up interval changes from the config
            this._session.timeout = cfg.timeoutSec;
            endpoints = cfg.endpoints;
            const results = await Promise.all(endpoints.map(e => e.enabled ? fetchStatus(this._session, e) : null));
            endpoints.forEach((e, i) => (e.result = results[i]));
            bad = endpoints.filter(e => e.enabled && e.result !== 'OK').map(e => `${e.name}: ${e.result}`);
        } catch (e) {
            bad = [`config error: ${e.message}`];
        }
        if (!this._button || gen !== this._gen)
            return; // disabled while fetching, or a newer check started - let it render
        this._lastChecked.label.text = `Last checked: ${GLib.DateTime.new_now_local().format('%H:%M:%S')}`;
        this._section.removeAll();
        for (const e of endpoints) {
            const item = new PopupMenu.PopupSwitchMenuItem(e.enabled ? `${e.name}: ${e.result}` : `${e.name}: off`, e.enabled);
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
            this._section.addMenuItem(item);
        }
        if (bad.length && !endpoints.length)
            this._section.addMenuItem(new PopupMenu.PopupMenuItem(bad[0], {reactive: false}));
        else if (!endpoints.length)
            this._section.addMenuItem(new PopupMenu.PopupMenuItem('no endpoints in config', {reactive: false}));
        this._icon.icon_name = bad.length ? 'dialog-warning-symbolic' : 'emblem-default-symbolic';
        if (bad.length)
            Main.notify(`${this.metadata.name}: problem`, bad.join('\n'));
    }
}
