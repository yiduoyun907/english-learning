import SettingsView from '../src/views/SettingsView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(SettingsView, { activeNav: '/settings.html' }).catch((error) => toast(error.message));
