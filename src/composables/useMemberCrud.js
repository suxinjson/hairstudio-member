import { ref } from 'vue';
import { canonicalJSON, mutationPrecondition } from '../sync-protocol.js';
import { sameNameMembers, sameNameMemberPrompt, memberIdentitySignature } from '../member-identity.js';

export function useMemberCrud({ localDb, refreshAll, selectMember, showToast, showFeedback, askConfirm, selectedMember }) {
  const showMemberModal = ref(false);
  const isSavingMember = ref(false);
  const editingMemberId = ref(null);
  let editBaseline = null;
  const memberForm = ref({
    name: '',
    phone: '',
    initialBalance: 0,
    notes: ''
  });

  function openNewMemberModal() {
    editingMemberId.value = null;
    editBaseline = null;
    memberForm.value = {
      name: '',
      phone: '',
      initialBalance: 0,
      notes: ''
    };
    showMemberModal.value = true;
  }

  function openEditMemberModal(m) {
    editingMemberId.value = m.id;
    editBaseline = mutationPrecondition({ members: [m] }, 'updateMember', [m.id]);
    memberForm.value = {
      name: m.name,
      phone: m.phone,
      notes: m.notes || ''
    };
    showMemberModal.value = true;
  }

  async function submitMemberForm() {
    if (isSavingMember.value || !showMemberModal.value) return;
    isSavingMember.value = true;
    try {
      const form = memberForm.value, memberId = editingMemberId.value;
      const draft = { ...form };
      const identity = { ...draft, id: memberId };
      const matches = sameNameMembers(localDb.getMembers(), identity);
      if (matches.length) {
        const signature = memberIdentitySignature(matches);
        const confirmed = await askConfirm(sameNameMemberPrompt(identity, matches));
        if (!confirmed || !showMemberModal.value || memberForm.value !== form || editingMemberId.value !== memberId) return;
        if (canonicalJSON(draft) !== canonicalJSON(memberForm.value)) throw new Error('填写的会员资料已变化，请核对后重新保存');
        if (signature !== memberIdentitySignature(sameNameMembers(localDb.getMembers(), identity))) {
          throw new Error('同名会员资料已变化，请核对后重新保存');
        }
      }
      if (editingMemberId.value) {
        const current = mutationPrecondition({ members: localDb.getMembers() }, 'updateMember', [editingMemberId.value]);
        if (canonicalJSON(current) !== canonicalJSON(editBaseline)) throw new Error('会员档案已变化，请重新打开编辑窗口核对后保存');
        let updated = localDb.updateMember(editingMemberId.value, draft);
        if (updated?.then) updated = await updated;
        showMemberModal.value = false;
        showToast('会员档案修改成功！');
        refreshAll();
        selectMember(updated);
      } else {
        let created = localDb.createMember(draft);
        if (created?.then) created = await created;
        showMemberModal.value = false;
        showToast(`会员 ${created.name} 建档成功！`);
        refreshAll();
        selectMember(created);
      }
    } catch (err) {
      showFeedback(err.message);
    } finally {
      isSavingMember.value = false;
    }
  }

  async function handleDeleteMember(m) {
    if (m.balance < 0) {
      showFeedback('该会员尚有未结清欠款，不能注销。请先充值或结清欠款。', 'error', { title: '无法注销欠款会员' });
      return;
    }
    const confirmed = await askConfirm({
      title: '注销会员确认',
      message: `确定要注销会员「${m.name}」吗？\n注销后该会员将从列表中移除，历史档案和交易流水将完整保留用于核算对账。`,
      confirmText: '确认注销',
      cancelText: '取消',
      danger: true
    });
    if (!confirmed) return;
    try {
      const result = localDb.deleteMember(m.id);
      if (result?.then) await result;
      selectedMember.value = null;
      showToast('会员档案已注销');
      refreshAll();
    } catch (err) {
      showFeedback(err.message);
    }
  }

  return {
    showMemberModal,
    isSavingMember,
    editingMemberId,
    memberForm,
    openNewMemberModal,
    openEditMemberModal,
    submitMemberForm,
    handleDeleteMember
  };
}
