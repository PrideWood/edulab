import type { LocalBackupReference } from "@/lib/local-backup-export";

// Select across pages, then keep each request bounded. A large class exports as
// several complete participant archives, never by truncating a person's record.
export async function downloadLocalBackupBatches(records: LocalBackupReference[], options: {
  request: (records: LocalBackupReference[]) => Promise<Response>;
  save: (blob: Blob, filename: string) => void | Promise<void>;
  progress?: (count: number, files: number) => void;
}) {
  const normalized = records.map(row => ({ deviceId: row.deviceId.toLowerCase(), participantId: row.participantId.toLowerCase() }));
  const unique = [...new Map(normalized.map(row => [`${row.deviceId}:${row.participantId}`, row])).values()];
  const numbered = unique.map((row, index) => ({ ...row, exportIndex: index + 1 }));
  let count = 0, files = 0;
  async function batch(group: LocalBackupReference[]): Promise<void> {
    const response = await options.request(group);
    if (response.status === 413 && group.length > 1) {
      const middle = Math.ceil(group.length / 2);
      await batch(group.slice(0, middle)); await batch(group.slice(middle));
      return;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(response.status === 413 && group.length === 1
        ? "单条交互记录超过当前下载限制，请单独联系研究者处理。"
        : error?.error?.message ?? "导出失败，请稍后重试。");
    }
    if (!response.headers.get("Content-Type")?.includes("application/zip") || Number(response.headers.get("X-EduLab-Export-Count")) !== group.length) {
      throw new Error("导出结果或人数确认不一致，请重试；未下载无效文件。");
    }
    const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `EduLab_local_interactions_${files + 1}.zip`;
    await options.save(await response.blob(), filename);
    count += group.length; files += 1; options.progress?.(count, files);
  }
  try {
    for (let offset = 0; offset < numbered.length; offset += 500) await batch(numbered.slice(offset, offset + 500));
    return { count, files };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("导出失败。"), { completedCount: count, completedFiles: files });
  }
}
