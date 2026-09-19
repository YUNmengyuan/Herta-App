/**
 * store.js — Herta 会话状态折叠（服务端与手机端共用）
 *
 * 语义完全对齐 Herta 官方渲染层里的 SessionStore
 * (app.asar → out/renderer/assets/index-*.js)：
 *   - reset / record / turn / agent / speech / overlay / title
 *     / sessionDeleted / workspace 九个事件流的折叠规则照搬，
 *     只是去掉了 React 那一层。
 * 服务端用它维护"PC 上此刻的会话状态"，手机端用同一份代码折叠增量事件，
 * 于是重连时只要拿一份 snapshot 就能无缝续上。
 */

export const INITIAL = Object.freeze({
  bootstrapped: false,
  sessionId: null,
  lang: 'zh',
  record: [],
  recordStart: 0,
  title: null,
  topics: [],
  overlay: null,
  status: 'idle', // idle | thinking | speaking
  streamingText: null,
  retracting: false,
  retryText: null,
  retractKeepLen: null,
  backendActive: false,
  backendInFlight: 0,
  backendStartedAt: null,
  backendError: false,
  backendSucceededSeq: 0,
  backendWorkspace: null,
  backendWorkspaceIsDefault: false,
  recapCompacting: false,
  supervisorChecking: false,
  turnFailed: false,
  turnFailedStatus: null,
  turnFailedProviderCode: null,
  error: null,
  pendingUser: null,
  turnStartedAt: null,
})

