<script setup>
import { toastState } from '../composables/useToast.js';
</script>

<template>
  <div class="toast" :class="{ show: toastState.visible }" role="status" aria-live="polite">
    {{ toastState.message }}
  </div>
</template>
