<template>
  <section class="book-panel book-stack" aria-label="应用更新">
    <h3>应用更新</h3>
    <button type="button" :disabled="busy || !canCheck" @click="check">{{ job === 'check' ? '正在检查…' : '检查更新' }}</button>
    <div v-if="update" class="book-stack">
      <p>新版本 {{ update.versionName }}</p>
      <p v-if="update.notes" class="whitespace-pre-wrap">{{ update.notes }}</p>
      <p v-if="job === 'download'" role="status">下载中 {{ progress }}%</p>
      <button v-if="!file" type="button" class="book-primary" :disabled="busy || !canCheck" @click="download">下载并安装更新</button>
      <button v-else type="button" :disabled="busy" @click="install">继续安装更新</button>
    </div>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </section>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
const props = defineProps({ api: Object, checkUpdate: Function, beforeInstall: Function, canCheck: Boolean, origin: String,
  availableUpdate: Object, autoStartDownload: Boolean, updateResumeToken: Number });
const emit = defineEmits(['auto-start-consumed']);
const update = shallowRef(null), file = shallowRef(null), progress = ref(0), message = ref(''), failed = ref(false), job = ref('');
const busy = computed(() => Boolean(job.value));
const storageKey = 'member.pending-update-install.v2';
let live = true, awaitingInstaller = false;
onScopeDispose(() => { live = false; });

function clear() {
  file.value = null; awaitingInstaller = false;
  try { localStorage.removeItem(storageKey); } catch {}
}
function matches(a, b) { return a && b && a.sha256 === b.sha256 && a.versionCode === b.versionCode; }
function save() {
  const { versionCode, versionName, notes, sha256 } = update.value;
  try { localStorage.setItem(storageKey, JSON.stringify({ origin: props.origin, manifest: { versionCode, versionName, notes, sha256 }, awaitingInstaller })); } catch {}
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!saved || saved.origin !== props.origin) return;
    const manifest = saved.manifest;
    if (!/^[a-f0-9]{64}$/.test(manifest?.sha256 || '') || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1) return;
    update.value = manifest; file.value = { fileName: manifest.sha256 + '.apk', verified: true };
    awaitingInstaller = saved.awaitingInstaller === true;
  } catch {}
}
restore();
watch(() => props.availableUpdate, (manifest, previous) => {
  // Preserve a verified file on startup until a check replaces or withdraws its release.
  if (!manifest && !previous && file.value) return;
  if (file.value && !matches(update.value, manifest)) clear();
  if (!matches(update.value, manifest)) { message.value = ''; failed.value = false; }
  update.value = manifest || null;
}, { immediate: true });

async function operate(name, action) {
  if (busy.value || !live) return;
  job.value = name; message.value = ''; failed.value = false;
  try { await action(); }
  catch (error) { if (live) { failed.value = true; message.value = error.message; } }
  finally { job.value = ''; }
}
function check() {
  void operate('check', async () => {
    const manifest = await props.checkUpdate(); if (!live) return;
    if (!matches(manifest, update.value)) clear();
    update.value = manifest;
    if (!manifest) message.value = '当前没有可用的新版本';
  });
}
async function openInstaller() {
  const manifest = update.value, packageFile = file.value;
  const stillSelected = () => live && matches(update.value, manifest) && file.value === packageFile;
  const installedBuild = await props.api.installedBuild(); if (!stillSelected()) return;
  if (installedBuild >= manifest.versionCode) {
    clear(); update.value = null; message.value = '更新已完成。'; return;
  }
  await props.beforeInstall(); if (!stillSelected()) return;
  awaitingInstaller = true; save();
  try {
    const result = await props.api.install(packageFile, manifest);
    if (!stillSelected()) return;
    awaitingInstaller = result.status === 'installer-opened'; save();
    message.value = result.status === 'permission-required'
      ? '尚未允许安装。可以点击“继续安装更新”重新授权。'
      : '已打开系统安装界面，请确认安装。';
  } catch (error) {
    if (!stillSelected()) return;
    awaitingInstaller = false; save();
    if (/^(请先下载|安装包|更新版本号|此更新)/.test(error.message || '')) clear();
    throw error;
  }
}
function download() {
  if (!props.canCheck || !update.value) return;
  const manifest = update.value;
  const stillSelected = () => live && matches(update.value, manifest);
  void operate('download', async () => {
    progress.value = 0;
    await props.beforeInstall(); if (!stillSelected()) return;
    let downloaded;
    try { downloaded = await props.api.download(manifest, value => { if (stillSelected()) progress.value = value; }); }
    catch (error) { if (stillSelected()) throw error; return; }
    if (!stillSelected()) return;
    file.value = downloaded; save(); await openInstaller();
  });
}
function install() { if (file.value) void operate('install', openInstaller); }
watch(() => [props.autoStartDownload, props.availableUpdate], ([requested, manifest]) => {
  if (!requested || !manifest || busy.value) return;
  emit('auto-start-consumed');
  if (file.value && matches(update.value, manifest)) install();
  else { clear(); update.value = manifest; download(); }
}, { immediate: true });
watch(() => props.updateResumeToken, () => {
  if (file.value && awaitingInstaller && !busy.value && !props.autoStartDownload) install();
}, { immediate: true });
</script>
