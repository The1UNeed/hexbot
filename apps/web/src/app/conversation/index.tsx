import { useNavigate, useParams } from '@tanstack/react-router'
import { Check, ChevronDown, Clipboard, File, MoreHorizontal, PanelRight, Paperclip, Send, Square, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { Spinner } from '../../components/ui/spinner'
import { Textarea } from '../../components/ui/textarea'
import { approvalRespond, attachFile, promptSubmit, sessionInterrupt, setSectionModel } from '../../lib/api'
import { getBridge } from '../../lib/bridge'
import type { ApprovalChoice, ApprovalRequest, Attachment, Bot, Message, ToolCall } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { sectionsActions, useLiveSessionId, useSection } from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { transcriptActions, useTranscript } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

const avatarData = (bot?: Bot) => bot?.avatar ? `data:${bot.avatar.mime};base64,${bot.avatar.data}` : null
const dayKey = (time: number) => new Date(time).toDateString()

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const language = /language-([^ ]+)/.exec(className ?? '')?.[1]
  const text = String(children ?? '').replace(/\n$/, '')

  if (!className) {return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">{children}</code>}

  return <div className="my-3 overflow-hidden rounded-panel border border-border"><div className="flex items-center justify-between bg-surface-2 px-3 py-1 text-[length:var(--text-meta)] text-muted"><span>{language ?? 'code'}</span><button aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(text)} type="button"><Clipboard size={13} /></button></div><pre className="overflow-auto p-3 font-mono text-[length:var(--text-secondary)]"><code>{text}</code></pre></div>
}

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown components={{ a: props => <a className="text-accent underline" rel="noreferrer" target="_blank" {...props} />, code: CodeBlock, table: props => <div className="overflow-x-auto"><table className="my-3 w-full border-collapse" {...props} /></div>, td: props => <td className="border border-border p-2" {...props} />, th: props => <th className="border border-border bg-surface-2 p-2 text-left" {...props} /> }} remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
}

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const format = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)

  return <div className="border-t border-border first:border-t-0"><button aria-expanded={open} className="flex w-full items-center gap-2 py-2 text-left text-[length:var(--text-secondary)]" onClick={() => setOpen(value => !value)} type="button">{call.status === 'running' ? <Spinner size="sm" /> : <Check className={call.status === 'error' ? 'text-danger' : 'text-success'} size={13} />}<span className="font-medium">{call.name}</span><span className="min-w-0 flex-1 truncate text-muted">{call.summary ?? (call.status === 'running' ? 'Running…' : format(call.result))}</span><ChevronDown className={open ? 'rotate-180' : ''} size={13} /></button>{open ? <div className="mb-2 grid gap-2"><pre className="overflow-auto rounded-control bg-surface-2 p-2 font-mono text-[length:var(--text-meta)]">{format(call.args)}</pre>{call.result !== null ? <pre className="max-h-60 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-[length:var(--text-meta)]">{format(call.result)}</pre> : null}</div> : null}</div>
}

function Attachments({ attachments, onImage }: { attachments: Attachment[]; onImage: (source: string) => void }) {
  return <div className="mt-2 flex flex-wrap gap-2">{attachments.map(item => item.kind === 'image' && item.dataUrl ? <button key={item.id} onClick={() => onImage(item.dataUrl!)} type="button"><img alt={item.name} className="max-h-64 rounded-panel object-contain" src={item.dataUrl} /></button> : <Chip key={item.id}><File size={12} />{item.name}<span>{Math.ceil(item.size / 1024)} KB</span></Chip>)}</div>
}

