const listeners = new Set();

export const store = {
  session: { authenticated: false, auth_required: false },
  state: null,
  templates: [],
  workerPresets: [],
  activeTab: "home",
  homeTaskFilter: "all",
  agentFilter: "all",
  agentSearch: "",
  collapsedDeviceIds: [],
  focusDeviceId: "",
  scheduleFilter: "all",
  scheduleSearch: "",
  selectedAgentId: null,
  showSettingsDrawer: false,
  selectedThreadId: null,
  selectedThreadDetail: null,
  threadFilter: "all",
  threadSearch: "",
  threadPage: 1,
  threadTaskVisible: {},
  showAddModal: null, // null | 'agent' | 'device'
  showAddWorkerDeviceId: null,
  showDispatchModal: false,
  dispatchPreselect: [],
  dispatchContextId: "",
  pollConnected: true,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(patch) {
  Object.assign(store, patch);
  for (const fn of listeners) fn(store);
}

export function getAgentById(id) {
  return (store.state?.agents || []).find((a) => a.id === id) || null;
}
