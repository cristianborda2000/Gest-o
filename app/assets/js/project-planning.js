(function (root) {
  'use strict';
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  function summarize(row, today) {
    const steps = (row.production_lists || []).flatMap(list => list.steps || []);
    const done = steps.filter(step => step.done).length;
    const pending = steps.filter(step => !step.done).sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    const deadlines = row.status === 'completed' ? [] : [
      ...(validDate(row.due_date) ? [{ date: row.due_date, label: 'Entrega do projeto' }] : []),
      ...pending.filter(step => validDate(step.due_date)).map(step => ({ date: step.due_date, label: step.label }))
    ].sort((a, b) => a.date.localeCompare(b.date));
    const attention = deadlines[0] || null;
    const overdue = Boolean(attention && attention.date < today);
    const upcoming = Boolean(attention && !overdue && attention.date <= addDays(today, 7));
    return { total: steps.length, done, percent: steps.length ? Math.round(done / steps.length * 100) : 0, next: pending[0] || null, attention, overdue, upcoming };
  }
  function compare(a, b, mode, today) {
    if (mode === 'name') return a.title.localeCompare(b.title, 'pt-BR');
    if (mode === 'updated') return String(b.updated_at).localeCompare(String(a.updated_at));
    const left = summarize(a, today), right = summarize(b, today);
    const rank = (row, value) => row.status === 'completed' ? 4 : value.overdue ? 0 : value.upcoming ? 1 : row.status === 'waiting' ? 2 : 3;
    return rank(a, left) - rank(b, right) || (left.attention?.date || '9999').localeCompare(right.attention?.date || '9999') || a.title.localeCompare(b.title, 'pt-BR');
  }
  const api = { validDate, addDays, summarize, compare };
  root.ZamaProjectPlanning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
