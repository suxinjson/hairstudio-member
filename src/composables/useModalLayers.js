import { onMounted, onScopeDispose } from 'vue';

// One owner per cashier root. Nested sheets keep their own return focus;
// background controls are inert until the last sheet has closed.
export function useModalLayers({ onEscape } = {}) {
  let observer, root, active = null, overflow = null, lastTrigger = null;
  const frames = new Map(), blocked = new Map();
  const visible = element => {
    for (let node = element; node instanceof window.HTMLElement; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  function restoreBackground() {
    for (const [element, original] of blocked) {
      if (original === null) element.removeAttribute('inert');
      else element.setAttribute('inert', original);
    }
    blocked.clear();
  }
  function blockBackground(layer) {
    restoreBackground();
    for (let node = layer; node && node !== root; node = node.parentElement) {
      for (const sibling of node.parentElement?.children || []) {
        if (sibling === node || blocked.has(sibling)) continue;
        blocked.set(sibling, sibling.getAttribute('inert'));
        sibling.setAttribute('inert', '');
      }
    }
  }
  const focus = element => {
    if (element?.isConnected && visible(element) && !element.closest('[inert]')) element.focus({ preventScroll: true });
  };
  function sync() {
    const layers = [...(root?.querySelectorAll('.app-modal-backdrop') || [])].filter(visible);
    layers.sort((a, b) => (Number.parseInt(window.getComputedStyle(a).zIndex) || 0) - (Number.parseInt(window.getComputedStyle(b).zIndex) || 0));
    const next = layers.at(-1) || null;
    if (next === active) { if (active) blockBackground(active); return; }
    const previous = active, previousFrame = frames.get(previous);
    active = next;
    if (!next) {
      restoreBackground();
      if (overflow !== null) { document.body.style.overflow = overflow.body; document.documentElement.style.overflowY = overflow.html; }
      overflow = null;
      focus(previousFrame?.returnFocus);
      frames.clear();
      return;
    }
    if (overflow === null) {
      overflow = { body: document.body.style.overflow, html: document.documentElement.style.overflowY };
      document.body.style.overflow = 'hidden'; document.documentElement.style.overflowY = 'hidden';
    }
    if (!frames.has(next)) {
      const surface = next.querySelector('[role="dialog"], [role="alertdialog"]') || next;
      if (!surface.hasAttribute('tabindex')) surface.setAttribute('tabindex', '-1');
      const focused = document.activeElement;
      frames.set(next, { surface, returnFocus: focused === document.body ? lastTrigger : focused });
    }
    blockBackground(next);
    const frame = frames.get(next);
    if (previous && !previous.isConnected && next.contains(previousFrame?.returnFocus)) focus(previousFrame.returnFocus);
    else focus(next.querySelector('[data-initial-focus]') || frame.surface);
    for (const [layer] of frames) if (!layer.isConnected) frames.delete(layer);
  }
  function keys(event) {
    if (!active || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...active.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')]
      .filter(element => !element.disabled && element.tabIndex >= 0 && !element.closest('[inert]') && visible(element));
    const first = controls[0], last = controls.at(-1), current = document.activeElement;
    if (!first) { event.preventDefault(); focus(frames.get(active)?.surface); }
    else if (!active.contains(current) || current === frames.get(active)?.surface) { event.preventDefault(); focus(event.shiftKey ? last : first); }
    else if (event.shiftKey && current === first) { event.preventDefault(); focus(last); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); focus(first); }
  }
  function containFocus(event) {
    if (active && !active.contains(event.target)) focus(frames.get(active)?.surface);
  }
  const pointer = event => { lastTrigger = event.target.closest?.('button, input, a[href]') || event.target; };
  onMounted(() => {
    root = document.getElementById('app');
    if (!root) return;
    observer = new window.MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    window.addEventListener('keydown', keys, true);
    document.addEventListener('focusin', containFocus, true);
    root.addEventListener('pointerdown', pointer, true);
    sync();
  });
  onScopeDispose(() => {
    observer?.disconnect();
    window.removeEventListener('keydown', keys, true);
    document.removeEventListener('focusin', containFocus, true);
    root?.removeEventListener('pointerdown', pointer, true);
    active = null;
    restoreBackground();
    if (overflow !== null) { document.body.style.overflow = overflow.body; document.documentElement.style.overflowY = overflow.html; }
    frames.clear();
  });
}
