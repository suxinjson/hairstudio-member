import { BACKUP_TABLES } from './relational-backup-rows.js';
import { BATCH_TABLES } from './relational-batches.js';
export const PG_BASE_TABLES = ['member_profiles', 'member_tags', 'member_accounts', 'account_opening_batches', 'account_openings',
  'ledger_entries', 'ledger_reversals', 'service_catalog', 'recharge_plan_items', 'store_recharge_settings',
  'consumption_items', 'payment_records', 'recharge_details'];
export const PG_BACKUP_TABLES = {
  actors: ['id', 'store_id', 'display_name', 'created_at'],
  ...Object.fromEntries(PG_BASE_TABLES.map(table => [table, [...BACKUP_TABLES[table], ...({
    member_profiles: ['phone_normalized'], member_accounts: ['updated_at'], account_opening_batches: ['imported_by'],
    account_openings: ['row_digest', 'confirmed_at'], ledger_entries: ['recorded_at'], ledger_reversals: ['created_at'],
    service_catalog: ['version'], store_recharge_settings: ['updated_at']
  }[table] ?? [])]])),
  ledger_command_receipts: ['store_id', 'command_id', 'ledger_epoch', 'actor_id', 'device_id', 'request_hash', 'command_type', 'result', 'created_at'],
  application_task_receipts: ['store_id', 'task_id', 'ledger_epoch', 'actor_id', 'device_id', 'request_hash', 'task_type', 'entity_id', 'result', 'completed_at'],
  ...BATCH_TABLES,
  store_change_heads: ['store_id', 'head'],
  store_changes: ['store_id', 'cursor', 'entity_type', 'entity_id', 'change_type', 'recorded_at'],
  audit_events: ['store_id', 'event_id', 'user_id', 'device_id', 'event', 'details', 'occurred_at', 'received_at'],
  ledger_restore_receipts: ['store_id', 'task_id', 'actor_id', 'device_id', 'target_epoch', 'source_epoch', 'restored_epoch', 'source_digest', 'member_count', 'entry_count', 'completed_at']
};
