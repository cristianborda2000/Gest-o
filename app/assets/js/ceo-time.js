/* Date-only arithmetic is UTC; all instants and clock displays use São Paulo. */
const ZamaTime = (() => {
  const zone = 'America/Sao_Paulo';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  function nowParts(instant = new Date()) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    return { ...p, date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  function today(instant = new Date()) { return nowParts(instant).date; }
  function addDays(day, count) {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + count);
    return d.toISOString().slice(0, 10);
  }
  function toEpoch(day, time = '00:00') {
    // Resolve the named timezone rather than assuming the device timezone or fixed offset.
    const wall = Date.parse(`${day}T${time}:00Z`);
    let instant = wall;
    for (let i = 0; i < 3; i++) {
      const p = nowParts(instant);
      const displayed = Date.parse(`${p.date}T${p.time}:${p.second}Z`);
      instant += wall - displayed;
    }
    return instant;
  }
  function monthRange(month = today().slice(0, 7)) {
    const [y, m] = month.split('-').map(Number);
    return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  }
  function label(day, options = {}) {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', ...options }).format(toEpoch(day, '12:00'));
  }
  return { zone, nowParts, today, addDays, toEpoch, monthRange, label };
})();
if (typeof module !== 'undefined') module.exports = ZamaTime;
