<script setup>
import { NAV_ITEMS } from '../lib/nav.js';

defineProps({
  active: {
    type: String,
    default: '',
  },
});
</script>

<template>
  <nav class="nav">
    <div class="nav-inner">
      <a class="nav-brand" href="/index.html">英语学习</a>
      <a
        v-for="item in NAV_ITEMS"
        :key="item.href"
        class="nav-link"
        :class="{ active: item.href === active }"
        :href="item.href"
      >
        {{ item.label }}
      </a>
    </div>
  </nav>
</template>
