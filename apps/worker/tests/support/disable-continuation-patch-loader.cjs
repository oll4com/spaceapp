"use strict";

module.exports = function disableContinuationPatchLoader(source) {
  return String(source)
    .split('patched("room-background-continuation-v1")')
    .join("false");
};
