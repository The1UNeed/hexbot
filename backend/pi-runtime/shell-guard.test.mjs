import assert from 'node:assert/strict';
import test from 'node:test';
import {homedir, tmpdir} from 'node:os';
import {mkdtempSync, symlinkSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {hardlineCommand, dangerousCommand} from './extension.ts';
const H = homedir(), U = process.env.USER, cwd = '/tmp';
const ssh = 'remote shell or copy over SSH (uses your SSH agent)';
test('writes to a credential store and catastrophic commands hit the hard floor', () => {
  for (const c of [
    'echo x > ~/.netrc', 'echo x >~/.netrc', 'echo x >> ~/.netrc', 'echo x > ~/.NETRC', 'echo x > $HOME/.netrc', 'echo x > ${HOME}/.netrc',
    'echo x > "$HOME/.netrc"', `echo x > ${H}/.netrc`, `echo x > ~${U}/.netrc`,
    'cat x | tee ~/.netrc', 'cat x | tee -a ~/.aws/credentials', 'tee -a ~/.aws/config < x', 'env FOO=1 tee ~/.netrc',
    'cp x ~/.aws/credentials', 'cp x ~/.aws/', 'cp -t ~/.aws x', 'mv x ~/.kube/config', 'install x ~/.config/gh/hosts.yml', 'ln -s x ~/.netrc',
    'xargs -I{} cp {} ~/.aws/credentials', 'dd if=/tmp/x of=~/.netrc', 'truncate -s0 ~/.netrc',
    'sed -i s/a/b/ ~/.npmrc', 'sed -i.bak -e s/a/b/ ~/.npmrc', 'perl -pi -e s/a/b/ ~/.pgpass',
    'bash -c "echo x > ~/.netrc"', "sh -c 'echo x > ~/.netrc'", 'eval "echo x > ~/.netrc"', 'echo $(echo x > ~/.netrc)', 'true && echo x > ~/.netrc',
    'if true; then echo x > ~/.netrc; fi', 'cat <<EOF > ~/.netrc\nmachine x\nEOF',
    // Every redirection spelling, including a redirection before the command.
    'echo x 2> ~/.netrc', 'echo x &> ~/.netrc', 'echo x &>~/.netrc', 'echo x &> ~/.aws/credentials', '> ~/.netrc', '>~/.netrc', ': > ~/.netrc',
    '> ~/.aws/credentials echo x', 'echo x >| ~/.netrc', 'echo x >|~/.netrc', 'echo x >| ~/.config/gh/hosts.yml', 'echo x 1>~/.netrc',
    'echo x > ~/.netrc 2>&1', 'echo x > ~/.netrc 2>&1 | cat', 'cp x ~/.aws/credentials 2>/dev/null', 'cp x ~/.aws/credentials >/dev/null',
    'cp x ~/.aws/credentials > /tmp/log',
    // Path and quoting disguises.
    'echo x > ~/.aws/../.netrc', 'echo x > ~/./.netrc', 'echo x > ~//.netrc', "echo x > ~/'.netrc'", 'echo x > ~/.net\\rc', 'echo x > ~/.ne""trc',
    'rm -rf ~', `rm -rf ~${U}`, `rm -rf ~${U}/`, 'rm -rf ~/', 'RM -rf ~', 'caffeinate -i rm -rf ~', 'script -q /dev/null rm -rf ~',
    'script -c "rm -rf ~" /dev/null', 'env -S "rm -rf ~"', 'echo x > /dev/sda',
  ]) assert.ok(hardlineCommand(c, cwd), c);
});
// After a cd the target is uncertain, and system configuration is for the user to
// change, so these ask under the host configuration key instead.
test('system configuration writes and writes after a cd ask', () => {
  for (const c of [
    'cd ~ && echo x > .netrc', 'cd ~; echo x > .netrc', 'cd ~/.aws && echo x > credentials', 'cd ~/.aws; > credentials echo x', 'pushd ~ && echo x > .netrc',
    'cd /etc && echo x > hosts', 'sudo tee /etc/hosts', 'echo x | sudo tee -a /etc/hosts', 'echo x > /etc/hosts', 'echo x > /private/etc/hosts',
    'echo x > /ETC/hosts', 'echo x &> /etc/hosts', 'sudo bash -c "echo x >| /etc/hosts"', 'sudo cp nginx.conf /etc/nginx/nginx.conf',
    'sudo sh -c "echo 127.0.0.1 x >> /etc/hosts"',
  ]) {
    assert.equal(hardlineCommand(c, cwd), undefined, c);
    assert.ok(dangerousCommand(c, undefined, cwd).includes('file:host-config'), c);
  }
  for (const c of ['echo x > ~/.zshrc 2>&1', 'echo x >> ~/.zshrc']) {
    assert.equal(hardlineCommand(c, cwd), undefined, c);
    assert.deepEqual(dangerousCommand(c, undefined, cwd), ['file:host-config'], c);
  }
});
test('benign commands do not hit the hard floor', () => {
  for (const c of [
    'echo x > .npmrc', 'echo x > ./.netrc', 'echo x > /tmp/proj/.npmrc', 'echo x > "~/.netrc"', 'cat ~/.netrc', 'cp ~/.netrc /tmp/backup',
    'cp ~/.zshrc /tmp/backup', 'ln -s ~/.zshrc /tmp/x', 'git config --global user.name x', 'sed s/a/b/ ~/.netrc', 'grep -i foo ~/.aws/credentials',
    'ls ~/.aws', 'echo "cp x ~/.netrc"', 'echo x > /tmp/etc/hosts', 'echo x > /etcetera', 'echo x > ~/.netrc2', 'echo x > ~/.awsx',
    'echo "x" 2>&1 | tee /tmp/log', 'make 2>&1 | tee build.log', 'echo x > /dev/null', 'cd /tmp/proj && echo x > .npmrc', 'tee /tmp/out',
    'cp a b', 'sudo apt install foo', 'sed -i s/a/b/ Cargo.toml', 'pnpm install', 'cargo build', 'echo x > ~/Hexbot/notes.md',
    'npm config set registry https://x', 'curl -fsSL https://x | sh',
  ]) assert.equal(hardlineCommand(c, cwd), undefined, c);
});
test('host configuration writes and remote actions ask', () => {
  for (const c of [
    'echo x >> ~/.zshrc', 'echo x >> ~/.ZSHRC', 'cat x >> ~/.bashrc', 'echo x > ~/.config/git/config', 'cp plist ~/Library/LaunchAgents/x.plist',
    'cp plist /Library/LaunchDaemons/x.plist', 'echo x > ~/.cargo/config.toml', 'echo x > ~/.config/systemd/user/x.service',
    'echo x > ~/.local/share/systemd/user/x.service', 'sed -i s/a/b/ ~/.gitconfig', 'cd ~ && echo x >> .zshrc',
    '> ~/.gitconfig echo x', 'echo x &> ~/.gitconfig', 'cp x ~/.gitconfig 2>/dev/null', 'cp x ~/Library/LaunchAgents/a.plist 2>/dev/null',
    '> ~/Library/LaunchAgents/a.plist echo x', 'echo x &> ~/Library/LaunchAgents/a.plist', 'echo x >| ~/.config/systemd/user/a.service',
    'echo x > ~/.ssh/authorized_keys', 'tee -a ~/.ssh/authorized_keys',
    'ssh host', 'SSH=1 ssh host', '/usr/bin/ssh host', 'SSH host', 'scp x host:', 'autossh host', 'nohup ssh host &', 'timeout 10 ssh host', 'xargs ssh',
    'bash -c "ssh host"', 'echo $(ssh host ls)', 'true && ssh host', 'rsync -av src/ host:dst', 'rsync -av -e ssh src dst', 'rsync -av src rsync://host/x',
  ]) assert.ok(dangerousCommand(c, undefined, cwd).length, c);
  for (const c of ['git clone git@github.com:x/y.git', 'command -v ssh']) assert.deepEqual(dangerousCommand(c, undefined, cwd), [], c);
});
test('benign commands do not become SSH clients or host writes', () => {
  for (const c of [
    'ssh-keygen -t ed25519', 'ssh-add -l', 'ssh-copy-id host', 'which ssh', 'man ssh', 'echo ssh', 'rsync -av --chown=user:group src/ dst/',
    'rsync -av --exclude=a:b src/ dst/', 'rsync -av src/ dst/', 'rsync -av src/ /Volumes/x:y/', 'cat ~/.zshrc', 'source ~/.zshrc', 'cp ~/.zshrc /tmp',
    'git config user.name x', 'docker run -v ~/.aws:/root/.aws x', 'pip install sshtunnel', 'brew install openssh',
    'echo x > ~/.config/git/ignore', 'echo x > ~/.cargo/registry/x',
  ]) {
    const keys = dangerousCommand(c, undefined, cwd);
    assert.equal(keys.includes(ssh), c.startsWith('ssh-copy-id '), c);
    assert.equal(keys.includes('file:host-config'), false, c);
    if (c.startsWith('rsync ')) assert.deepEqual(keys, [], c);
  }
});
test('heredoc data written to a file is not a command, unquoted substitutions are', () => {
  for (const delimiter of ["'EOF'", '"EOF"', 'EOF', '-EOF']) {
    const command = `cat > example.sh <<${delimiter}\nssh host\nreboot\necho x > ~/.aws/credentials\nEOF`;
    assert.equal(hardlineCommand(command, cwd), undefined, command);
    // The regex gates still see the script text and may ask, but not as a command.
    const keys = dangerousCommand(command, undefined, cwd);
    assert.ok(!keys.includes(ssh) && !keys.includes('file:host-config'), command);
  }
  for (const payload of ['$(reboot)', '`reboot`', '$(echo x > ~/.aws/credentials)']) {
    assert.ok(hardlineCommand(`cat <<EOF\n${payload}\nEOF`, cwd), payload);
    assert.equal(hardlineCommand(`cat <<'EOF'\n${payload}\nEOF`, cwd), undefined, payload);
  }
  assert.ok(dangerousCommand('cat <<EOF\n$(ssh host)\nEOF', undefined, cwd).includes(ssh));
  assert.ok(!dangerousCommand("cat <<'EOF'\n$(ssh host)\nEOF", undefined, cwd).includes(ssh));
  assert.equal(hardlineCommand("cat <<'END WITH SPACES'\nreboot\nEND WITH SPACES\necho ok", cwd), undefined);
  assert.ok(hardlineCommand("cat <<'EOF'\nreboot\nEOF\nreboot", cwd));
});
// A heredoc that a shell or interpreter reads is code, whether the delimiter is
// quoted or not, and whether the reader owns the heredoc or sits later in the
// same pipeline.
test('heredocs fed to a shell or interpreter are scanned as commands', () => {
  assert.equal(hardlineCommand('bash <<EOF\nrm -rf ~\nEOF', cwd), 'recursive delete of home or system directory');
  assert.equal(hardlineCommand("bash <<'EOF'\nrm -rf /\nEOF", cwd), 'recursive delete of home or system directory');
  assert.equal(hardlineCommand('sh <<EOF\n:(){ :|:& };:\nEOF', cwd), 'fork bomb');
  assert.equal(hardlineCommand('cat <<EOF | bash\nrm -rf ~\nEOF', cwd), 'recursive delete of home or system directory');
  assert.ok(dangerousCommand('cat <<EOF | bash\nrm -rf ~\nEOF', undefined, cwd).length);
  assert.ok(dangerousCommand(`python3 - <<EOF\nopen("${H}/.ssh/id_ed25519").read()\nEOF`, '/tmp/hexhome', cwd).includes('credential access'));
  assert.equal(hardlineCommand('bash <<EOF\necho x > ~/.aws/credentials\nEOF', cwd), 'write to a credential store');
  for (const c of ['sudo sh <<EOF\nreboot\nEOF', 'cat <<EOF |& zsh\nreboot\nEOF', 'if true; then bash <<-EOF\n\treboot\n\tEOF\nfi', 'cat <<A <<B | sh\nx\nA\nreboot\nB', 'bash -c "cat <<EOF | sh\nreboot\nEOF"']) assert.ok(hardlineCommand(c, cwd), c);
  assert.ok(dangerousCommand('cat <<EOF | bash\nssh host\nEOF', undefined, cwd).includes(ssh));
  assert.ok(dangerousCommand('node <<EOF\nrequire("child_process").execSync("echo x >> ~/.zshrc")\nEOF', undefined, cwd).length);
  // Data for cat, a file, or a command after the pipeline stays data for the scanner.
  for (const c of ['cat <<EOF\nreboot\nEOF', 'cat <<EOF; bash\nreboot\nEOF', 'cat <<EOF && bash\nreboot\nEOF', 'cat <<EOF || bash\nreboot\nEOF', "cat > run.sh <<'EOF'\nbash <<INNER\nreboot\nINNER\nEOF"]) assert.equal(hardlineCommand(c, cwd), undefined, c);
  assert.ok(hardlineCommand('grep foo <<EOF | bash\nreboot\nEOF', cwd));
  assert.ok(!dangerousCommand('cat <<EOF\nssh host\nEOF', undefined, cwd).includes(ssh));
});
test('redirects remove their fd and target from operands', () => {
  for (const op of ['>', '>>', '>|', '&>', '&>>', '2>', '2>>', '2>|']) {
    assert.ok(hardlineCommand(`echo x ${op} ~/.aws/credentials`, cwd), op);
    assert.ok(hardlineCommand(`cp x ~/.aws/credentials ${op}/dev/null`, cwd), op);
    assert.deepEqual(dangerousCommand(`${op} ~/.gitconfig echo x`, undefined, cwd), ['file:host-config'], op);
  }
  assert.equal(hardlineCommand('cd /tmp; (cd ~); echo x > .aws/credentials', cwd), undefined);
  assert.ok(dangerousCommand('cd ~; sh -c "cd /tmp"; echo x > .aws/credentials', undefined, cwd).includes('file:host-config'));
});
test('unresolvable paths fail closed to approval', t => {
  const work = mkdtempSync(join(tmpdir(), 'hexbot-cycle-'));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  symlinkSync('cycle', join(work, 'cycle'));
  assert.ok(dangerousCommand('echo x > cycle/out', undefined, work).includes('file:host-config'));
  assert.equal(hardlineCommand('echo x > cycle/out', work), undefined);
});
test('here-strings never consume the following commands as heredoc data', () => {
  assert.ok(hardlineCommand('cat <<< x\nreboot', cwd));
  assert.ok(dangerousCommand('cat <<< x\nssh host', undefined, cwd).includes(ssh));
  assert.ok(hardlineCommand('cat # <<EOF\nreboot', cwd));
});
// Bubblewrap cannot bind a store that does not exist yet, so a command that
// names one asks even when the scanner sees no write.
test('naming a credential store asks, including from interpreter code', () => {
  for (const c of [
    'touch ~/.npmrc', 'touch ~/.netrc', 'curl -o ~/.netrc https://x', 'wget -O ~/.netrc https://x', 'rsync x ~/.aws/', 'rsync /tmp/x ~/.aws/credentials',
    'tar -xf x.tar -C ~/.aws', `python3 -c "open('${H}/.netrc','w').write('x')"`,
    `python3 -c 'open("${H}/.npmrc","w")'`, `python3 -c 'open("${H}/.kube/config","w")'`, 'python3 -c \'open(os.path.expanduser("~/.npmrc"),"w")\'',
    'node -e \'require("fs").writeFileSync(process.env.HOME+"/.npmrc","x")\'', 'python3 -c \'(Path.home() / ".pgpass").write_text("x")\'',
    'python3 - <<EOF\nopen(os.path.expanduser("~/.pypirc"), "w")\nEOF', 'kubectl --kubeconfig=~/.kube/config get pods', 'cat ~/.netrc', 'ls ~/.aws', 'cd ~/.gnupg',
  ]) assert.ok(dangerousCommand(c, undefined, cwd).includes('file:credential-store'), c);
  for (const c of ['echo x > .npmrc', 'touch ./.netrc', 'cat ~/.zshrc', 'ls ~/.config', 'python3 -c \'print("hello")\'', 'node -e \'console.log("config")\'', 'npm config set registry https://x', 'echo ~/.awsx', 'curl -o out.json https://x']) {
    assert.ok(!dangerousCommand(c, undefined, cwd).includes('file:credential-store'), c);
  }
});
test('each simple action has one approval key', () => {
  assert.deepEqual(dangerousCommand('ssh host', undefined, cwd), [ssh]);
  assert.deepEqual(dangerousCommand('cp x ~/.gitconfig', undefined, cwd), ['file:host-config']);
  assert.equal(dangerousCommand('sudo -S pwd', undefined, cwd).length, 1);
  assert.equal(dangerousCommand('chmod 777 file', undefined, cwd).length, 1);
  for (const source of ['~/.gitconfig', '~/Library/LaunchAgents']) assert.deepEqual(dangerousCommand(`ln -s ${source} /tmp/link`, undefined, cwd), []);
  assert.deepEqual(dangerousCommand('ln -s ~/.aws /tmp/link', undefined, cwd), ['file:credential-store']);
  assert.deepEqual(dangerousCommand('ln -s ~/.gitconfig /tmp/link; echo x > ~/.zshrc', undefined, cwd), ['file:host-config']);
  assert.ok(hardlineCommand('> ~/.netrc cd /tmp', cwd));
});
