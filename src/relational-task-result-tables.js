export const TASK_BACKUP_TABLES = {
  local_task_receipts: ['store_id', 'task_id', 'request_hash', 'actor_id', 'device_id', 'task_type', 'entity_id', 'completed_at', 'ledger_epoch'],
  task_member_results: ['store_id', 'task_id', 'member_id', 'name', 'phone', 'notes', 'balance_cents', 'profile_version', 'account_version', 'created_at', 'updated_at', 'archived_at'],
  task_member_tags: ['store_id', 'task_id', 'tag'],
  task_configuration_results: ['store_id', 'task_id', 'version', 'gift_enabled', 'gift_rate_basis_points'],
  task_configuration_services: ['store_id', 'task_id', 'position', 'id', 'name', 'price_cents'],
  task_configuration_plans: ['store_id', 'task_id', 'position', 'id', 'pay_cents', 'gift_cents']
};
