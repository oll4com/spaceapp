const { test, expect } = require('@jest/globals');
const { getContainerImageSize, checkBudgets } = require('../scripts/container-image-size-budget.mjs');

test('container image size budget test', () => {
  expect(() => {
    checkBudgets();
  }).not.toThrow();
});
