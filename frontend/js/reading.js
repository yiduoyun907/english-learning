import ReadingView from '../src/views/ReadingView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(ReadingView, { activeNav: '/reading.html' }).catch((error) => toast(error.message));
