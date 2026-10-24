import BooksView from '../src/views/BooksView.vue';
import { mountPage } from '../src/lib/page.js';
import { toast } from './ui.js';

mountPage(BooksView, { activeNav: '/books.html' }).catch((error) => toast(error.message));
