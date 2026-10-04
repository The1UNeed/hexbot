import { useEffect, useReducer, useRef } from 'react'

import type { InstallerApi, InstallResult } from './api'
import { errorMessage } from './api'
import { tildify } from './copy'
import { AppDone, HeadlessDone, Removed } from './done'
import { backOf, initialState, reduce, type State } from './machine'
import { OptionPage } from './option-page'
import {
  Choose,
  ErrorScreen,
  Installed,
  Loading,
  Uninstall,
  Unsupported,
  Welcome,
  Working
} from './screens'

export function App({ api }: { api: InstallerApi }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const started = useRef(-1)
  const { detection, screen } = state

  // Refresh detection after failed jobs before enabling navigation.
  useEffect(() => {
    if (!['loading', 'refreshing'].includes(screen.name) || started.current === state.run) {
      return
    }

    started.current = state.run
    api.detect().then(
      found => dispatch({ detection: found, type: 'detected' }),
      error => dispatch({ message: errorMessage(error), run: state.run, type: 'failed' })
    )
  }, [api, screen.name, state.run])

  // Each job runs once; its events carry the run number, so a late event from
  // an earlier attempt cannot touch a newer screen.
  useEffect(() => {
    if (screen.name !== 'working' || started.current === screen.run) {
      return
    }

    const { job, run } = screen

    started.current = run

    const onProgress = (event: Parameters<Parameters<InstallerApi['apply']>[2]>[0]) =>
      dispatch({ event, run, type: 'progress' })

    const work: Promise<InstallResult | null> =
      job.kind === 'uninstall'
        ? api.uninstall(job.removeData, onProgress).then(() => null)
        : job.kind === 'repair'
          ? api.repair(onProgress)
          : job.from
            ? api.change(job.from, job.option, job.track, onProgress)
            : api.apply(job.option, job.track, onProgress)

    work.then(
      result => dispatch({ result, run, type: 'finished' }),
      error => dispatch({ message: errorMessage(error), run, type: 'failed' })
    )
  }, [api, screen])

  useKeys(state, dispatch)

  // Move focus to each new screen's heading, so Enter and screen readers start there.
  useEffect(() => {
    document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [screen.name])

  const quit = () => void api.quit()
  const back = () => dispatch({ type: 'back' })

  if (screen.name === 'loading' || screen.name === 'refreshing' || (!detection && screen.name !== 'error')) {
    return <Loading />
  }

  if (screen.name === 'error') {
    return (
      <ErrorScreen
        canGoBack={screen.origin !== null}
        job={screen.job}
        message={screen.message}
        onBack={back}
        onRetry={() => dispatch({ type: 'retry' })}
      />
    )
  }

  if (!detection) {
    return <Loading />
  }

  switch (screen.name) {
    case 'unsupported':
      return <Unsupported detection={detection} onQuit={quit} />

    case 'welcome':
      return <Welcome detection={detection} onBegin={() => dispatch({ type: 'begin' })} />

    case 'installed':
      return (
        <Installed
          detection={detection}
          onChange={() => dispatch({ type: 'changeOption' })}
          onQuit={quit}
          onRepair={() => dispatch({ type: 'repair' })}
          onUninstall={() => dispatch({ type: 'askUninstall' })}
        />
      )

    case 'choose':
      return (
        <Choose
          detection={detection}
          onBack={back}
          onNext={() => dispatch({ type: 'next' })}
          onSelect={option => dispatch({ option, type: 'select' })}
          selected={screen.selected}
        />
      )

    case 'option':
      return (
        <OptionPage
          api={api}
          detection={detection}
          key={screen.option}
          onBack={back}
          onInstall={track => dispatch({ option: screen.option, track, type: 'install' })}
          option={screen.option}
        />
      )

    case 'uninstall':
      return (
        <Uninstall
          detection={detection}
          onBack={back}
          onToggle={() => dispatch({ type: 'toggleRemoveData' })}
          onUninstall={() => dispatch({ type: 'uninstall' })}
          removeData={screen.removeData}
        />
      )

    case 'working':
      return (
        <Working
          data={tildify(detection.locations!.hexbotHome, detection.locations!.home)}
          screen={screen}
        />
      )

    case 'done':
      if (screen.job.kind === 'uninstall' || !screen.result) {
        return (
          <Removed
            detection={detection}
            onQuit={quit}
            removedData={screen.job.kind === 'uninstall' && screen.job.removeData}
          />
        )
      }

      return screen.result.receipt.option === 'headless' ? (
        <HeadlessDone api={api} job={screen.job} notes={screen.notes} result={screen.result} />
      ) : (
        <AppDone
          api={api}
          detection={detection}
          job={screen.job}
          notes={screen.notes}
          result={screen.result}
        />
      )
  }
}

/**
 * Escape goes back where a screen has a Back or Cancel. Enter presses the
 * screen's main button unless focus is on another control.
 */
function useKeys(state: State, dispatch: (event: { type: 'back' }) => void) {
  const canGoBack = backOf(state) !== null && state.screen.name !== 'working'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      if (event.key === 'Escape' && canGoBack) {
        event.preventDefault()
        dispatch({ type: 'back' })

        return
      }

      const target = event.target instanceof Element ? event.target : null

      if (
        event.key === 'Enter' &&
        !target?.closest('button, a, input, summary, [role="radio"], [role="switch"]')
      ) {
        const primary = document.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled)')

        if (primary) {
          event.preventDefault()
          primary.click()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canGoBack, dispatch])
}
