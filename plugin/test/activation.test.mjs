/**
 * Tests for the activation policy: which commands are allowed to bring the
 * panel on screen.
 *
 * Run with: node --test plugin/test/activation.test.mjs
 *
 * The policy is deliberately a pure function of the config value, so the whole
 * "when does the sidebar open" question can be pinned without a browser. The
 * value travels to the panel as `show` on each command (`bridge.request`), and
 * `client.js` `dispatch` is the only place that acts on it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVATIONS, DEFAULT_ACTIVATION, activationPolicy, normalizeActivation, showFor,
} from '../activation.js'

test('the menu order is the documented one', () => {
  assert.deepEqual(ACTIVATIONS, ['auto', 'always', 'manual'])
  assert.equal(DEFAULT_ACTIVATION, 'auto')
})

test('an unset or unusable value falls back to auto', () => {
  for (const value of [undefined, null, '', '   ', 42, {}, 'sometimes']) {
    assert.equal(normalizeActivation(value), 'auto', `value ${String(value)}`)
  }
})

test('case and surrounding space do not matter', () => {
  assert.equal(normalizeActivation(' ALWAYS '), 'always')
  assert.equal(normalizeActivation('Manual'), 'manual')
})

test('auto opens once, always re-focuses, manual never opens', () => {
  assert.equal(showFor('auto'), 'once')
  assert.equal(showFor('always'), 'always')
  assert.equal(showFor('manual'), 'never')
})

test('an unknown mode behaves like auto, never like manual', () => {
  // Failing towards "the panel opens" is the safe direction: a wrong `never`
  // turns every page action into an error the user cannot explain.
  assert.equal(showFor('off'), 'once')
})

test('the policy carries both the mode and the per-command instruction', () => {
  const policy = activationPolicy('always')
  assert.equal(policy.mode, 'always')
  assert.equal(policy.show(), 'always')
  assert.equal(activationPolicy(undefined).mode, 'auto')
})
