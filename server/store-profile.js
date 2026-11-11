import { normalizeStoreProfile } from '../src/store-profile.js';
export async function readStoreProfile(client, storeId) {
  const { rows: [store] } = await client.query('SELECT name,profile,profile_version FROM stores WHERE id=$1', [storeId]);
  return normalizeStoreProfile({ ...store.profile, name: store.name, version: store.profile_version });
}
