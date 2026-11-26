/**
 * Settings, Approvals: saved Auto-mode rules ("Allow automatically" and
 * "Ask first"). Refreshed when Approvals opens and on `hexbot.approvals.changed`.
 */

import { create } from 'zustand'

import { approvalRulesAdd, approvalRulesList, approvalRulesRemove } from '../lib/api'
import type { ApprovalRule, ApprovalRuleKind } from '../lib/types'

import { connectionRead } from './connection'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface ApprovalRulesState {
  add: (kind: ApprovalRuleKind, text: string) => Promise<ApprovalRule>
  error: null | string
  /** True once Settings, Approvals has loaded rules; events refresh only then. */
  loaded: boolean
  loading: boolean
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  reset: () => void
  rules: ApprovalRule[]
  /** False when connected to an older daemon without `hexbot.approvals.rules.*`. */
  supported: boolean
}

let latest = 0

export const useApprovalRules = create<ApprovalRulesState>(set => ({
  error: null,
  loaded: false,
  loading: false,
  rules: [],
  supported: true,

  async refresh() {
    const current = connectionRead()
    const mine = ++latest
    set({ error: null, loaded: true, loading: true })

    try {
      const { rules } = await approvalRulesList()

      if (current() && mine === latest) {
        set({ rules, supported: true })
      }
    } catch (error) {
      if (current() && mine === latest) {
        const message = errorText(error)

        if (message.includes('-32601') || /unknown method/i.test(message)) {
          set({ rules: [], supported: false })
        } else {
          set({ error: message })
        }
      }
    } finally {
      if (mine === latest) {
        set({ loading: false })
      }
    }
  },

  async add(kind, text) {
    const { rule } = await approvalRulesAdd(kind, text)
    set(state => ({
      error: null,
      rules: [rule, ...state.rules.filter(item => item.id !== rule.id)]
    }))

    return rule
  },

  async remove(id) {
    await approvalRulesRemove(id)
    set(state => ({
      error: null,
      rules: state.rules.filter(item => item.id !== id)
    }))
  },

  reset() {
    latest++
    set({ error: null, loaded: false, loading: false, rules: [], supported: true })
  }
}))

export function refreshApprovalRulesIfLoaded(): void {
  if (useApprovalRules.getState().loaded) {
    void useApprovalRules.getState().refresh()
  }
}
