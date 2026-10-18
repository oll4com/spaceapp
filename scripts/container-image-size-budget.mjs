const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUDGETS = {
  'core': 850,
  'browser': 1350,
  'cli': 1000
};

function getContainerImageSize(imageName) {
  const sizeCommand = `docker images --format "{{.Size}}" ${imageName}`;
  const sizeOutput = execSync(sizeCommand).toString().trim();
  return parseInt(sizeOutput, 10);
}

function checkBudgets() {
  const sizes = {
    'core': getContainerImageSize('spaceapp-core'),
    'browser': getContainerImageSize('spaceapp-browser'),
    'cli': getContainerImageSize('spaceapp-cli')
  };

  for (const [image, size] of Object.entries(sizes)) {
    if (size > BUDGETS[image]) {
      throw new Error(`Image ${image} exceeds budget: ${size} MiB > ${BUDGETS[image]} MiB`);
    }
  }
}

checkBudgets();
