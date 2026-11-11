<template>
  <div
    v-if="modal"
    class="app-modal-backdrop feedback-backdrop fixed inset-0 z-[75] flex items-center justify-center p-5 animate-fade-in backdrop-blur-xs"
    @click.self="emit('cancel')"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-modal-title"
  >
    <section
      class="app-modal-surface feedback-dialog confirm-dialog w-full max-w-sm bg-white text-center shadow-2xl"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div
        class="feedback-icon mx-auto"
        :class="modal.type === 'danger' ? 'feedback-icon-error' : 'confirm-icon-warning'"
      >
        <span v-if="modal.type === 'danger'" aria-hidden="true">⚠️</span>
        <span v-else aria-hidden="true">❓</span>
      </div>
      <h2 id="confirm-modal-title" class="mt-4 text-2xl font-black text-slate-900">
        {{ modal.title }}
      </h2>
      <p class="mt-2.5 text-base leading-relaxed text-slate-600 font-medium whitespace-pre-line text-center">
        {{ modal.message }}
      </p>
      <div class="mt-6 grid grid-cols-2 gap-3">
        <button
          type="button"
          @click="emit('cancel')"
          class="h-13 rounded-2xl border-2 border-slate-300 text-base font-bold text-slate-700 active:bg-slate-100 btn-press"
        >
          {{ modal.cancelText || '取消' }}
        </button>
        <button
          type="button"
          @click="emit('accept')"
          class="confirm-modal-submit h-13 rounded-2xl text-base font-black text-white shadow-md btn-press"
          :class="modal.type === 'danger' ? 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 shadow-rose-500/25' : 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 shadow-indigo-500/25'"
          autofocus
        >
          {{ modal.confirmText || '确定' }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
defineProps({
  modal: { type: Object, default: null }
});

const emit = defineEmits(['accept', 'cancel']);
</script>
