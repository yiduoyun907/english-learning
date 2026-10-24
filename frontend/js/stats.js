import StatsView from '../src/views/StatsView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(StatsView, { activeNav: '/stats.html' }).catch((error) => toast(error.message));
