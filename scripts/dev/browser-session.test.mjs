import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {signIn} from './browser-session.mjs'

test('UI helpers use the private token and daemon port behind a dev proxy', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-browser-session-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  await writeFile(join(home, 'local-device.token'), 'fixture-token\n')
  await writeFile(join(home, 'serve-state.json'), '{"port":9119}')
  let cookies
  const page = {context: () => ({addCookies: async value => {cookies = value}})}
  await signIn(page, 'http://localhost:5173', home)
  assert.deepEqual(cookies, [{name:'hermes_session_at_9119', value:'fixture-token', url:'http://localhost:5173', httpOnly:true, secure:false, sameSite:'Strict'}])
  await signIn(page, 'https://owl.hexbot.app', home)
  assert.equal(cookies[0].name, '__Host-hermes_session_at')
  assert.equal(cookies[0].secure, true)
  await assert.rejects(signIn(page, 'http://localhost:5173', ''), /Set HEXBOT_HOME/)
  await writeFile(join(home, 'serve-state.json'), '{}')
  await assert.rejects(signIn(page, 'http://localhost:5173', home), /token or port/)
})
