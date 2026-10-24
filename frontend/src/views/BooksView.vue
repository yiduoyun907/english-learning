<script setup>
import { onMounted, ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';
import { updateSettings } from '../stores/session.js';

const books = ref([]);
const activeBook = ref(null);

onMounted(async () => {
  try {
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

async function refresh() {
  const data = await api('/api/wordbooks');
  books.value = data.books;
  activeBook.value = data.activeBook;
}

function isActive(book) {
  return book.code === activeBook.value;
}

function percent(book) {
  return book.wordCount > 0 ? Math.round((book.learnedCount / book.wordCount) * 100) : 0;
}

async function selectBook(book) {
  if (isActive(book)) return;

  try {
    const data = await api(`/api/wordbooks/${book.code}/select`, { method: 'POST' });
    activeBook.value = data.activeBook;
    updateSettings({ activeBook: data.activeBook });
    showToast(`已切换到《${book.name}》`);
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
}
</script>

<template>
  <main class="container">
    <h1>词书</h1>
    <p class="muted small">选择一本词书，新词会按词频从常见到生僻依次出现</p>

    <div class="card" id="book-list" style="margin-top:20px;">
      <div
        v-for="book in books"
        :key="book.code"
        class="list-item selectable"
        @click="selectBook(book)"
      >
        <div style="flex:1;min-width:0;">
          <div class="row" style="gap:8px;">
            <strong>{{ book.name }}</strong>
            <span v-if="isActive(book)" class="badge">当前使用</span>
          </div>
          <div class="small muted">{{ book.description }}</div>
          <div class="progress-bar"><span :style="{ width: percent(book) + '%' }"></span></div>
          <div class="small muted" style="margin-top:4px;">
            已学 {{ book.learnedCount }} / {{ book.wordCount }}
          </div>
        </div>
        <span class="small muted">{{ percent(book) }}%</span>
      </div>
    </div>
  </main>
</template>
