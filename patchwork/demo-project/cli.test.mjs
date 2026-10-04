import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarize } from './cli.mjs'

test('counts a line without a final newline', () => {
  assert.deepEqual(summarize('hello world'), { lines: 1, words: 2, characters: 11 })
})
test('counts words separated by whitespace', () => {
  assert.equal(summarize('one  two\tthree').words, 3)
})
test('a final newline terminates a line; it does not add an empty line', () => {
  assert.equal(summarize('first\nsecond\n').lines, 2)
})
