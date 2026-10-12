/* Full-screen phone editors keep their controls above the on-screen keyboard. */
(function (global) {
  'use strict';
  const phone = global.matchMedia('(max-width: 720px)');
  const selector = 'dialog.ceo-dialog[open], dialog.za-dialog[open]';
  const errors = new WeakMap();
  let locked = null, frame = 0;

  // Called by each editor before showModal, so moving fields cannot blur an
  // already focused input or interrupt the iPhone keyboard's user gesture.
  function prepare(dialog) {
    if (dialog.classList.contains('mobile-form-page')) return;
    const form = dialog.querySelector('form');
    if (!form) return;
    const header = dialog.querySelector('.za-dialog-head, .ceo-idea-dialog-header, .ceo-toolbar');
    const actions = form.querySelector('.ceo-dialog-actions, .za-form-actions, .ceo-idea-dialog-footer');
    if (!header || !actions || actions.parentElement !== form) return;
    const body = document.createElement('div');
    body.className = 'mobile-form-fields';
    for (const node of [...form.childNodes]) if (node !== header && node !== actions) body.appendChild(node);
    form.insertBefore(body, actions);
    header.classList.add('mobile-form-header');
    actions.classList.add('mobile-form-actions');
    form.classList.add('mobile-form-layout');
    dialog.classList.add('mobile-form-page');
  }

  function lockBackground() {
    if (locked) return;
    const body = document.body;
    locked = { x: global.scrollX, y: global.scrollY, styles: {} };
    for (const property of ['position', 'top', 'left', 'width', 'overflow']) {
      locked.styles[property] = [body.style.getPropertyValue(property), body.style.getPropertyPriority(property)];
    }
    body.style.position = 'fixed';
    body.style.top = `-${locked.y}px`;
    body.style.left = `-${locked.x}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    document.documentElement.classList.add('mobile-form-open');
  }

  function unlockBackground() {
    if (!locked) return;
    const previous = locked;
    locked = null;
    for (const [property, [value, priority]] of Object.entries(previous.styles)) {
      if (value) document.body.style.setProperty(property, value, priority);
      else document.body.style.removeProperty(property);
    }
    document.documentElement.classList.remove('mobile-form-open');
    global.scrollTo(previous.x, previous.y);
  }

  function revealField(dialog, field) {
    if (!field) return;
    const scroller = field.closest('.mobile-form-fields');
    if (!scroller || !dialog.contains(scroller)) return;
    const bounds = field.getBoundingClientRect(), visible = scroller.getBoundingClientRect();
    if (bounds.top < visible.top + 12) scroller.scrollTop += bounds.top - visible.top - 12;
    else if (bounds.bottom > visible.bottom - 12) scroller.scrollTop += Math.min(bounds.bottom - visible.bottom + 12, bounds.top - visible.top - 12);
  }

  function update() {
    frame = 0;
    const dialogs = [...document.querySelectorAll(selector)];
    if (!phone.matches || !dialogs.length) { unlockBackground(); return; }
    lockBackground();
    const viewport = global.visualViewport;
    for (const dialog of dialogs) {
      dialog.style.setProperty('--mobile-form-height', `${viewport?.height || global.innerHeight}px`);
      dialog.style.setProperty('--mobile-form-top', `${viewport?.offsetTop || 0}px`);
    }
    const activeDialog = dialogs.at(-1);
    // Keep a failed save and its explanation together on short phone screens.
    // Only reveal a new error; later scrolling or editing remains under the
    // user's control rather than jumping back to the same message.
    let newError = null;
    for (const error of activeDialog.querySelectorAll('[role="alert"]')) {
      const message = error.hidden ? '' : error.textContent.trim();
      if (message && errors.get(error) !== message) newError = error;
      errors.set(error, message);
    }
    if (newError) revealField(activeDialog, newError);
    else if (document.activeElement?.matches('input,select,textarea')) revealField(activeDialog, document.activeElement);
  }

  function schedule() { if (!frame) frame = global.requestAnimationFrame(update); }
  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    document.addEventListener('focusin', schedule);
    document.addEventListener('close', schedule, true);
    global.addEventListener('resize', schedule);
    global.visualViewport?.addEventListener('resize', schedule);
    global.visualViewport?.addEventListener('scroll', schedule);
    phone.addEventListener('change', schedule);
    schedule();
  }
  global.ZamaMobileForms = { prepare };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(window);