export function createStore(onChange) {
  let state = { ...INITIAL }
  let hertaLandedThisTurn = false

  const emit = (patch) => {
    state = { ...state, ...patch }
    if (onChange) onChange(state)
  }

  const clearTransients = {
    streamingText: null,
    retracting: false,
    retryText: null,
    retractKeepLen: null,
  }

  function onReset(e) {
    if (e && typeof e === 'object' && 'noSession' in e) {
      emit({ ...INITIAL, bootstrapped: true })
      return
    }
    if (e && typeof e === 'object' && 'error' in e) {
      emit({ ...INITIAL, error: e.error })
      return
    }
    emit({
      bootstrapped: true,
      sessionId: e.sessionId ?? null,
      lang: e.lang ?? 'zh',
      record: Array.isArray(e.record) ? e.record : [],
      recordStart: e.recordStart ?? 0,
      overlay: e.overlay ?? null,
      title: e.title ?? null,
      topics: e.topics ?? [],
      backendWorkspace: e.backendWorkspace ?? null,
      backendWorkspaceIsDefault: e.backendWorkspaceIsDefault ?? false,
      status: 'idle',
      error: null,
      pendingUser: null,
      ...clearTransients,
      turnStartedAt: null,
      backendActive: false,
      backendInFlight: 0,
      backendStartedAt: null,
      backendError: false,
      recapCompacting: false,
      supervisorChecking: false,
      turnFailed: false,
      turnFailedStatus: null,
      turnFailedProviderCode: null,
    })
    hertaLandedThisTurn = false
  }

  function onRecord(e) {
    if (!e) return
    if (e.kind === 'dropped') {
      // 官方渲染层会在这里调 resyncRecord() 自愈；服务端负责补一次，见 herta.mjs
      emit({ recordDropped: true })
      return
    }
    if (e.kind === 'reset') {
      const start = e.start ?? 0
      emit({
        record: Array.isArray(e.record) ? e.record : [],
        recordStart: start,
        topics: e.topics ?? state.topics,
        ...clearTransients,
        turnFailed: false,
        turnFailedStatus: null,
        turnFailedProviderCode: null,
      })
      return
    }
    const block = e.block
    if (!block) return
    if (block.kind === 'herta') hertaLandedThisTurn = true
    emit({
      record: [...state.record, block],
      recordStart: state.recordStart,
      ...(block.kind === 'herta' ? clearTransients : {}),
      ...(block.kind === 'user' ? { pendingUser: null } : {}),
    })
  }

  function onTurn(e) {
    if (!e) return
    if (e.kind === 'started') {
      hertaLandedThisTurn = false
      emit({
        status: 'thinking',
        ...clearTransients,
        turnStartedAt: Date.now(),
        backendStartedAt: null,
        backendError: false,
        supervisorChecking: false,
        recapCompacting: false,
        turnFailed: false,
        turnFailedStatus: null,
        turnFailedProviderCode: null,
      })
    } else if (e.kind === 'finished') {
      const cleanup =
        state.retracting || (!hertaLandedThisTurn && state.streamingText !== null) ? clearTransients : {}
      emit({
        status: 'idle',
        pendingUser: null,
        turnStartedAt: null,
        backendStartedAt: null,
        backendActive: false,
        recapCompacting: false,
        supervisorChecking: false,
        overlay: null,
        ...cleanup,
      })
    } else if (e.kind === 'failed') {
      const aborted = e.error?.code === 'AbortError'
      emit({
        status: 'idle',
        pendingUser: null,
        ...clearTransients,
        turnStartedAt: null,
        backendStartedAt: null,
        backendActive: false,
        recapCompacting: false,
        supervisorChecking: false,
        overlay: null,
        turnFailed: !aborted,
        turnFailedStatus: aborted ? null : e.error?.status ?? null,
        turnFailedProviderCode: aborted ? null : e.error?.providerCode ?? null,
      })
    }
  }

  function onAgent(e) {
    if (!e || e.kind === 'dropped') return
    const ev = e.event
    if (!ev || !ev.type) return
    if (ev.type === 'turn.started' && ev.layer === 'backend') {
      emit({ backendActive: true, backendInFlight: 0, backendStartedAt: Date.now(), backendError: false })
    } else if (ev.type === 'turn.finished' && ev.layer === 'backend') {
      emit({ backendActive: false, backendInFlight: 0, backendError: false })
    } else if (ev.type === 'agent.report' && ev.layer === 'backend') {
      if (ev.report?.status === 'completed') emit({ backendSucceededSeq: state.backendSucceededSeq + 1 })
    } else if (ev.type === 'turn.failed' && ev.layer === 'backend') {
      emit({ backendActive: false, backendInFlight: 0, backendError: ev.error?.kind !== 'interrupted' })
    } else if (ev.type === 'tool.call.started' && ev.layer === 'backend') {
      emit({ backendInFlight: state.backendInFlight + 1 })
    } else if (ev.type === 'tool.call.finished' && ev.layer === 'backend') {
      emit({ backendInFlight: Math.max(0, state.backendInFlight - 1) })
    } else if (ev.type === 'recap.compaction') {
      emit({ recapCompacting: ev.phase === 'start' })
    } else if (ev.type === 'supervisor.check') {
      emit({ supervisorChecking: ev.phase === 'start' })
    } else if (ev.type === 'assistant.delta' && ev.layer === 'actor') {
      if (state.status === 'idle') return
      if (state.retracting) {
        emit({ retryText: (state.retryText ?? '') + ev.text, status: 'speaking' })
      } else {
        emit({ streamingText: (state.streamingText ?? '') + ev.text, status: 'speaking' })
      }
    }
  }

  function onSpeech(e) {
    if (!e) return
    if (e.kind === 'dropped') emit({ ...clearTransients })
    else if (e.kind === 'retract') {
      if (state.retracting) return
      emit({ retracting: true, retryText: null, retractKeepLen: null })
    } else if (e.kind === 'retractFloor') {
      if (state.retracting) emit({ retractKeepLen: e.keepLen })
    }
  }

  function onOverlay(e) {
    if (!e) return
    if (e.kind === 'pending') emit({ overlay: e.overlay })
    else if (e.kind === 'resolved') emit({ overlay: null })
  }

  function onTitle(e) {
    if (!e || e.kind !== 'title') return
    const last = state.topics[state.topics.length - 1]
    const topics =
      e.topic !== undefined &&
      (last === undefined || last.anchorIndex !== e.topic.anchorIndex || last.title !== e.topic.title)
        ? [...state.topics, e.topic]
        : state.topics
    emit({ title: e.title, titleAnimate: true, topics })
  }

  function onSessionDeleted(e) {
    if (e?.sessionId && e.sessionId === state.sessionId) emit({ ...INITIAL, bootstrapped: true })
  }

  function onWorkspace(e) {
    if (e?.kind !== 'workspace') return
    emit({ backendWorkspace: e.workspace, backendWorkspaceIsDefault: e.isDefault })
  }

  const HANDLERS = {
    reset: onReset,
    record: onRecord,
    turn: onTurn,
    agent: onAgent,
    speech: onSpeech,
    overlay: onOverlay,
    title: onTitle,
    sessionDeleted: onSessionDeleted,
    workspace: onWorkspace,
  }

  return {
    /** 折叠一个事件；返回是否被识别 */
    apply(channel, payload) {
      const h = HANDLERS[channel]
      if (!h) return false
      h(payload)
      return true
    },
    /** 直接替换状态（服务端首帧同步、乐观回显用） */
    patch(p) {
      emit(p)
    },
    replace(next) {
      state = { ...INITIAL, ...next }
      if (onChange) onChange(state)
    },
    getState() {
      return state
    },
  }
}
