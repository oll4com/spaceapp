const { runCommand, commands } = require('../src/cli');
const { checkPrerequisites } = require('../src/prerequisites');
const { checkStorage } = require('../src/storage');

describe('run-spaceapp', () => {
  it('should run install command with default engine', async () => {
    await commands.install();
    expect(process.stdout).toContain('Starting service core');
  });

  it('should run install command with podman engine', async () => {
    await runCommand('setEngineSelection', [ENGINE_PODMAN]);
    await commands.install();
    expect(process.stdout).toContain('Starting service core');
  });

  it('should check prerequisites', async () => {
    await checkPrerequisites();
    expect(process.stdout).toContain('Podman version');
  });

  it('should check storage', async () => {
    await checkStorage();
    expect(process.stdout).toContain('Filesystem').toContain('Available');
  });
});
