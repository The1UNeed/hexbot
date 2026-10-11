/**
 * The schedule a job save sends. An edit sends it only when it changed: the
 * daemon reads a relative schedule such as "in 30m" from now, so sending it
 * again would move the job.
 */
export const scheduleChange = (typed: string, saved?: string) =>
  saved !== undefined && typed === saved ? {} : { schedule: typed }
