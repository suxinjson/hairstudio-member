<template><StoreSettings :profile="adminApi.storeProfile.value" :can-edit="adminApi.user.value?.role === 'owner'"
  :save-profile="save" :load-profile="load" /></template>
<script setup>
import StoreSettings from '../../../src/components/StoreSettings.vue';
import { adminApi } from '../api/client.js';
const save = (profile, version) => adminApi.saveStoreProfile(profile, version);
const load = () => adminApi.loadStoreProfile();
</script>
