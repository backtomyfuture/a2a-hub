import { api } from "../api.js";
import { setState, store } from "../state.js";
import { bindBackdropClose, copyText, escapeHtml, showToast } from "../utils.js";

let remoteCliCommand = "";

export function resetAddWorkerModalState() {
  remoteCliCommand = "";
}

export function renderAddWorkerModal(root, refreshFn) {
  const deviceId = store.showAddWorkerDeviceId;
  if (!deviceId) {
    root.innerHTML = "";
    return;
  }

  const device = (store.state?.devices || []).find((d) => d.id === deviceId);
  const presets = store.workerPresets || [];
  const isLocal = Boolean(device?.is_local);

  root.innerHTML = `
    <div class="modal-backdrop" data-worker-modal-backdrop>
      <div class="modal-card">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <h2 style="margin:0;font-size:18px">为「${escapeHtml(device?.name || deviceId)}」添加 Worker</h2>
            <div class="muted" style="font-size:12px">
              ${isLocal ? "本机设备：保存后立即写入 workers.json 并上线为可调度卡片。" : "远端电脑：安全边界禁止远程写执行命令，将为你生成一条本地命令行指令。"}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" id="worker-modal-close">关闭</button>
        </div>

        ${
          remoteCliCommand
            ? `
          <div class="stack-md">
            <div class="pill pill-primary">远端电脑安全接入命令已生成</div>
            <div class="muted" style="font-size:12px">请到「${escapeHtml(device?.name || deviceId)}」终端执行下面命令，该电脑的守护进程会自动检测并同步上线：</div>
            <div class="code-box">${escapeHtml(remoteCliCommand)}</div>
            <div class="row-between">
              <button type="button" class="btn btn-primary" id="btn-copy-worker-cli">复制命令</button>
              <button type="button" class="btn btn-secondary" id="btn-close-worker-cli">完成</button>
            </div>
          </div>
        `
            : `
          <form id="form-add-worker" class="stack-md">
            <label class="field">
              <span>预设模板（可选，选择后自动填充命令）</span>
              <select id="select-worker-preset">
                <option value="">自定义命令 / 脚本（自行填写执行指令）</option>
                ${presets
                  .map(
                    (p) => `
                  <option value="${escapeHtml(p.key)}">
                    ${escapeHtml(p.name)}${p.installed ? "（本机已检测到）" : ""}
                  </option>
                `
                  )
                  .join("")}
              </select>
            </label>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <label class="field">
                <span>Worker 显示名称 *</span>
                <input type="text" name="name" placeholder="例如：前端专用 Claude / 构建脚本" required />
              </label>
              <label class="field">
                <span>Worker Key（英文标识）*</span>
                <input type="text" name="key" placeholder="如 claude-web（同设备下唯一）" required />
              </label>
            </div>

            <label class="field">
              <span>可执行命令模板 *（可用 {prompt} / {prompt_file} / {model_args} 占位符）</span>
              <input type="text" name="command" placeholder="例如：claude -p --dangerously-skip-permissions {model_args} {prompt}" required />
            </label>

            <label class="field">
              <span>能力定位（正面显示在卡片上）</span>
              <textarea name="summary" rows="2" placeholder="说明该 Worker 负责的项目、目录或特长..."></textarea>
            </label>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <label class="field">
                <span>工作目录 cwd</span>
                <input type="text" name="cwd" value="~" placeholder="/Users/.../repo" />
              </label>
              <label class="field">
                <span>续接会话命令模板（可选）</span>
                <input type="text" name="resume_command" placeholder="含 {session} 占位符" />
              </label>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
              <label class="field">
                <span>默认模型</span>
                <input type="text" name="default_model" placeholder="可选" />
              </label>
              <label class="field">
                <span>技能标签（逗号分隔）</span>
                <input type="text" name="skills" placeholder="coding, git" />
              </label>
              <label class="field">
                <span>审批策略</span>
                <select name="approval_policy">
                  <option value="never">never (自动执行)</option>
                  <option value="risk">risk (高危确认)</option>
                  <option value="always">always (每次审批)</option>
                </select>
              </label>
            </div>
            <input type="hidden" name="model_flag" value="" />
            <input type="hidden" name="platform" value="cli" />

            <div class="row-between">
              <span class="muted" style="font-size:12px">生成的卡片 ID 形如 <span class="mono">${escapeHtml(deviceId)}--&lt;key&gt;</span></span>
              <button type="submit" class="btn btn-primary">${isLocal ? "保存并立即上线" : "生成挂载命令行"}</button>
            </div>
          </form>
        `
        }
      </div>
    </div>
  `;

  const closeModal = () => {
    remoteCliCommand = "";
    setState({ showAddWorkerDeviceId: null });
  };

  bindBackdropClose(root.querySelector("[data-worker-modal-backdrop]"), closeModal);
  root.querySelector("#worker-modal-close")?.addEventListener("click", closeModal);
  root.querySelector("#btn-close-worker-cli")?.addEventListener("click", closeModal);
  root.querySelector("#btn-copy-worker-cli")?.addEventListener("click", () => {
    copyText(remoteCliCommand, "已复制 Worker 添加命令");
  });

  const formEl = root.querySelector("#form-add-worker");
  if (!formEl) return;

  const presetSel = formEl.querySelector("#select-worker-preset");
  presetSel?.addEventListener("change", () => {
    const p = presets.find((x) => x.key === presetSel.value);
    if (!p) return;
    formEl.querySelector('input[name="name"]').value = p.name || p.key;
    formEl.querySelector('input[name="key"]').value = p.key;
    formEl.querySelector('input[name="command"]').value = p.command || "";
    formEl.querySelector('input[name="resume_command"]').value = p.resume_command || "";
    formEl.querySelector('textarea[name="summary"]').value = p.summary || "";
    formEl.querySelector('input[name="default_model"]').value = p.default_model || "";
    formEl.querySelector('input[name="skills"]').value = (p.skills || []).join(", ");
    formEl.querySelector('input[name="model_flag"]').value = p.model_flag || "";
    formEl.querySelector('input[name="platform"]').value = p.platform || "cli";
  });

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api.addDeviceWorker(deviceId, {
        key: String(fd.get("key") || "").trim(),
        name: String(fd.get("name") || "").trim(),
        command: String(fd.get("command") || "").trim(),
        resume_command: String(fd.get("resume_command") || "").trim(),
        cwd: String(fd.get("cwd") || "").trim() || "~",
        summary: String(fd.get("summary") || "").trim(),
        default_model: String(fd.get("default_model") || "").trim(),
        model_flag: String(fd.get("model_flag") || "").trim(),
        platform: String(fd.get("platform") || "cli").trim(),
        skills: String(fd.get("skills") || ""),
        approval_policy: String(fd.get("approval_policy") || "never"),
      });
      if (res.local) {
        showToast("Worker 已保存到本机并立即上线");
        closeModal();
        await refreshFn();
      } else {
        remoteCliCommand = res.cli_command || "";
        renderAddWorkerModal(root, refreshFn);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
