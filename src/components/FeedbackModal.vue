<template>
  <div
    v-if="modal"
    class="feedback-backdrop fixed inset-0 z-[70] flex items-center justify-center p-5 animate-fade-in"
    @click.self="emit('close')"
    role="presentation"
  >
    <section
      class="feedback-dialog w-full max-w-sm bg-white text-center shadow-2xl"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      <div
        class="feedback-icon mx-auto"
        :class="modal.type === 'success' ? 'feedback-icon-success' : 'feedback-icon-error'"
      >
        {{ modal.type === 'success' ? '✓' : '!' }}
      </div>
      <h2 id="feedback-title" class="mt-4 text-2xl font-black text-slate-900">{{ modal.title }}</h2>
      <p class="mt-2 text-base leading-relaxed text-slate-700">{{ modal.message }}</p>
      <div v-if="modal.amount" class="feedback-amount mt-5 rounded-xl px-4 py-3">
        <div class="text-sm font-bold text-slate-600">本次扣款</div>
        <div class="mt-1 text-3xl font-black tabular-nums text-rose-700">¥ {{ modal.amount }}</div>
        <div
          class="mt-2 text-base font-bold text-slate-700"
          :class="{ 'balance-debt': modal.debt }"
        >
          {{ modal.memberName }} · {{ modal.debt ? '累计欠款' : '扣后余额' }} ¥{{ modal.debt || modal.balance }}
        </div>
      </div>
      <button
        @click="emit('close')"
        class="feedback-confirm mt-6 w-full h-14 rounded-xl text-lg font-black text-white btn-press"
        :class="modal.type === 'success' ? 'bg-emerald-700' : 'bg-slate-800'"
        autofocus
      >
        知道了
      </button>
    </section>
  </div>
</template>

<script setup>
defineProps({
  modal: { type: Object, default: null }
});

const emit = defineEmits(['close']);
</script>
