/*
 * One-tap project actions (#133): buttons that start a saved agent request. A tap asks for any
 * fill-in fields, then creates an ordinary task from the person who tapped. An action its agent's
 * owner has approved starts at once; any other waits for the owner, as a typed request would.
 */
export function actionBar({ el, api, toast }, actions, { onRan } = {}) {
  if (!actions?.length) return null;
  const run = async (action, button) => {
    const values = {};
    for (const field of action.fields) {
      const value = prompt(`${action.label}: ${field.replace(/_/g, ' ')}`);
      if (value === null) return;
      values[field] = value;
    }
    button.disabled = true;
    try {
      const task = await api(`/actions/${action.id}/run`, { method: 'POST', body: { values } });
      toast(task.state === 'awaiting_approval' ? `${action.label}: waiting for ${action.agent}'s owner to approve` : `${action.label}: ${action.agent} is on it (task #${task.id})`);
      onRan?.(task);
    } catch (err) {
      toast(`${action.label}: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  };
  return el(
    'div',
    { class: 'action-bar', role: 'group', 'aria-label': 'Actions' },
    actions.map((action) => {
      const button = el('button', {
        class: `action-button${action.approved ? '' : ' unapproved'}`,
        type: 'button',
        title: `${action.agent}: ${action.request}${action.approved ? '' : `\nAsks ${action.agent}'s owner first`}`,
        text: action.label,
      });
      button.addEventListener('click', () => void run(action, button));
      return button;
    }),
  );
}
