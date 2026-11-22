import { api } from "./api.js";
import { renderAddModal, resetAddModalState } from "./components/add-modal.js";
import { renderAgentDrawer } from "./components/agent-drawer.js";
import { renderDispatchModal } from "./components/dispatch-modal.js";
import { setState, store, subscribe } from "./state.js";
import { showToast } from "./utils.js";
import { renderAgentsView } from "./views/agents.js";
import { renderHomeView } from "./views/home.js";
import { renderSettingsView } from "./views/settings.js";
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

let pollSeq = 0;
let pollingStarted = false;
let lastRenderedModalKey = "";
let lastRenderedDrawerAgent = null;

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
    else if (store.activeTab === "settings") void renderSettingsView(mainEl);
  }

  if (store.selectedAgentId !== lastRenderedDrawerAgent || !drawerRoot.contains(document.activeElement)) {
    lastRenderedDrawerAgent = store.selectedAgentId;
    renderAgentDrawer(drawerRoot, refreshState);
  }

  const nextModalKey = store.showAddModal
    ? `add:${store.showAddModal}`
    : store.showDispatchModal
      ? `dispatch:${store.dispatchContextId}:${(store.dispatchPreselect || []).join(",")}`
      : "";
  if (!nextModalKey) {
    lastRenderedModalKey = "";
    modalRoot.innerHTML = "";
  } else if (nextModalKey !== lastRenderedModalKey) {
    lastRenderedModalKey = nextModalKey;
    if (store.showAddModal) renderAddModal(modalRoot, refreshState);
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
  const [tplRes] = await Promise.all([api.templates().catch(() => ({ templates: [] })), refreshState()]);
  setState({ templates: tplRes.templates || [] });
  void startLongPollLoop();
}

document.querySelectorAll(".nav-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    setState({ activeTab: btn.getAttribute("data-tab") });
  });
});

document.getElementById("btn-open-add")?.addEventListener("click", () => {
  resetAddModalState("agent");
  setState({ showAddModal: "agent", showDispatchModal: false });
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
