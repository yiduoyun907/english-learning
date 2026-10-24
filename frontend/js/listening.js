import ListeningView from '../src/views/ListeningView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(ListeningView, { activeNav: '/listening.html' }).catch((error) => toast(error.message));
