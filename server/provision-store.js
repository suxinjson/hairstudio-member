import { randomUUID } from 'node:crypto';
export async function provisionStore(client, { username, passwordHash, displayName, storeName, storeId = randomUUID() }) {
  const userId = randomUUID();
  await client.query('INSERT INTO stores(id,name) VALUES($1,$2)', [storeId, storeName]);
  await client.query('INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)', [userId, storeId, username, displayName, passwordHash, 'owner']);
  await client.query('INSERT INTO store_recharge_settings(store_id) VALUES($1)', [storeId]);
  return { userId, storeId };
}
