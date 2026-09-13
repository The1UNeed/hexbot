import { cn } from '../../lib/cn'

/** A shimmering placeholder the size of the content that is on its way. */
export function Skeleton({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div aria-label={label} className={cn('hex-skeleton h-4 w-full', className)} role="status" />
  )
}

/** A few lines of text still loading, in the rhythm of a list or a paragraph. */
export function SkeletonLines({
  className,
  label,
  lines = 3
}: {
  className?: string
  label?: string
  lines?: number
}) {
  return (
    <div aria-label={label ?? 'Loading'} className={cn('space-y-2.5', className)} role="status">
      {Array.from({ length: lines }, (_, index) => (
        <div
          aria-hidden
          className="hex-skeleton h-4"
          key={index}
          style={{ width: `${[92, 68, 80, 56][index % 4]}%` }}
        />
      ))}
    </div>
  )
}
