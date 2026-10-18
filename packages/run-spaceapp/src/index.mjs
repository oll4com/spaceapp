const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENGINE_DEFAULT = 'docker';
const ENGINE_PODMAN = 'podman';
const ENGINE_PODMAN_MACHINE = 'podman-machine';
const ENGINE_CONFIG_PATH = path.join(__dirname, '../config/engine-config.json');

function getEngineSelection() {
  if (!fs.existsSync(ENGINE_CONFIG_PATH)) {
    return ENGINE_DEFAULT;
  }
  const config = JSON.parse(fs.readFileSync(ENGINE_CONFIG_PATH, 'utf-8'));
  return config.engine || ENGINE_DEFAULT;
}

function setEngineSelection(engine) {
  const config = {
    engine: engine
  };
  fs.writeFileSync(ENGINE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function runCommand(command, args = []) {
  const engine = getEngineSelection();
  let cmd = command;
  if (engine === ENGINE_PODMAN) {
    cmd = 'podman ' + command;
  } else if (engine === ENGINE_PODMAN_MACHINE) {
    cmd = 'podman-machine ' + command;
  }
  return execSync(cmd, { args: args, stdio: 'inherit' });
}

module.exports = {
  getEngineSelection,
  setEngineSelection,
  runCommand
};