function MessageRow({ bot, firstInRun, message, onImage, onRetry }: { bot?: Bot; firstInRun: boolean; message: Message; onImage: (source: string) => void; onRetry: () => void }) {
  if (message.error) {return <div className="flex items-center justify-center gap-2 py-3 text-[length:var(--text-secondary)] text-danger"><span>{message.error}</span><button className="underline" onClick={onRetry} type="button">Retry</button></div>}

  if (message.role === 'system' || message.role === 'tool') {return null}
  const assistant = message.role === 'assistant'

  return <article className={`flex gap-2 py-2 ${assistant ? 'justify-start' : 'justify-end'}`}>
    {assistant ? <div className="w-8 shrink-0">{firstInRun ? <Avatar image={avatarData(bot)} name={bot?.display_name ?? 'Bot'} /> : null}</div> : null}
    <div className={assistant ? 'min-w-0 max-w-[78%]' : 'max-w-[78%] rounded-bubble bg-accent/12 px-4 py-2.5'}>
      {assistant && firstInRun ? <div className="mb-1 text-[length:var(--text-secondary)] font-semibold">{bot?.display_name ?? 'Bot'}</div> : null}
      {message.thinking ? <details className="mb-2 text-[length:var(--text-secondary)] text-muted"><summary className="cursor-pointer">Thinking</summary><div className="mt-1 whitespace-pre-wrap border-l border-border pl-3">{message.thinking}</div></details> : null}
      {message.text ? <div className="prose prose-sm max-w-none break-words"><Markdown text={message.text} />{message.streaming ? <span aria-label="Streaming" className="ml-0.5 inline-block h-4 w-px animate-pulse bg-accent align-middle" /> : null}</div> : null}
      {message.toolCalls.length ? <div className="mt-2 border-y border-border">{message.toolCalls.map(call => <ToolRow call={call} key={call.toolId} />)}</div> : null}
      <Attachments attachments={message.attachments} onImage={onImage} />
    </div>
  </article>
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const choose = async (choice: ApprovalChoice) => { await approvalRespond(approval.sessionId, approval.requestId, choice); transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice) }

  return <div className="ml-10 max-w-xl border-l-2 border-warning px-4 py-3"><div className="font-medium">Approval needed</div>{approval.command ? <pre className="my-2 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-[length:var(--text-secondary)]">{approval.command}</pre> : null}{approval.reason ? <p className="mb-2 text-[length:var(--text-secondary)] text-muted">{approval.reason}</p> : null}{approval.decision ? <Chip tone={approval.decision === 'deny' ? 'danger' : 'success'}>{approval.decision === 'deny' ? 'Denied' : approval.decision === 'always' ? 'Always allowed' : 'Approved'}</Chip> : <div className="flex flex-wrap gap-2"><Button onClick={() => void choose('once')} size="sm" variant="primary">Approve</Button><Button onClick={() => void choose('deny')} size="sm">Deny</Button><Button onClick={() => void choose('always')} size="sm">Always allow</Button></div>}</div>
}

export function suggestedPrompts(description: string): string[] {
  const subject = description.trim().replace(/[.!?].*$/, '') || 'what you can help me with'

  return [`Help me get started with ${subject.toLowerCase()}`, `What should I know about ${subject.toLowerCase()}?`, 'What can we work on together?']
}

interface DraftAttachment { file: File; id: string; preview?: string }

