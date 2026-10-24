import LoginView from '../src/views/LoginView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(LoginView, { requiresAuth: false }).catch((error) => toast(error.message));
