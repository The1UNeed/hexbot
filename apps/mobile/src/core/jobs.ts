/**
 * The schedule a job save sends. An edit sends it only when it changed: the
 * daemon reads a relative schedule such as "in 30m" from now, so sending it
 * again would move the job. So saving the same text does not re-arm a one-time
 * job that already ran; change its schedule to run it again.
 */
export const scheduleChange = (typed: string, saved?: string) =>
  saved !== undefined && typed === saved ? {} : { schedule: typed }
