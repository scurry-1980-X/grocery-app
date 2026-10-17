const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Execute the actual page script with just enough DOM for empty-list startup.
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const elements = new Map();
const context = vm.createContext({
  document: { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      addEventListener() {}, replaceChildren() {},
    });
    return elements.get(selector);
  } },
  localStorage: { getItem: () => null },
});
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
const parse = (text, quantity = 1) => JSON.parse(JSON.stringify(
  context.parseGroceryList(text, quantity)
));

test('comma-separated entries, whitespace and quantity defaults', () => {
  assert.deepEqual(parse(' 2 apples, milk, , bread, ', 3), [
    { name: 'apples', quantity: 2 },
    { name: 'milk', quantity: 3 },
    { name: 'bread', quantity: 3 },
  ]);
});
test('numeric and digit-leading names are preserved', () => {
  for (const name of ['123', '7up', '2% milk', '2apples']) {
    assert.deepEqual(parse(name), [{ name, quantity: 1 }]);
  }
});
test('quantity boundaries are accepted', () => {
  assert.deepEqual(parse('1 apple, 999 beans'), [
    { name: 'apple', quantity: 1 }, { name: 'beans', quantity: 999 },
  ]);
});
test('invalid prefixes reject the entire batch', () => {
  for (const prefix of ['0', '1000', '-2', '+2', '1.5', '999999999999999999999']) {
    assert.throws(() => parse(`milk, ${prefix} apples`), /1 to 999/);
  }
});
test('invalid fallback quantities are rejected', () => {
  for (const quantity of [0, 1000, 1.5, NaN, Infinity]) {
    assert.throws(() => parse('milk', quantity), /1 to 999/);
  }
});
test('blank and comma-only entries are rejected', () => {
  for (const text of ['', ' ', ', ,']) assert.throws(() => parse(text), /at least one/);
});
