const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeName } = require('../server/app');

test('sanitizeName falls back to "anonymous" for empty or missing input', () => {
  assert.equal(sanitizeName(undefined), 'anonymous');
  assert.equal(sanitizeName(''), 'anonymous');
  assert.equal(sanitizeName('   '), 'anonymous');
});

test('sanitizeName replaces spaces and slashes with underscores', () => {
  assert.equal(sanitizeName('Alice Kim'), 'Alice_Kim');
  assert.equal(sanitizeName('a/b\\c'), 'a_b_c');
});

test('sanitizeName keeps Korean characters, letters, numbers, underscore and hyphen', () => {
  assert.equal(sanitizeName('철수'), '철수');
  assert.equal(sanitizeName('user-42_test'), 'user-42_test');
});

test('sanitizeName truncates to 60 characters', () => {
  const longName = 'a'.repeat(100);
  const result = sanitizeName(longName);
  assert.equal(result.length, 60);
  assert.equal(result, 'a'.repeat(60));
});
