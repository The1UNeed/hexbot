import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import { emptyChat, reduceChat, settledBot } from './chat'
import { encodeAnswer } from './chat-send'
import type { ChatRoute } from './routes'
import type { Bot, Room, Section } from './types'

type Sheet = {
  requestId: string
  sessionId: string
  questionId: string
  text: string
  choices: string[]
  multiSelect: boolean
}

const appSource = ts.sys.readFile(decodeURIComponent(new URL('../../App.tsx', import.meta.url).pathname))
if (!appSource) throw new Error('App.tsx not found')
const app = ts.createSourceFile(
  'App.tsx',
  appSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let setter: ts.Node | undefined
let questionEffect: ts.Node | undefined
let submit: ts.Node | undefined
let composerSubmit: ts.Node | undefined
function findHandlers(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'send')
    composerSubmit = node.initializer
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(app) === 'setQuestion' &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  )
    setter = node.initializer.arguments[0]
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(app) === 'useEffect' &&
    node.arguments[1]?.getText(app).includes('firstQuestionId')
  )
    questionEffect = node.arguments[0]
  if (
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
    node.attributes.properties.some(
      p =>
        ts.isJsxAttribute(p) &&
        p.name.getText(app) === 'testID' &&
        p.initializer &&
        ts.isStringLiteral(p.initializer) &&
        p.initializer.text === 'question-sheet'
    )
  ) {
    const action = node.attributes.properties.find(
      p => ts.isJsxAttribute(p) && p.name.getText(app) === 'action'
    )
    if (
      action &&
      ts.isJsxAttribute(action) &&
      action.initializer &&
      ts.isJsxExpression(action.initializer) &&
      action.initializer.expression &&
      ts.isObjectLiteralExpression(action.initializer.expression)
    ) {
      const press = action.initializer.expression.properties.find(
        p => ts.isPropertyAssignment(p) && p.name.getText(app) === 'onPress'
      )
      if (press && ts.isPropertyAssignment(press)) submit = press.initializer
    }
  }
  ts.forEachChild(node, findHandlers)
}
findHandlers(app)

