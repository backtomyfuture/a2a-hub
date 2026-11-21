// Tasks.Metadata 上的 usage / acceptance 合并写。写失败只记日志，不影响已经落下的回执。
import { acceptanceIndex } from "./acceptance.mjs";
import { f1 } from "./bus/tables.mjs";
import { log, readTaskMeta } from "./kernel-util.mjs";
import { addUsage } from "./receipt.mjs";

export const metadataMethods = {

  // 先读后合并。写失败只记日志：回执已经落在 Tasks 状态上，不能因为用量或验收索引再失败一次。
  async mergeTaskMeta(task, label, mutate) {
    try {
      const fresh = await this.bus.getRecord(this.T.tasks, task.record_id);
      if (!fresh) return;
      const read = readTaskMeta(f1(fresh, "Metadata"));
      if (!read.ok) {
        log(`Tasks.Metadata 无法合并，跳过 ${label}（不影响回执）`);
        return;
      }
      mutate(read.meta);
      await this.bus.updateRecord(this.T.tasks, fresh.record_id, {
        Metadata: JSON.stringify(read.meta),
      });
    } catch (e) {
      log(`Tasks.Metadata.${label} 写失败（不影响回执）：` + (e?.message ?? e));
    }
  },

  async applyUsage(task, report) {
    await this.mergeTaskMeta(task, "usage", (meta) => {
      meta.usage = addUsage(meta.usage, report ?? null);
    });
  },

  // 补交 outbox 时不能把同一轮用量再加一次，所以标记先落盘再写总线。
  async noteUsageOnce(task, box) {
    if (!box || box.usage_noted) return;
    box.usage_noted = true;
    try { this.saveOutbox(box); }
    catch (e) { log("usage 标记写失败：" + (e?.message ?? e)); }
    await this.applyUsage(task, box.usage ?? null);
  },

  async applyAcceptance(task, acc, msgId = "") {
    const idx = acceptanceIndex(acc, msgId);
    if (!idx) return;
    await this.mergeTaskMeta(task, "acceptance", (meta) => {
      meta.acceptance = idx;
    });
  },

  // 索引写失败不影响 DataPart（权威记录）。先落标记再写总线，避免补交时重复打扰表。
  async noteAcceptanceOnce(task, box) {
    if (!box || box.acceptance_noted || !box.acceptance) return;
    box.acceptance_noted = true;
    try { this.saveOutbox(box); }
    catch (e) { log("acceptance 标记写失败：" + (e?.message ?? e)); }
    await this.applyAcceptance(task, box.acceptance, box.msgId || "");
  },
};
