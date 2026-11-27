import { settledCard } from './settled-cards'

const draft = {
  action: 'draft',
  body: 'Dear Admissions Team,',
  subject: 'Report cards'
}

// As the daemon stores it after the user added a recipient and pressed Send.
const sent = {
  account: 'microsoft',
  body: 'Dear Admissions Team,',
  cc: [],
  id: 'AQMk',
  note: 'The user sent this, as shown, after any changes they made.',
  sent: true,
  subject: 'Report cards',
  to: ['admission@example.com']
}

describe('settled cards', () => {
  it('brings back a sent draft card with the email as it went', () => {
    const card = settledCard({
      args: JSON.stringify(draft),
      name: 'hexbot_mail',
      result: JSON.stringify(sent),
      status: 'ok'
    })

    expect(card).toEqual({
      decision: 'once',
      form: {
        bcc: [],
        body: 'Dear Admissions Team,',
        cc: [],
        from: '',
        kind: 'email_draft',
        reply_to: null,
        service: 'microsoft',
        service_name: 'Outlook',
        subject: 'Report cards',
        to: ['admission@example.com']
      },
      outcome: {
        draft: {
          bcc: [],
          body: 'Dear Admissions Team,',
          cc: [],
          reply_to: null,
          subject: 'Report cards',
          to: ['admission@example.com']
        },
        mail_action: 'send'
      }
    })
  })

  it('never claims a Bcc the stored result does not keep', () => {
    const card = settledCard({
      args: { ...draft, bcc: ['draft-only@example.com'] },
      name: 'hexbot_mail',
      result: JSON.stringify(sent),
      status: 'ok'
    })

    expect(card?.outcome?.draft.bcc).toEqual([])
  })

  it('reads a live result, whose details hold the tool output', () => {
    const card = settledCard({
      args: draft,
      name: 'hexbot_mail',
      result: {
        content: [{ text: JSON.stringify({ ...sent, sent: undefined, saved_to_drafts: true }) }],
        details: { ...sent, account: 'google', sent: undefined, saved_to_drafts: true }
      },
      status: 'ok'
    })

    expect(card).toMatchObject({
      form: { service: 'google', service_name: 'Gmail' },
      outcome: { mail_action: 'save' }
    })
  })

  it('shows a closed card as not sent, and nothing for a call that failed before a card', () => {
    const failed = (result: unknown) =>
      settledCard({ args: draft, name: 'hexbot_mail', result, status: 'error' })

    expect(
      failed(
        'The user closed the draft without sending it. Ask what they would like to change, or leave it.'
      )
    ).toMatchObject({
      decision: 'deny',
      form: { service: 'imap', subject: 'Report cards', to: [] }
    })
    expect(
      failed({ error: 'The user closed the draft without sending it.', result: null })
    ).toMatchObject({ decision: 'deny' })
    expect(failed('Nobody can answer a draft card here.')).toBeNull()
    expect(
      settledCard({ args: { action: 'search' }, name: 'hexbot_mail', result: '{}', status: 'ok' })
    ).toBeNull()
    expect(
      settledCard({ args: draft, name: 'hexbot_mail', result: null, status: 'running' })
    ).toBeNull()
  })

  it('brings back a sign-in card, saved or closed', () => {
    const args = { action: 'ask', title: 'PowerSchool', url: 'https://ps.example.org/login' }

    expect(
      settledCard({
        args,
        name: 'hexbot_passwords',
        result: JSON.stringify({
          id: 'l1',
          site: 'ps.example.org',
          title: 'PowerSchool',
          username: 'alex'
        }),
        status: 'ok'
      })
    ).toEqual({
      decision: 'once',
      form: {
        kind: 'sign_in',
        site: 'ps.example.org',
        title: 'PowerSchool',
        url: 'https://ps.example.org/login',
        username: 'alex'
      }
    })
    expect(
      settledCard({
        args,
        name: 'hexbot_passwords',
        result: 'The user closed the sign-in card. Ask what they would like to do instead.',
        status: 'error'
      })
    ).toMatchObject({ decision: 'deny', form: { site: 'ps.example.org', title: 'PowerSchool' } })
    expect(
      settledCard({
        args: { action: 'list' },
        name: 'hexbot_passwords',
        result: '{}',
        status: 'ok'
      })
    ).toBeNull()
    // Named as the daemon names a site: no www., no port.
    expect(
      settledCard({
        args: { action: 'ask', url: 'https://WWW.Example.com:8443/login' },
        name: 'hexbot_passwords',
        result: 'The user closed the sign-in card. Ask what they would like to do instead.',
        status: 'error'
      })?.form
    ).toMatchObject({ site: 'example.com', title: 'example.com' })
    // Filled in, then saving it failed: the card stays, saying so.
    expect(
      settledCard({
        args,
        name: 'hexbot_passwords',
        result: "The user agreed on the card, but it didn't work: The vault is locked.",
        status: 'error'
      })
    ).toMatchObject({ decision: 'once', failed: true, form: { site: 'ps.example.org' } })
    // Asked by a saved login's id alone and closed: the vault named it, not the call.
    expect(
      settledCard({
        args: { action: 'ask', id: 'l1' },
        name: 'hexbot_passwords',
        result: 'The user closed the sign-in card. Ask what they would like to do instead.',
        status: 'error'
      })
    ).toEqual({ decision: 'deny', form: { kind: 'sign_in', site: '', title: 'Sign-in' } })
  })

  it('brings back a plugin card, by its name or one read from its id', () => {
    const plugin = (args: object, result: unknown, status: 'error' | 'ok' = 'ok') =>
      settledCard({ args, name: 'hexbot_plugins', result, status })

    expect(
      plugin(
        { action: 'setup', id: 'connector:notion' },
        '{"name":"Notion","note":"Set up. Try it now.","plugin":"connector:notion","ready":true}'
      )
    ).toMatchObject({
      decision: 'once',
      form: { action: 'setup', id: 'connector:notion', kind: 'plugin', name: 'Notion' }
    })
    // From before results named the plugin.
    expect(
      plugin({ action: 'enable', id: 'connector:web_search' }, '{"plugin":"connector:web_search"}')
    ).toMatchObject({ form: { name: 'Web search' } })
    expect(
      plugin(
        { action: 'install', description: 'GitHub issues', name: 'github' },
        'The user said no. Leave it, and ask what they would like instead.',
        'error'
      )
    ).toMatchObject({
      decision: 'deny',
      form: {
        action: 'install',
        description: 'GitHub issues',
        id: 'package:github',
        name: 'github'
      }
    })
    expect(
      plugin(
        { action: 'enable', id: 'skill:pdf' },
        '{"note":"Already on.","on":true,"plugin":"skill:pdf"}'
      )
    ).toBeNull()
    expect(plugin({ action: 'list' }, '{"plugins":[]}')).toBeNull()
    // Agreed on, then the install failed: the card stays, saying so.
    expect(
      plugin(
        { action: 'install', name: 'echo' },
        "The user agreed on the card, but it didn't work: The package echo is already installed.",
        'error'
      )
    ).toMatchObject({ decision: 'once', failed: true, form: { id: 'package:echo' } })
    // A failure before any card showed brings none back.
    expect(
      plugin(
        { action: 'enable', id: 'connector:google_calendar' },
        'Connect Google Calendar in Settings, Plugins, Google Calendar, Connect.',
        'error'
      )
    ).toBeNull()
  })
})
