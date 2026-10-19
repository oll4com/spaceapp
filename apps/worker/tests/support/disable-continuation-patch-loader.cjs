"use strict";

/**
 * Webpack pre-loader used by test harnesses to compile workflow bundles
 * with the room-background-continuation-v1 patch disabled, simulating
 * legacy pre-patch workflow executions.
 *
 * @param {string|Buffer} source - The original source code of the workflow module.
 * @returns {string} The transformed source code with the patch condition replaced by false.
 */
module.exports = function disableContinuationPatchLoader(source) {
  return String(source)
    .split('patched("room-background-continuation-v1")')
    .join("false");
};