// Run the actual App callbacks while the real chat reducer supplies pending cards.
function callback<T>(node: ts.Node | undefined, scope: Record<string, unknown>): T {
  if (!node) throw new Error('Question-sheet callback not found')
  const exports: { run?: T } = {}
  const code = ts.transpileModule(`exports.run = ${node.getText(app)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function(...Object.keys(scope), 'exports', code)(...Object.values(scope), exports)
  return exports.run!
}

const event = (
  type: string,
  payload: Record<string, unknown>,
  session_id = 'session'
): GatewayEvent => ({ type, payload, session_id })
const request = () =>
  event('clarify.request', {
    request_id: 'batch',
    questions: [
      { qid: 'first', question: 'When?' },
      {
        qid: 'second',
        question: 'Where?',
        choices: ['Library', 'Office'],
        multi_select: true
      }
    ]
  })
const partial = () =>
  event('clarify.resolved', { request_id: 'batch', answers: { first: 'Now' }, status: 'waiting' })

function deferred() {
  let resolve!: (value?: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const sectionRoute = (id = 'section'): ChatRoute => ({
  kind: 'section',
  section: { id, bot: 'alpha', live_session_id: 'session' } as Section,
  bot: {
    name: 'alpha',
    status: 'needs_you',
    status_detail: { session_id: 'session', section_id: id }
  } as Bot
})
const roomRoute = (id = 'room'): ChatRoute => ({ kind: 'room', room: { id } as Room })
const routeChanges = [
  { label: 'another section', from: sectionRoute(), to: sectionRoute('other-section') },
  { label: 'another room', from: roomRoute(), to: roomRoute('other-room') },
  { label: 'a room with the same raw ID', from: sectionRoute('same'), to: roomRoute('same') },
  { label: 'a section with the same raw ID', from: roomRoute('same'), to: sectionRoute('same') },
  { label: 'the closed conversation', from: sectionRoute(), to: null }
]

function sheet(route: ChatRoute | null = sectionRoute()) {
  const ui = { question: null as Sheet | null, answer: '', choices: [] as string[], draft: '', error: '' }
  const questionRef = { current: null as Sheet | null }
  const mobileRef = {
    current: { chat: emptyChat(), active: { id: 'daemon' }, route }
  }
  const attachmentData = { current: new Map<string, unknown>() }
  const setQuestion = callback<(next: Sheet | null) => void>(setter, {
    questionRef,
    setQuestionState: (next: Sheet | null) => { ui.question = next }
  })
  const inputs = {
    setQuestionAnswer: (text: string) => { ui.answer = text },
    setQuestionChoices: (choices: string[]) => { ui.choices = choices }
  }
  const syncQuestion = callback<() => void>(questionEffect, { mobileRef, setQuestion, ...inputs })
  let selection = ''
  const receive = (message: GatewayEvent) => {
    mobileRef.current.chat = reduceChat(mobileRef.current.chat, message)
    const first = mobileRef.current.chat.questions[0]
    const next = JSON.stringify([first?.questions[0]?.id, first?.requestId, first?.sessionId])
    if (next !== selection) {
      selection = next
      syncQuestion()
    }
  }
  const send = (composerText?: string) => {
    const reply = deferred()
    const answer = vi.fn(() => reply.promise)
    let completion!: Promise<void>
    const press = callback<(text?: string) => void>(composerText === undefined ? submit : composerSubmit, {
      question: ui.question,
      questionRef,
      questionAnswer: ui.answer,
      questionChoices: ui.choices,
      draft: ui.draft,
      mobile: { ...mobileRef.current, answer },
      mobileRef,
      attachmentData,
      encodeAnswer,
      setQuestion,
      ...inputs,
      setDraft: (next: string | ((current: string) => string)) => {
        ui.draft = typeof next === 'function' ? next(ui.draft) : next
      },
      act: (work: () => Promise<void>) => {
        completion = work().catch(error => { ui.error = error.message })
      }
    })
    press(composerText)
    return { ...reply, answer, completion }
  }
  receive(request())
  ui.answer = 'Now'
  ui.draft = 'Now'
  return { ui, receive, send, setQuestion, mobileRef, attachmentData }
}

describe('question-sheet submit continuations', () => {
  it('preserves the next question and newly typed inputs when its event precedes the old reply', async () => {
    const state = sheet()
    const sent = state.send()
    expect(sent.answer).toHaveBeenCalledWith('batch', 'first', 'Now', 'session')
    state.receive(partial())
    expect(state.ui.question?.questionId).toBe('second')
    state.ui.answer = 'Near home'
    state.ui.choices = ['Library']
    state.ui.draft = 'Next message'
    sent.resolve({ status: 'waiting', answers: { first: 'Now' } })
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { questionId: 'second' },
      answer: 'Near home', choices: ['Library'], draft: 'Next message', error: ''
    })
  })

  it('closes the submitted sheet before a later event opens the next question', async () => {
    const state = sheet()
    const sent = state.send()
    sent.resolve({ status: 'waiting' })
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, answer: '', choices: [], draft: '' })
    state.receive(partial())
    expect(state.ui).toMatchObject({ question: { questionId: 'second' }, answer: '', choices: [] })
  })

  it('keeps the submitted question and input after rejection', async () => {
    const state = sheet()
    state.ui.choices = ['Saved choice']
    const sent = state.send()
    sent.reject(new Error('Answer not delivered'))
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { questionId: 'first' }, answer: 'Now', choices: ['Saved choice'], draft: 'Now',
      error: 'Answer not delivered'
    })
  })

  it('keeps a newer sheet and its input when the old answer rejects', async () => {
    const state = sheet()
    const sent = state.send()
    state.receive(partial())
    state.ui.answer = 'Office'
    state.ui.draft = 'Next message'
    sent.reject(new Error('Disconnected'))
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { questionId: 'second' }, answer: 'Office', draft: 'Next message', error: 'Disconnected'
    })
  })

  it.each([
    ['request', { requestId: 'new-request' }],
    ['question', { questionId: 'new-question' }],
    ['session with reused request and question IDs', { sessionId: 'other-session' }],
    ['selection or daemon with all IDs reused', {}]
  ])('preserves a replacement %s sheet and all inputs', async (_label, identity) => {
    const state = sheet()
    const sent = state.send()
    state.setQuestion({ ...state.ui.question!, ...identity })
    const replacement = state.ui.question
    state.ui.answer = 'New answer'
    state.ui.choices = ['New choice']
    state.ui.draft = 'New draft'
    sent.resolve()
    await sent.completion
    expect(state.ui.question).toBe(replacement)
    expect(state.ui).toMatchObject({ answer: 'New answer', choices: ['New choice'], draft: 'New draft' })
  })

  it('leaves inputs and the composer alone after the submitted sheet is dismissed', async () => {
    const state = sheet()
    const sent = state.send()
    state.setQuestion(null)
    state.ui.draft = 'A new message'
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, answer: 'Now', draft: 'A new message' })
  })

  it('keeps the existing policy of retaining a draft different from the submitted answer', async () => {
    const state = sheet()
    state.ui.draft = 'Another message'
    const sent = state.send()
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, answer: '', choices: [], draft: 'Another message' })
  })

  it('preserves a newly typed composer draft even when the submitted sheet stays selected', async () => {
    const state = sheet()
    const sent = state.send()
    state.ui.draft = 'New message'
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, answer: '', choices: [], draft: 'New message' })
  })

  it('does not let a second old submit clear a sheet selected after the first reply', async () => {
    const state = sheet()
    const first = state.send()
    const second = state.send()
    first.resolve()
    await first.completion
    state.receive(partial())
    state.ui.answer = 'Office'
    state.ui.choices = ['Office']
    state.ui.draft = 'Next message'
    second.resolve()
    await second.completion
    expect(state.ui).toMatchObject({
      question: { questionId: 'second' }, answer: 'Office', choices: ['Office'], draft: 'Next message'
    })
  })

  it('clears delivered composer text without clearing an advanced attachment question sheet', async () => {
    const state = sheet()
    state.setQuestion(null)
    state.attachmentData.current.set('file', {})
    const opened = state.send('Now')
    expect(opened.answer).not.toHaveBeenCalled()
    expect(state.ui).toMatchObject({ question: { questionId: 'first' }, answer: 'Now', draft: 'Now' })
    const sent = state.send()
    state.receive(partial())
    state.mobileRef.current.route = sectionRoute()
    state.ui.answer = 'Near home'
    state.ui.choices = ['Library']
    sent.resolve({ status: 'waiting', answers: { first: 'Now' } })
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { questionId: 'second' }, answer: 'Near home', choices: ['Library'], draft: '', error: ''
    })
  })

  it('clears delivered composer text when settlement closes the prefilled attachment sheet before the reply', async () => {
    const state = sheet()
    state.receive(event('clarify.request', {
      request_id: 'batch', questions: [{ qid: 'first', question: 'When?' }]
    }))
    state.setQuestion(null)
    state.attachmentData.current.set('file', {})
    expect(state.send('Now').answer).not.toHaveBeenCalled()
    const sent = state.send()
    state.receive(event('clarify.resolved', {
      request_id: 'batch', answers: { first: 'Now' }, status: 'answered'
    }))
    state.mobileRef.current.route = sectionRoute()
    expect(state.ui.question).toBeNull()
    sent.resolve({ status: 'answered', answers: { first: 'Now' } })
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: '', error: '' })
  })

  it('closes the unchanged submitted sheet and clears inputs after a same-section rerender', async () => {
    const state = sheet()
    state.ui.choices = ['Saved choice']
    const sent = state.send()
    state.mobileRef.current.route = sectionRoute()
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, answer: '', choices: [], draft: '', error: '' })
  })

  it('preserves newly typed composer text after settlement closes the submitted sheet', async () => {
    const state = sheet()
    state.receive(event('clarify.request', {
      request_id: 'batch', questions: [{ qid: 'first', question: 'When?' }]
    }))
    const sent = state.send()
    state.receive(event('clarify.resolved', {
      request_id: 'batch', answers: { first: 'Now' }, status: 'answered'
    }))
    state.mobileRef.current.route = sectionRoute()
    state.ui.draft = 'A new message'
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: 'A new message', error: '' })
  })

  it.each(routeChanges)('preserves another sheet and identical input after switching to $label', async ({ from, to }) => {
    const state = sheet(from)
    const previous = state.ui.question!
    const sent = state.send()
    state.mobileRef.current.route = to
    state.setQuestion({ ...previous, sessionId: 'new-session' })
    state.ui.choices = ['New choice']
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { sessionId: 'new-session' }, answer: 'Now', choices: ['New choice'], draft: 'Now', error: ''
    })
  })

  it('preserves a new daemon sheet and identical composer text after the old answer succeeds', async () => {
    const state = sheet()
    const previous = state.ui.question!
    const sent = state.send()
    state.mobileRef.current.active = { id: 'other-daemon' }
    state.setQuestion({ ...previous, sessionId: 'new-session' })
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { sessionId: 'new-session' }, answer: 'Now', draft: 'Now', error: ''
    })
  })
})

describe('plain clarification composer continuations', () => {
  it('preserves the next sheet and its inputs when the event precedes the composer answer reply', async () => {
    const state = sheet()
    state.setQuestion(null)
    const sent = state.send('Now')
    expect(sent.answer).toHaveBeenCalledWith('batch', 'first', 'Now', 'session')
    state.receive(partial())
    state.ui.answer = 'Near home'
    state.ui.choices = ['Library']
    state.ui.draft = 'Next message'
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({
      question: { questionId: 'second' }, answer: 'Near home', choices: ['Library'], draft: 'Next message'
    })
  })

  it('clears delivered text while preserving the advanced question sheet', async () => {
    const state = sheet()
    state.setQuestion(null)
    const sent = state.send('Now')
    state.receive(partial())
    state.mobileRef.current.route = sectionRoute()
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: { questionId: 'second' }, draft: '' })
  })

  it('clears the submitted draft before a later event opens the next sheet', async () => {
    const state = sheet()
    state.setQuestion(null)
    state.ui.draft = ' Now '
    const sent = state.send('Now')
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: '' })
    state.receive(partial())
    expect(state.ui).toMatchObject({ question: { questionId: 'second' }, draft: '' })
  })

  it('preserves a changed draft while the same conversation and selection remain active', async () => {
    const state = sheet()
    state.setQuestion(null)
    const sent = state.send('Now')
    state.mobileRef.current.route = sectionRoute()
    state.ui.draft = 'A different answer'
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: 'A different answer' })
  })

  it('keeps the composer draft and error handling when delivery fails', async () => {
    const state = sheet()
    state.setQuestion(null)
    const sent = state.send('Now')
    sent.reject(new Error('Answer not delivered'))
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: 'Now', error: 'Answer not delivered' })
  })

  it('clears delivered text while preserving a selected card with reused IDs from another session', async () => {
    const state = sheet()
    const previous = state.ui.question!
    state.setQuestion(null)
    const sent = state.send('Now')
    state.setQuestion({ ...previous, sessionId: 'other-session' })
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: { sessionId: 'other-session' }, draft: '' })
  })

  it.each(['daemon', 'route'] as const)('preserves a new %s draft when both sheets are closed', async boundary => {
    const state = sheet()
    state.setQuestion(null)
    const sent = state.send('Now')
    if (boundary === 'daemon') state.mobileRef.current.active = { id: 'other-daemon' }
    else state.mobileRef.current.route = sectionRoute('other-section')
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: 'Now' })
  })

  it('clears unchanged text when canonical settlement recreates the same visible section route before the reply', async () => {
    const state = sheet()
    state.receive(event('clarify.request', {
      request_id: 'batch', questions: [{ qid: 'first', question: 'When?' }]
    }))
    state.setQuestion(null)
    const sent = state.send('Now')
    state.receive(event('clarify.resolved', {
      request_id: 'batch', answers: { first: 'Now' }, status: 'answered'
    }))
    const before = state.mobileRef.current.route!
    if (before.kind !== 'section') throw new Error('Expected private section')
    state.mobileRef.current.route = {
      ...before,
      bot: settledBot(before.bot, state.mobileRef.current.chat, 'session', before.section.id)
    }
    expect(state.mobileRef.current.route).not.toBe(before)
    expect(state.mobileRef.current.route.bot.status).toBe('working')
    sent.resolve({ status: 'answered', answers: { first: 'Now' } })
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: '', error: '' })
  })

  it('clears unchanged text after a same-room snapshot replaces the route object', async () => {
    const state = sheet(roomRoute())
    state.setQuestion(null)
    const sent = state.send('Now')
    state.mobileRef.current.route = roomRoute()
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: '', error: '' })
  })

  it.each(routeChanges)('preserves the draft after switching to $label', async ({ from, to }) => {
    const state = sheet(from)
    state.setQuestion(null)
    const sent = state.send('Now')
    state.mobileRef.current.route = to
    sent.resolve()
    await sent.completion
    expect(state.ui).toMatchObject({ question: null, draft: 'Now', error: '' })
  })
})
