const { test } = require('node:test');
const assert = require('node:assert/strict');
const { phone, personalize, candidates, worksheetRows } = require('../app/assets/js/ceo-clients');
const XLSX = require('../app/assets/vendor/xlsx.full.min.js');
test('normalizes Brazilian and explicit international phones without guessing invalid numbers', () => {
  assert.equal(phone('(11) 99999-1234'), '5511999991234');
  assert.equal(phone('+55 11 99999-1234'), '5511999991234');
  assert.equal(phone('5511999991234'), '5511999991234');
  assert.equal(phone('+351 912 345 678'), '351912345678');
  for (const invalid of ['99999-1234', '00000000000', 'abc11999991234', '1.19999E+10']) assert.equal(phone(invalid), '');
});
test('import retains named contacts without valid phones and people sharing a phone, but skips exact duplicates', () => {
  const existing = [{ nome: 'Ana', telefone: '+55 11 99999-1234' }];
  const rows = candidates([['Nome', 'Telefone'], ['Ana', '(11) 99999-1234'], ['Bia', '21988887777'], ['Outra Bia', '+55 21 98888-7777'], ['', '31988887777'], ['Caio', '123'], ['', '']], 0, 1, existing);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.filter(r => !r.problem).map(r => r.nome), ['Bia', 'Outra Bia', 'Caio']);
  assert.equal(rows.find(r => r.nome === 'Caio').warning, 'Telefone inválido: confira DDD e número');
  assert.equal(existing.length, 1);
});
test('all 128 contacts from 129 spreadsheet rows survive, including empty phones', () => {
  const rows = [['Nome', 'Telefone'], ...Array.from({ length: 128 }, (_, i) => [`Pessoa ${i + 1}`, i % 2 ? '11999991234' : ''])];
  const result = candidates(rows, 0, 1);
  assert.equal(result.filter(row => !row.problem).length, 128);
  assert.equal(result.filter(row => row.warning).length, 64);
  assert.equal(result.at(-1).line, 129);
  assert.equal(candidates(rows, 0, 1, [], false).filter(row => !row.problem).length, 64);
  assert.equal(candidates(rows, 0, 1, result).filter(row => !row.problem).length, 0);
});
test('Excel numeric phones use full cell values even when the display uses rounded scientific notation', () => {
  const tab = XLSX.utils.aoa_to_sheet([['Nome', 'Telefone'], ['Ana', 11999991234], ['Bia', '0011999991234']]);
  tab.B2.z = '0.00E+00';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, tab, 'Contatos');
  const loaded = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const rows = worksheetRows(loaded.Sheets.Contatos, XLSX);
  assert.equal(rows[1][1], 11999991234);
  assert.equal(rows[2][1], '0011999991234');
  assert.equal(phone(candidates(rows, 0, 1)[0].telefone), '5511999991234');
});
test('message preserves special characters and replaces every name token literally', () => {
  assert.equal(personalize('Olá {nome}!\n{NOME} & você?', 'João $&'), 'Olá João $&!\nJoão $& & você?');
});
