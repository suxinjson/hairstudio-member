// Legacy business tests exercise already sold stores. New platform/license tests
// import the production service directly and cover its default-deny behavior.
import { randomUUID } from 'node:crypto';
import { createService as productionService } from '../../service.js';
import { LICENSE_FEATURES } from '../../../src/license-policy.js';
export function createService(pool, options) {
  const service = productionService(pool, options), create = service.createOwner;
  service.createOwner = async input => {
    const result = await create(input);
    await pool.query('INSERT INTO store_licenses(id,store_id,features,offline_hours,starts_at) VALUES($1,$2,$3,8760,$4)',
      [randomUUID(), result.storeId, JSON.stringify(LICENSE_FEATURES), new Date(Date.now() - 60000).toISOString()]);
    return result;
  };
  return service;
}
