const { runCommand } = require('./index');

function checkPrerequisites() {
  try {
    runCommand('compose version');
    runCommand('podman version');
  } catch (error) {
    console.error('Prerequisites check failed:', error);
    process.exit(1);
  }
}

module.exports = {
  checkPrerequisites
};
