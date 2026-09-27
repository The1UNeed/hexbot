// PostHog for Connect, sharing the hexbot.app project so both surfaces land
// on one dashboard. Same rules as the site (apps/site/src/scripts/analytics.ts):
// nothing loads until the visitor accepts the cookie notice, the choice lives
// in localStorage under the same key, and PostHog starts opted out so a stale
// consent record of its own can never win over ours.
//
// Connect URLs carry secrets (a registration code, an app's state, a PKCE
// request), so every URL property is cut down to its path before it leaves the
// browser, and session replay never runs on the pages that carry them.
//
// Only this module touches posthog-js. Pages call `track` and `identify`;
// both are no-ops until consent is granted and the client has loaded.
import type { CaptureResult, PostHog } from "posthog-js";

export type Choice = "granted" | "denied";
export const STORAGE_KEY = "hexbot-analytics";
export const projectKey = () => process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
/** Pages whose address or content carries a credential: no session replay here. */
export const SENSITIVE_PATHS = ["/connect/approve", "/connect/authorize", "/connect/browser"];
export const isSensitivePath = (pathname: string) => SENSITIVE_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`));

export function parseChoice(value: string | null | undefined): Choice | null {
  return value === "granted" || value === "denied" ? value : null;
}

const urlKeys = ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer", "$session_entry_url", "$session_entry_referrer"];
const bare = (value: unknown) => {
  if (typeof value !== "string") return value;
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return value; }
};
/** Strip query strings and fragments from every URL property, including the person properties PostHog sets from them. */
export function scrubEvent<T extends { properties?: Record<string, unknown> }>(event: T): T {
  const properties = event.properties;
  if (!properties) return event;
  for (const bag of [properties, properties.$set, properties.$set_once]) {
    if (!bag || typeof bag !== "object") continue;
    for (const key of urlKeys) if (key in (bag as Record<string, unknown>)) (bag as Record<string, unknown>)[key] = bare((bag as Record<string, unknown>)[key]);
  }
  return event;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let choice: Choice | null = null;
let client: Promise<PostHog> | undefined;
let queued: Array<[string, Record<string, unknown> | undefined]> = [];
let pendingIdentity: string | null = null;

const read = (): Choice | null => { try { return parseChoice(localStorage.getItem(STORAGE_KEY)); } catch { return null; } };
const notify = () => listeners.forEach(listener => listener());

/** Current consent; `null` until the visitor decides. */
export const consent = () => choice;
export function subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

function recordingFor(ph: PostHog, pathname: string) {
  if (choice !== "granted") return;
  if (isSensitivePath(pathname)) ph.stopSessionRecording(); else ph.startSessionRecording();
}

function sync(ph: PostHog) {
  if (choice !== "granted") { ph.opt_out_capturing(); return; }
  if (!ph.has_opted_in_capturing()) ph.opt_in_capturing({ captureEventName: null });
  recordingFor(ph, window.location.pathname);
  if (pendingIdentity) { ph.identify(pendingIdentity); pendingIdentity = null; }
  for (const [event, properties] of queued.splice(0)) ph.capture(event, properties);
}

function load() {
  client ??= import("posthog-js").then(({ default: ph }) => {
    ph.init(projectKey(), {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2026-08-30",
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      // Consent is per host: the site's random visitor id never becomes a Connect account id.
      cross_subdomain_cookie: false,
      before_send: (event: CaptureResult | null) => (choice === "granted" && event ? scrubEvent(event) : null),
      // Autocapture keeps element attributes (hrefs, ids) out of events; replay masks every input.
      mask_all_element_attributes: true,
      session_recording: { maskAllInputs: true },
      // Replay starts from sync(), and only on pages that carry no credential.
      disable_session_recording: true,
      // Replaces Vercel Speed Insights and Web Analytics: Core Web Vitals and uncaught errors.
      capture_performance: { web_vitals: true },
      capture_exceptions: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
    });
    return ph;
  });
  client.then(sync, () => { client = undefined; });
}

function apply(next: Choice) {
  choice = next;
  if (next === "granted") load();
  else { queued = []; pendingIdentity = null; if (client) load(); }
  notify();
}

/** Record the visitor's answer to the cookie notice. */
export function decide(next: Choice) {
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode: the choice lasts for this page only */ }
  apply(next);
}

/** Queue an event; sent once consent is granted and the client is up, dropped if declined. */
export function track(event: string, properties?: Record<string, unknown>) {
  if (!projectKey() || choice === "denied") return;
  queued.push([event, properties]);
  if (choice === "granted") load();
}

/** Tie events to the signed-in Clerk user. Nothing is sent without consent. */
export function identify(userId: string) {
  if (!projectKey() || choice === "denied") return;
  pendingIdentity = userId;
  if (choice === "granted") load();
}

/** Forget the identity after sign-out so the next visitor starts anonymous. */
export function reset() {
  pendingIdentity = null;
  if (client) client.then(ph => ph.reset(), () => undefined);
}

export function captureException(error: unknown) {
  if (choice === "granted" && client) client.then(ph => ph.captureException(error), () => undefined);
}

/** Client-side navigation: stop replay before a sensitive page, resume after it. */
export function routeChanged(pathname: string) {
  if (client) client.then(ph => recordingFor(ph, pathname), () => undefined);
}

/** Runs once per page load from instrumentation-client.ts. */
export function initAnalytics() {
  if (typeof window === "undefined" || !projectKey()) return;
  choice = read();
  window.addEventListener("storage", event => {
    const next = event.key === STORAGE_KEY ? parseChoice(event.newValue) : null;
    if (next) apply(next);
  });
  if (choice === "granted") load();
  notify();
}
