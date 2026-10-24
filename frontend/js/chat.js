import ChatView from '../src/views/ChatView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(ChatView, { activeNav: '/chat.html' }).catch((error) => toast(error.message));
