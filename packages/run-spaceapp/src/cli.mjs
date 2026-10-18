const { runCommand } = require('./index');

const commands = {
  'install': () => runCommand('compose up -d'),
  'up': () => runCommand('compose up -d'),
  'down': () => runCommand('compose down'),
  'status': () => runCommand('compose ps'),
  'logs': () => runCommand('compose logs'),
  'update': () => runCommand('compose pull && compose up -d'),
  'rollback': () => runCommand('compose down && compose up -d'),
  'backup': () => runCommand('compose backup'),
  'restore': () => runCommand('compose restore'),
  'doctor': () => runCommand('compose config show'),
  'repair': () => runCommand('compose config show'),
  'uninstall': () => runCommand('compose down && compose rm -f'),
  'factory-reset': () => runCommand('compose down && compose rm -f'),
  'provider install': () => runCommand('compose config set provider opencode'),
  'credentials set': () => runCommand('compose config set credentials ...'),
  'owner ...': () => runCommand('compose config show')
};

module.exports = {
  runCommand,
  commands
};
