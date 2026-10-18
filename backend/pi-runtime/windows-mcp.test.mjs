import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {McpClient, StdioTransport} from '@earendil-works/pi-mcp';
import {installWindowsMcpTransport, windowsMcpServer} from './windows-mcp.ts';
import {powerShellExecutable} from './windows-shell.ts';
import {windows} from './test-support.mjs';

const built = fileURLToPath(new URL('../hexbot-core/target/debug/hexbot.exe', import.meta.url));
const helper = process.env.HEXBOT_DAEMON_EXECUTABLE ?? (existsSync(built) ? built : undefined);
const required = process.env.HEXBOT_REQUIRE_SANDBOX_TESTS === '1';

test('Windows MCP owns descendants and never invokes a planted taskkill during close or failed requests', {skip:!windows || !helper && !required && 'build the native process helper for MCP integration', timeout:60000}, async t => {
  assert(helper && existsSync(helper), 'the native process helper must be built');
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'hexbot-mcp-lifecycle-')));
  const previous = {HEXBOT_DAEMON_EXECUTABLE:process.env.HEXBOT_DAEMON_EXECUTABLE, NODE_OPTIONS:process.env.NODE_OPTIONS};
  const originalCwd = process.cwd();
  t.after(() => {process.chdir(originalCwd); for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;} rmSync(cwd, {recursive:true, force:true});});
  process.env.HEXBOT_DAEMON_EXECUTABLE = helper;
  const marker = join(cwd, 'untrusted-taskkill-ran');
  const preload = join(cwd, 'sentinel.cjs');
  writeFileSync(preload, `if(require('node:path').basename(process.execPath).toLowerCase()==='taskkill.exe'){require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exit(0);}`);
  copyFileSync(process.execPath, join(cwd, 'taskkill.exe'));
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.chdir(cwd);
  execFileSync(join(cwd, 'taskkill.exe'), ['/pid', '0'], {windowsHide:true});
  assert.equal(readFileSync(marker, 'utf8'), 'ran', 'the planted executable fixture must be runnable');
  rmSync(marker);
  await installWindowsMcpTransport();
  const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
  const npm = join(cwd, 'npm with spaces');
  mkdirSync(join(npm, 'node_modules/npm/bin'), {recursive:true});
  writeFileSync(join(npm, 'package.json'), '{"type":"module"}');
  writeFileSync(join(npm, 'npx.cmd'), `@echo bad > "${marker}"\r\n`);
  copyFileSync(fixture, join(npm, 'node_modules/npm/bin/npx-cli.js'));
  const localShim = join(npm, 'node_modules/.bin/npx.cmd');
  mkdirSync(join(npm, 'node_modules/.bin'));
  writeFileSync(localShim, `@echo bad > "${marker}"\r\n`);
  assert.equal(windowsMcpServer({command:localShim}, cwd).args[4], join(npm, 'node_modules/npm/bin/npx-cli.js'));
  const nativeCom = join(cwd, 'native-node.com');
  copyFileSync(process.execPath, nativeCom);
  const args = ['quoted " value', "apostrophe's", '& | < > % ! ^ ()', '%HOME%', 'owl 🦉'];
  const token = '!literal-${HOME}-%TOKEN%-&-"';
  for (const mode of ['normal', 'ignore-eof', 'failed-initialize', 'timeout', 'abort', 'root-exit', 'native-com']) {
    const report = join(cwd, mode + '.json');
    const config = windowsMcpServer({command:mode === 'native-com' ? nativeCom : 'npx', cwd, args:mode === 'native-com' ? [fixture, ...args] : args, env:{Path:npm,
      FIXTURE_PIDS_REPORT:report, FIXTURE_TOKEN:token,
      ...mode === 'ignore-eof' || mode === 'failed-initialize' ? {FIXTURE_IGNORE_EOF:'1'} : {},
      ...mode === 'failed-initialize' ? {FIXTURE_INIT_HANG:'1'} : {},
      ...mode === 'timeout' || mode === 'abort' ? {FIXTURE_HOLD_CALL:'1'} : {},
      ...mode === 'root-exit' ? {FIXTURE_EXIT_CALL:'1'} : {},
    }}, cwd);
    assert.equal(config.command, helper);
    assert.equal(config.args[3], mode === 'native-com' ? nativeCom : process.execPath);
    const client = new McpClient({name:'Hexbot lifecycle test', version:'1', requestTimeoutMs:mode === 'failed-initialize' ? 2000 : 10000});
    const transport = new StdioTransport({command:config.command, args:config.args, cwd, env:config.env, stderr:'pipe'});
    t.after(() => client.close());
    if (mode === 'failed-initialize') await assert.rejects(client.connect(transport), /timed out|timeout/i);
    else {
      await client.connect(transport);
      if (mode === 'root-exit') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The exited MCP server did not close its transport.')), 10000);
          client.onClose(() => {clearTimeout(timer); resolve();});
          client.callTool('echo', {text:'exit'}).catch(error => {clearTimeout(timer); reject(error);});
        });
      } else if (mode === 'abort') {
        const controller = new AbortController();
        client.onNotification('fixture/call-waiting', () => controller.abort());
        await assert.rejects(client.callTool('echo', {text:'held'}, {signal:controller.signal}), /abort|cancel/i);
      } else if (mode === 'timeout') await assert.rejects(client.callTool('echo', {text:'held'}, {timeoutMs:200}), /timed out|timeout/i);
      else {
        const reply = await client.callTool('inspect', {});
        assert.equal(JSON.parse(reply.content[0].text).token, token);
      }
    }
    if (mode !== 'root-exit') await client.close();
    const pids = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual(pids.args, args);
    assert.equal(pids.token, token);
    // Wait on OS process handles after job termination, without sleeping. This
    // also covers the short kernel teardown interval after the helper exits.
    const wait = `$ErrorActionPreference='SilentlyContinue'; foreach($pidValue in @(${pids.server},${pids.child})){ $process=Get-Process -Id $pidValue; if($process){$process.WaitForExit(5000) | Out-Null; if(-not $process.HasExited){exit 19}} }; exit 0`;
    execFileSync(powerShellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', wait], {windowsHide:true, timeout:12000});
    assert.equal(existsSync(marker), false, `${mode} invoked the planted executable`);
  }
  // Even a failed native spawn must close without the upstream PATH taskkill.
  const failed = new McpClient({name:'Hexbot spawn failure', version:'1'});
  await assert.rejects(failed.connect(new StdioTransport({command:join(cwd, 'absent-helper.exe'), cwd})), /ENOENT|spawn/i);
  await failed.close();
  assert.equal(existsSync(marker), false);
  assert.throws(() => windowsMcpServer({command:join(cwd, 'unrecognized.cmd')}, cwd), /could not be found|native executable/);
});
