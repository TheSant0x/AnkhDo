import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AnkhDoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Appearance'});
        const lightRow = new Adw.SwitchRow({
            title: 'Off-white theme',
            subtitle: 'A light papyrus look instead of black basalt',
        });
        settings.bind('light-theme', lightRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        group.add(lightRow);
        page.add(group);
        window.add(page);
    }
}
