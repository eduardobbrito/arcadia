// The create/edit space form, shared by the spaces menu and Arcadia's own panel.

import { COLORS, COLOR_NAMES, send } from './shared.js';

export const EMOJI = ['🌿', '💼', '🏠', '🎧', '📚', '🧪', '✈️', '🎮', '💬', '🛒', '🧠', '🛠️', '🎨', '💰', '❤️', '⭐'];

// `onPreview(colour)` lets the host tint itself as a colour is picked.
// `onDone(what)` runs after 'save', 'delete' or 'cancel'.
export function spaceForm({ space, spaces, windowId, onPreview = () => {}, onDone = () => {} }) {
  const isNew = !space;
  const used = new Set(spaces.map((s) => s.color));
  const draft = space
    ? { ...space }
    : {
        name: '',
        emoji: EMOJI.find((x) => !spaces.some((s) => s.emoji === x)) || '✨',
        color: COLOR_NAMES.find((c) => c !== 'grey' && !used.has(c)) || 'purple',
      };
  const canDelete = !isNew && spaces.length > 1;
  const form = document.createElement('form');
  form.className = 'space-form';
  form.innerHTML = `
    <h2>${isNew ? 'New space' : 'Edit space'}</h2>
    <div class="pair">
      <input type="text" name="emoji" maxlength="8" aria-label="Icon">
      <input type="text" name="name" maxlength="40" placeholder="Name, like Work or Reading" aria-label="Name" required>
    </div>
    <div class="picks" aria-label="Icons">${EMOJI.map((x) => `<button type="button" data-emoji="${x}">${x}</button>`).join('')}</div>
    <div class="swatches" role="radiogroup" aria-label="Colour">
      ${COLOR_NAMES.map((c) => `<label title="${c}" style="--sh:${COLORS[c].h};--sc:${Math.max(COLORS[c].c, 0.02)}"><input type="radio" name="color" value="${c}" aria-label="${c}"><span></span></label>`).join('')}
    </div>
    ${isNew ? '<p class="note">Spaces share this profile\'s logins. For separate logins, use Dia\'s own profiles.</p>' : ''}
    <div class="actions">
      ${canDelete ? '<button type="button" class="danger" data-act="delete">Delete space</button>' : ''}
      <span class="grow"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">${isNew ? 'Create space' : 'Save'}</button>
    </div>`;
  form.elements.emoji.value = draft.emoji;
  form.elements.name.value = draft.name;
  form.elements.color.value = draft.color;
  onPreview(draft.color);

  form.addEventListener('change', () => onPreview(form.elements.color.value));
  form.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-emoji]');
    if (pick) form.elements.emoji.value = pick.dataset.emoji;
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'cancel') onDone('cancel');
    if (btn?.dataset.act === 'delete') {
      if (btn.dataset.armed) {
        await send('space:delete', { id: space.id });
        onDone('delete');
      } else {
        // Second click confirms.
        btn.dataset.armed = '1';
        btn.textContent = 'Delete it (its tabs stay open)';
      }
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { name: form.elements.name.value, emoji: form.elements.emoji.value, color: form.elements.color.value };
    if (isNew) await send('space:create', { windowId, ...data });
    else await send('space:update', { id: space.id, ...data });
    onDone('save');
  });
  queueMicrotask(() => {
    form.elements.name.focus();
    form.elements.name.select();
  });
  return form;
}
