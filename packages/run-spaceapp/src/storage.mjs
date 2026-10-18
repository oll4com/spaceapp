const { runCommand } = require('./index');

function checkStorage() {
  try {
    runCommand('df .');
  } catch (error) {
    console.error('Storage check failed:', error);
    process.exit(1);
  }
}

module.exports = {
  checkStorage
};
