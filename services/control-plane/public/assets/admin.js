let resetContentScroll = false;
htmx.config.allowEval = false;
htmx.config.allowScriptTags = false;
htmx.config.includeIndicatorStyles = false;
document.body.addEventListener('htmx:beforeRequest', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  resetContentScroll = true;
  document.querySelectorAll('[data-tab]').forEach((node) => {
    const active = node === tab;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  document.title = tab.textContent.trim() + ' · Popcorn Control Plane';
});
const preservedScroll = new Map();
const syncAccessForm = (form) => {
  if (!form) return;
  const submit = form.querySelector('[data-access-submit]');
  if (!submit || submit.hasAttribute('data-always-disabled')) return;
  const allClusters = form.querySelector('input[name="clusterAccessMode"][value="all"]')?.checked;
  const confirmed = form.querySelector('input[name="confirmAllClusters"]')?.checked;
  submit.disabled = Boolean(allClusters && !confirmed);
};
const syncPodInventory = (root) => {
  if (!root) return;
  const query = (root.querySelector('[data-pod-search]')?.value || '').trim().toLowerCase();
  const status = root.querySelector('[data-pod-status]')?.value || 'all';
  const rows = Array.from(root.querySelectorAll('[data-pod-row]'));
  let visible = 0;
  rows.forEach((row) => {
    const matchesQuery = !query || (row.getAttribute('data-pod-search-value') || '').includes(query);
    const rowStatus = row.getAttribute('data-pod-status-value') || 'other';
    const matchesStatus = status === 'all' || rowStatus === status;
    row.hidden = !(matchesQuery && matchesStatus);
    if (!row.hidden) visible += 1;
  });
  const visibleCount = root.querySelector('[data-visible-pods]');
  if (visibleCount) visibleCount.textContent = String(visible);
  const filteredEmpty = root.querySelector('[data-filtered-pod-empty]');
  if (filteredEmpty) filteredEmpty.hidden = visible > 0 || rows.length === 0;
};
const resetAdminContentScroll = () => {
  const content = document.getElementById('admin-content');
  if (!content) return;
  content.scrollTop = 0;
  content.scrollLeft = 0;
};
document.body.addEventListener('htmx:beforeSwap', () => {
  document.querySelectorAll('[data-preserve-scroll]').forEach((node) => {
    preservedScroll.set(node.getAttribute('data-preserve-scroll'), node.scrollTop);
  });
});
document.body.addEventListener('htmx:afterSwap', () => {
  if (resetContentScroll) resetAdminContentScroll();
});
document.body.addEventListener('htmx:afterSettle', () => {
  if (resetContentScroll) {
    resetAdminContentScroll();
    requestAnimationFrame(resetAdminContentScroll);
    setTimeout(resetAdminContentScroll, 100);
    resetContentScroll = false;
  }
  document.querySelectorAll('[data-preserve-scroll]').forEach((node) => {
    const key = node.getAttribute('data-preserve-scroll');
    if (preservedScroll.has(key)) {
      node.scrollTop = preservedScroll.get(key);
    }
  });
  document.querySelectorAll('[data-access-form]').forEach(syncAccessForm);
  document.querySelectorAll('[data-pod-inventory]').forEach(syncPodInventory);
});
document.body.addEventListener('htmx:afterRequest', (event) => {
  if (!event.detail.successful) return;
  const source = event.detail.elt;
  if (source && source.matches('[data-clear-on-success]')) {
    source.reset();
  }
});
document.body.addEventListener('click', (event) => {
  const openTrigger = event.target.closest('[data-dialog-open]');
  if (openTrigger) {
    const dialog = document.getElementById(openTrigger.getAttribute('data-dialog-open'));
    dialog?.showModal();
    syncAccessForm(dialog?.querySelector('[data-access-form]'));
    return;
  }
  const closeTrigger = event.target.closest('[data-dialog-close]');
  if (closeTrigger) {
    closeTrigger.closest('dialog')?.close();
    return;
  }
  if (event.target.matches('dialog[data-modal]')) {
    event.target.close();
  }
});
document.body.addEventListener('change', (event) => {
  syncAccessForm(event.target.closest('[data-access-form]'));
  syncPodInventory(event.target.closest('[data-pod-inventory]'));
  if (event.target.matches('[data-region-scope-select]')) event.target.form?.requestSubmit();
});
document.body.addEventListener('input', (event) => {
  syncPodInventory(event.target.closest('[data-pod-inventory]'));
});