function Composer({ bot, sessionId, streaming }: { bot?: Bot; sessionId: string | null; streaming: boolean }) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [sending, setSending] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const addFiles = (incoming: File[]) => setFiles(current => [...current, ...incoming.map(file => ({ file, id: `${file.name}-${file.size}-${crypto.randomUUID()}`, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }))])

  const send = async () => {
    if (!sessionId || sending || (!text.trim() && !files.length)) {return}
    setSending(true)

    try {
      for (const item of files) {await attachFile(sessionId, item.file)}
      const attachments: Attachment[] = files.map(item => ({ dataUrl: item.preview, id: item.id, kind: item.file.type.startsWith('image/') ? 'image' : item.file.type === 'application/pdf' ? 'pdf' : 'file', mime: item.file.type, name: item.file.name, size: item.file.size }))
      transcriptActions().appendUserMessage(sessionId, text.trim(), attachments)
      await promptSubmit(sessionId, text.trim())
      setText(''); setFiles([])
    } finally { setSending(false) }
  }

  useEffect(() => { const node = document.getElementById('conversation-composer') as HTMLTextAreaElement | null;

 if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 8 * 22)}px` } }, [text])

  return <div className="border-t border-border bg-surface p-3">{files.length ? <div className="mb-2 flex flex-wrap gap-2">{files.map(item => <Chip key={item.id}>{item.preview ? <img alt="" className="size-5 rounded object-cover" src={item.preview} /> : <File size={12} />}{item.file.name}<button aria-label={`Remove ${item.file.name}`} onClick={() => setFiles(current => current.filter(file => file.id !== item.id))} type="button"><X size={12} /></button></Chip>)}</div> : null}<div className="flex items-end gap-2 rounded-panel border border-border bg-surface px-2 py-2 focus-within:ring-2 focus-within:ring-accent/40"><input className="hidden" multiple onChange={event => addFiles([...event.target.files ?? []])} ref={picker} type="file" /><button aria-label="Attach files" className="rounded-control p-2 text-muted hover:bg-surface-2" onClick={() => picker.current?.click()} type="button"><Paperclip size={18} /></button><Textarea aria-label="Message" className="max-h-44 min-h-9 flex-1 border-0 p-2 focus-visible:ring-0" disabled={!sessionId} id="conversation-composer" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} onPaste={event => { const pasted = [...event.clipboardData.files].filter(file => file.type.startsWith('image/') || file.type.startsWith('text/'));

 if (pasted.length) { event.preventDefault(); addFiles(pasted) } }} placeholder={`Message ${bot?.display_name ?? 'bot'}`} rows={1} value={text} />{streaming ? <Button aria-label="Stop" icon={<Square size={14} />} onClick={() => sessionId && void sessionInterrupt(sessionId)} variant="primary">Stop</Button> : <Button aria-label="Send" busy={sending} disabled={!sessionId || (!text.trim() && !files.length)} icon={<Send size={15} />} onClick={() => void send()} variant="primary">Send</Button>}</div></div>
}

export function ConversationColumn() {
  const params = useParams({ strict: false }) as { bot?: string; section?: string }
  const navigate = useNavigate()
  const bot = useBot(params.bot ?? null)
  const section = useSection(params.section ?? null)
  const liveId = useLiveSessionId(params.section ?? null)
  const transcript = useTranscript(liveId)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [visible, setVisible] = useState(60)
  const [atBottom, setAtBottom] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const models = useSettings(state => state.models)
  const refreshModels = useSettings(state => state.refreshModels)
  const togglePanel = useUi(state => state.toggleRightPanel)
  const messages = useMemo(() => transcript?.messages ?? [], [transcript?.messages])
  const approvals = useMemo(() => transcript?.approvals ?? [], [transcript?.approvals])
  const streaming = Boolean(transcript?.streamingMessageId)
  useEffect(() => { if (params.section && !liveId) {void sectionsActions().open(params.section)} }, [liveId, params.section])
  useEffect(() => setTitle(section?.title ?? ''), [section?.title])
  useEffect(() => { if (!models.all.length) {void refreshModels(bot?.provider ?? undefined)} }, [bot?.provider, models.all.length, refreshModels])
  useEffect(() => { if (atBottom) {bottom.current?.scrollIntoView({ block: 'end' })} }, [approvals.length, atBottom, messages])
  const wasStreaming = useRef(streaming)
  useEffect(() => { if (document.hidden && wasStreaming.current && !streaming) { const body = messages.at(-1)?.text || 'New message'; const input = { body, sectionId: section?.id, title: bot?.display_name ?? 'Hexbot' }; const bridge = getBridge();

 if (bridge) {bridge.notify(input);} else if ('Notification' in window && Notification.permission === 'granted') {new Notification(input.title, { body: input.body })} }

 wasStreaming.current = streaming }, [bot?.display_name, messages, section?.id, streaming])
  const previousApprovalCount = useRef(approvals.length)
  useEffect(() => { if (!getBridge() && document.hidden && approvals.length > previousApprovalCount.current && 'Notification' in window && Notification.permission === 'granted') {new Notification('Approval needed', { body: approvals.at(-1)?.command ?? approvals.at(-1)?.reason ?? 'A bot is asking for permission.' })} previousApprovalCount.current = approvals.length }, [approvals])
  const shown = messages.slice(-visible)

  const retry = () => { const last = messages.findLast(message => message.role === 'user');

 if (liveId && last) {void promptSubmit(liveId, last.text)} }

  const rename = async () => { if (section && title.trim() && title.trim() !== section.title) {await sectionsActions().rename(section.id, title.trim());} setEditing(false) }

  const selectModel = async (model: string) => { if (!liveId) {return;} await setSectionModel(liveId, model); transcriptActions().sessionInfo(liveId, { ...(transcript?.info ?? {}), model }) }
  const currentModel = transcript?.info?.model ?? bot?.model ?? 'Model'

  const archive = async () => { if (!section) {return;} await sectionsActions().archive(section.id) }

  const remove = async () => { if (!section || !window.confirm(`Delete “${section.title}”? This also purges its memory.`)) {return;} await sectionsActions().remove(section.id); void navigate({ to: '/' }) }

  return <div className="relative flex h-screen min-h-0 flex-col bg-background" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const input = viewport.current?.parentElement?.querySelector<HTMLInputElement>('input[type=file]');

 if (input) { const transfer = new DataTransfer();

 for (const file of event.dataTransfer.files) {transfer.items.add(file);} input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })) } }}>
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4"><Avatar image={avatarData(bot)} name={bot?.display_name ?? params.bot ?? 'Bot'} /><div className="min-w-0 flex-1"><div className="text-[length:var(--text-secondary)] font-medium">{bot?.display_name ?? params.bot}</div>{editing ? <Input autoFocus className="h-7 max-w-sm" onBlur={() => void rename()} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') {void rename();}

 if (event.key === 'Escape') { setTitle(section?.title ?? ''); setEditing(false) } }} value={title} /> : <button className="max-w-full truncate text-left font-semibold" onClick={() => setEditing(true)} type="button">{section?.title ?? 'Conversation'}</button>}</div><Menu items={models.all.map(model => ({ label: <span className="flex w-full items-center gap-2"><span className="flex-1">{model.label}</span>{model.id === currentModel ? <Check size={13} /> : null}</span>, onSelect: () => void selectModel(model.id) }))} trigger={<button aria-label="Choose model" type="button"><Chip>{currentModel}</Chip></button>} /><Menu items={[{ label: 'Rename', onSelect: () => setEditing(true) }, { label: 'Archive', onSelect: () => void archive() }, { separator: true, label: '' }, { label: <span className="flex items-center gap-2 text-danger"><Trash2 size={14} />Delete</span>, onSelect: () => void remove() }]} trigger={<button aria-label="Conversation actions" className="rounded-control p-2 hover:bg-surface-2" type="button"><MoreHorizontal size={18} /></button>} /><button aria-label="Toggle profile panel" className="rounded-control p-2 hover:bg-surface-2" onClick={() => togglePanel()} type="button"><PanelRight size={18} /></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto" onScroll={event => { const node = event.currentTarget; setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80) }} ref={viewport}>{messages.length === 0 ? <div className="grid h-full place-content-center justify-items-center gap-3 p-8 text-center"><Avatar image={avatarData(bot)} name={bot?.display_name ?? 'Bot'} size="lg" /><div><h2 className="text-[length:var(--text-title)] font-semibold">{bot?.display_name}</h2><p className="text-muted">{section?.title}</p></div><div className="grid gap-2">{suggestedPrompts(bot?.description ?? '').map(prompt => <Button key={prompt} onClick={() => { if (liveId) { transcriptActions().appendUserMessage(liveId, prompt); void promptSubmit(liveId, prompt) } }}>{prompt}</Button>)}</div></div> : <div className="mx-auto max-w-3xl px-5 py-4">{messages.length > visible ? <button className="mx-auto mb-4 block text-[length:var(--text-secondary)] text-accent" onClick={() => setVisible(value => value + 60)} type="button">Load earlier messages</button> : null}{shown.map((message, index) => { const previous = shown[index - 1]; const separator = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);

 return <div key={message.id}>{separator ? <div className="my-4 flex items-center gap-3 text-[length:var(--text-meta)] text-muted"><span className="h-px flex-1 bg-border" /><span>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(message.createdAt)}</span><span className="h-px flex-1 bg-border" /></div> : null}<MessageRow bot={bot} firstInRun={!previous || previous.role !== message.role} message={message} onImage={setLightbox} onRetry={retry} /></div>})}{approvals.map(approval => <ApprovalCard approval={approval} key={approval.requestId} />)}<div ref={bottom} /></div>}</div>
    {!atBottom ? <button className="absolute right-5 bottom-24 rounded-full border border-border bg-surface px-3 py-1.5 text-[length:var(--text-secondary)] shadow-popup" onClick={() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); setAtBottom(true) }} type="button">Jump to latest</button> : null}
    <Composer bot={bot} sessionId={liveId} streaming={streaming} />
    <Dialog onOpenChange={open => !open && setLightbox(null)} open={Boolean(lightbox)} toolbar={<button aria-label="Close image" onClick={() => setLightbox(null)} type="button"><X /></button>}><div className="grid max-h-[85vh] place-items-center bg-background p-4">{lightbox ? <img alt="Attachment preview" className="max-h-[78vh] max-w-full object-contain" src={lightbox} /> : null}</div></Dialog>
  </div>
}
