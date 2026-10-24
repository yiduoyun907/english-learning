<script setup>
import { onMounted, ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';

const LEVEL_LABELS = { beginner: '初级', intermediate: '中级', advanced: '高级' };

const supported = ref('speechSynthesis' in window);
const sections = ref([]);

onMounted(async () => {
  if (!supported.value) return;

  try {
    const data = await api('/api/listening/materials');
    render(data.materials);
  } catch (error) {
    showToast(error.message);
  }
});

function render(materials) {
  const cet = materials.filter((item) => item.source.startsWith('cet'));
  const voa = materials.filter((item) => item.source === 'voa');
  const original = materials.filter((item) => item.source === 'original');

  const next = [];
  if (voa.length) {
    next.push(
      buildSection('VOA 慢速英语', '美国之音为学习者编写 · 美国政府作品，公有领域', voa, (item) => item.topic || '综合')
    );
  }
  if (cet.length) {
    next.push(
      buildSection(
        '四六级听力真题',
        '历年真题听力原文 · 著作权归考试主办方，仅供个人学习使用',
        cet,
        (item) => `${item.source.startsWith('cet6') ? '六级' : '四级'} · ${item.topic || '真题'}`
      )
    );
  }
  if (original.length) {
    next.push(
      buildSection(
        '本站原创短文',
        '读过之后可以到「阅读」模块精读同一篇',
        original,
        (item) => LEVEL_LABELS[item.level] || item.level
      )
    );
  }

  sections.value = next;
}

function buildSection(title, hint, items, groupKey) {
  const groups = [];

  for (const item of items) {
    const key = groupKey(item);
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  return { title, hint, groups };
}

function subheadingStyle(index) {
  return {
    padding: '12px 0 4px',
    borderTop: index > 0 ? '1px solid var(--border)' : 'none',
    marginTop: index > 0 ? '6px' : '0',
  };
}

function accuracyText(material) {
  return material.attemptCount > 0 ? `${Math.round(material.avgAccuracy * 100)}%` : '未练习';
}

function subtitle(material) {
  const base = material.titleZh
    ? `${material.titleZh} · ${material.sentenceCount} 句`
    : `${material.sentenceCount} 句`;
  return material.attemptCount > 0 ? `${base} · 练过 ${material.attemptCount} 次` : base;
}

function goListen(event, material) {
  if (event.target.closest('a')) return;
  location.href = `/listen.html?slug=${encodeURIComponent(material.slug)}`;
}
</script>

<template>
  <main class="container">
    <h1>听力</h1>
    <p class="muted small">
      逐句听写：播放一句话，写下你听到的内容，系统会逐词比对你哪里没听出来。
      材料包含美国之音慢速英语与本站原创短文两类。
    </p>

    <div id="material-list" style="margin-top:20px;">
      <div v-if="!supported" class="card">
        <p class="muted small" style="margin:0;">
          当前浏览器不支持语音合成，听力练习需要 Chrome、Edge 或 Safari。
        </p>
      </div>

      <template v-for="section in sections" :key="section.title">
        <div class="group-heading">
          <strong>{{ section.title }}</strong>
          <span class="muted small">{{ section.hint }}</span>
        </div>

        <div class="card" style="margin-bottom:20px;">
          <template v-for="(group, index) in section.groups" :key="group.key">
            <div v-if="section.groups.length > 1" class="small muted" :style="subheadingStyle(index)">
              {{ group.key }}
            </div>

            <div
              v-for="material in group.items"
              :key="material.slug"
              class="list-item selectable"
              @click="goListen($event, material)"
            >
              <div style="flex:1;min-width:0;">
                <strong>{{ material.title }}</strong>
                <div class="small muted">{{ subtitle(material) }}</div>
                <a
                  v-if="material.attribution"
                  class="small muted"
                  :href="material.sourceUrl || '#'"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ material.attribution }}
                </a>
              </div>
              <span class="small" :class="material.attemptCount > 0 ? 'badge' : 'muted'">
                {{ accuracyText(material) }}
              </span>
            </div>
          </template>
        </div>
      </template>
    </div>
  </main>
</template>
