import { api } from "./api.js";
import { renderAddModal, resetAddModalState } from "./components/add-modal.js";
import { renderAddWorkerModal } from "./components/add-worker-modal.js";
import { renderAgentDrawer } from "./components/agent-drawer.js";
import { renderDispatchModal } from "./components/dispatch-modal.js";
import { renderSettingsDrawer } from "./components/settings-drawer.js";
import { setState, store, subscribe } from "./state.js";
import { showToast } from "./utils.js";
import { renderAgentsView } from "./views/agents.js";
import { renderHomeView } from "./views/home.js";
import { renderSchedulesView } from "./views/schedules.js";
import { renderThreadsView } from "./views/threads.js";

const mainEl = document.getElementById("main-view");
const drawerRoot = document.getElementById("drawer-root");
const modalRoot = document.getElementById("modal-root");
const loginOverlay = document.getElementById("login-overlay");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const livePill = document.getElementById("live-pill");
const logoutBtn = document.getElementById("btn-logout");
const actionBadge = document.getElementById("nav-action-badge");
const themeBtn = document.getElementById("btn-theme-toggle");

function effectiveTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function syncThemeButton() {
  if (!themeBtn) return;
  const dark = effectiveTheme() === "dark";
  themeBtn.textContent = dark ? "☀ 浅色" : "☾ 深色";
}

function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("ah_theme", next);
  } catch {}
  syncThemeButton();
}

syncThemeButton();
themeBtn?.addEventListener("click", toggleTheme);
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", syncThemeButton);

let pollSeq = 0;
let pollingStarted = false;
let lastRenderedModalKey = "";
let lastRenderedDrawerKey = "";

async function refreshState() {
  const data = await api.state();
  pollSeq = Math.max(pollSeq, Number(data.seq || 0));
  const nextThreadDetail =
    store.selectedThreadId && store.activeTab === "threads"
      ? await api.getThread(store.selectedThreadId).then((r) => r.thread).catch(() => null)
      : store.selectedThreadDetail;
  setState({ state: data, selectedThreadDetail: nextThreadDetail });
}

function renderAll() {
  // 导航与角标
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === store.activeTab);
  });

  const actionCount = store.state?.pending_actions?.length || 0;
  actionBadge.textContent = String(actionCount);
  actionBadge.classList.toggle("hidden", actionCount === 0);

  if (store.pollConnected) {
    livePill.innerHTML = `<span class="dot dot-online"></span> 实时同步`;
  } else {
    livePill.innerHTML = `<span class="dot dot-paused"></span> 重连中...`;
  }

  if (!store.state) return;

  // 若用户正在页面内输入框输入回复，暂缓重绘主区域以免丢失草稿；仅在切换 Tab/选中项时立刻渲染
  const activeTag = document.activeElement?.tagName;
  const editingInMain =
    mainEl.contains(document.activeElement) && (activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT");

  if (!editingInMain) {
    if (store.activeTab === "home") renderHomeView(mainEl, refreshState);
    else if (store.activeTab === "agents") renderAgentsView(mainEl, refreshState);
    else if (store.activeTab === "threads") renderThreadsView(mainEl, refreshState);
    else if (store.activeTab === "schedules") renderSchedulesView(mainEl, refreshState);
  }

  const nextDrawerKey = store.showSettingsDrawer
    ? "settings"
    : store.selectedAgentId
      ? `agent:${store.selectedAgentId}`
      : "";
  if (!nextDrawerKey) {
    lastRenderedDrawerKey = "";
    drawerRoot.innerHTML = "";
  } else if (nextDrawerKey !== lastRenderedDrawerKey || !drawerRoot.contains(document.activeElement)) {
    lastRenderedDrawerKey = nextDrawerKey;
    if (store.showSettingsDrawer) renderSettingsDrawer(drawerRoot);
    else renderAgentDrawer(drawerRoot, refreshState);
  }

  const nextModalKey = store.showAddModal
    ? `add:${store.showAddModal}`
    : store.showAddWorkerDeviceId
      ? `worker:${store.showAddWorkerDeviceId}`
      : store.showDispatchModal
        ? `dispatch:${store.dispatchContextId}:${(store.dispatchPreselect || []).join(",")}`
        : "";
  if (!nextModalKey) {
    lastRenderedModalKey = "";
    modalRoot.innerHTML = "";
  } else if (nextModalKey !== lastRenderedModalKey) {
    lastRenderedModalKey = nextModalKey;
    if (store.showAddModal) renderAddModal(modalRoot, refreshState);
    else if (store.showAddWorkerDeviceId) renderAddWorkerModal(modalRoot, refreshState);
    else if (store.showDispatchModal) renderDispatchModal(modalRoot, refreshState);
  }
}

subscribe(renderAll);

async function startLongPollLoop() {
  if (pollingStarted) return;
  pollingStarted = true;
  while (true) {
    try {
      const res = await api.poll(pollSeq, 30);
      if (!store.pollConnected) setState({ pollConnected: true });
      if (res?.woke || Number(res?.seq || 0) > pollSeq) {
        pollSeq = Number(res.seq || pollSeq);
        await refreshState();
      }
    } catch (err) {
      if (err?.status === 401) {
        loginOverlay.classList.remove("hidden");
        pollingStarted = false;
        return;
      }
      setState({ pollConnected: false });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function bootApp() {
  const qs = new URLSearchParams(location.search);
  const deepThread = qs.get("thread");
  if (deepThread) {
    store.activeTab = "threads";
    store.selectedThreadId = deepThread;
  }

  const sess = await api.session();
  setState({ session: sess });
  logoutBtn.classList.toggle("hidden", !sess.auth_required || !sess.authenticated);

  if (sess.auth_required && !sess.authenticated) {
    loginOverlay.classList.remove("hidden");
    return;
  }

  loginOverlay.classList.add("hidden");
  const [tplRes, presetRes] = await Promise.all([
    api.templates().catch(() => ({ templates: [] })),
    api.workerPresets().catch(() => ({ presets: [] })),
    refreshState(),
  ]);
  setState({
    templates: tplRes.templates || [],
    workerPresets: presetRes.presets || [],
  });
  void startLongPollLoop();
}

document.querySelectorAll(".nav-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    setState({ activeTab: btn.getAttribute("data-tab") });
  });
});

document.getElementById("btn-open-settings")?.addEventListener("click", () => {
  setState({ showSettingsDrawer: true, selectedAgentId: null });
});

document.getElementById("btn-open-add")?.addEventListener("click", () => {
  resetAddModalState("agent");
  setState({ showAddModal: "agent", showDispatchModal: false, showSettingsDrawer: false });
});

document.getElementById("btn-open-dispatch")?.addEventListener("click", () => {
  setState({ showDispatchModal: true, showAddModal: null, dispatchPreselect: [], dispatchContextId: "" });
});

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  const token = document.getElementById("login-token-input")?.value?.trim();
  try {
    await api.login(token);
    await bootApp();
    showToast("登录成功");
  } catch (err) {
    loginError.textContent = err.message || "登录失败";
    loginError.classList.remove("hidden");
  }
});

logoutBtn?.addEventListener("click", async () => {
  await api.logout().catch(() => {});
  pollingStarted = false;
  setState({ state: null });
  await bootApp();
});

void bootApp();
